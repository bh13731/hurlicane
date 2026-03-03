import { loadConfig } from './config.js';
import { createOrchestratorClient } from './orchestrator.js';
import { createApp } from './server.js';

const config = loadConfig();
const client = createOrchestratorClient(config.orchestratorUrl);
const app = createApp(config, client);

const server = app.listen(config.port, () => {
  console.log(`[eye] listening on :${config.port}`);
  console.log(`[eye] author: ${config.author}`);
  console.log(`[eye] orchestrator: ${config.orchestratorUrl}`);
});

function shutdown() {
  console.log('\n[eye] shutting down...');
  server.close(() => process.exit(0));
  // Force exit after 5s
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
