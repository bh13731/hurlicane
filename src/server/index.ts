import { createServer } from 'http';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb, closeDb } from './db/database.js';
import { initSocketManager } from './socket/SocketManager.js';
import apiRouter from './api/router.js';
import { createMcpApp } from './mcp/McpServer.js';
import { startWorkQueue, stopWorkQueue } from './orchestrator/WorkQueueManager.js';
import { runRecovery } from './orchestrator/recovery.js';
import { writeInput, resizePty } from './orchestrator/PtyManager.js';
import * as queries from './db/queries.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 3000);
const MCP_PORT = Number(process.env.MCP_PORT ?? 3001);
const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), 'data', 'orchestrator.db');

async function main() {
  // 1. Init database
  initDb(DB_PATH);
  console.log(`[server] DB initialized at ${DB_PATH}`);

  // Populate FTS index for any existing output rows not yet indexed
  queries.rebuildFts();

  // 2. Recovery — mark stale agents as failed, requeue their jobs
  runRecovery();

  // 3. Main Express app
  const app = express();
  app.use(cors());
  app.use(express.json());

  // REST API
  app.use('/api', apiRouter);

  // Serve built client in production
  const clientDist = path.join(__dirname, '../../dist/client');
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });

  // 4. HTTP server + Socket.io
  const httpServer = createServer(app);
  const io = initSocketManager(httpServer);

  // Send snapshot on connect; also respond to explicit re-requests (e.g. after StrictMode remount or HMR)
  io.on('connection', (socket) => {
    const buildSnapshot = () => ({
      jobs: queries.listJobs(),
      agents: queries.getAgentsWithJob(),
      locks: queries.getAllActiveLocks(),
      templates: queries.listTemplates(),
      projects: queries.listProjects(),
      batchTemplates: queries.listBatchTemplates(),
    });

    socket.emit('queue:snapshot', buildSnapshot());

    socket.on('request:snapshot', () => {
      socket.emit('queue:snapshot', buildSnapshot());
    });

    socket.on('pty:input', ({ agent_id, data }) => writeInput(agent_id, data));
    socket.on('pty:resize', ({ agent_id, cols, rows }) => resizePty(agent_id, cols, rows));
  });

  // 5. MCP server on separate port
  const mcpApp = createMcpApp();
  const mcpServer = mcpApp.listen(MCP_PORT, () => {
    console.log(`[server] MCP server listening on :${MCP_PORT}`);
  });

  // 6. Start work queue
  startWorkQueue();

  // 7. Start main server
  httpServer.listen(PORT, () => {
    console.log(`[server] Orchestrator listening on :${PORT}`);
  });

  // 8. Graceful shutdown
  let shuttingDown = false;

  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[server] ${signal} received — shutting down gracefully`);

    // Hard-exit watchdog: if shutdown takes >10s, force it
    const watchdog = setTimeout(() => {
      console.error('[server] Shutdown timed out — forcing exit');
      process.exit(1);
    }, 10_000);
    watchdog.unref(); // don't let this alone keep the process alive

    // Stop dispatching new jobs
    stopWorkQueue();

    // Stop accepting new HTTP connections; wait for in-flight requests to drain
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));

    // Close the MCP server
    await new Promise<void>((resolve) => mcpServer.close(() => resolve()));

    // Disconnect all Socket.io clients
    io.close();

    // Close the database
    closeDb();

    clearTimeout(watchdog);
    console.log('[server] Shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[server] Fatal error:', err);
  process.exit(1);
});
