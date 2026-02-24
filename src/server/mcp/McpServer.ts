import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer as MCP, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { askUserHandler, askUserSchema } from './tools/askUser.js';
import { lockFilesHandler, lockFilesSchema } from './tools/lockFiles.js';
import { releaseFilesHandler, releaseFilesSchema } from './tools/releaseFiles.js';
import { checkFileLocksHandler, checkFileLocksSchema } from './tools/checkFileLocks.js';
import { reportStatusHandler, reportStatusSchema } from './tools/reportStatus.js';
import { createJobHandler, createJobSchema } from './tools/createJob.js';
import { waitForJobsHandler, waitForJobsSchema } from './tools/waitForJobs.js';
import { writeNoteHandler, writeNoteSchema, readNoteHandler, readNoteSchema, listNotesHandler, listNotesSchema } from './tools/notes.js';
import { watchNotesHandler, watchNotesSchema } from './tools/watchNotes.js';

// agentId → { sessionId → transport }
const agentTransports: Map<string, Map<string, StreamableHTTPServerTransport>> = new Map();

/**
 * Close all active MCP transport sessions. Call during shutdown so
 * clients get a clean disconnect instead of hanging on in-flight requests.
 */
export async function closeAllMcpSessions(): Promise<void> {
  const promises: Promise<void>[] = [];
  for (const [, transportMap] of agentTransports) {
    for (const [, transport] of transportMap) {
      promises.push(transport.close().catch(() => {}));
    }
  }
  await Promise.all(promises);
  agentTransports.clear();
}

export function createMcpApp(): express.Application {
  const app = express();
  app.use(express.json());

  // POST — handles initialization + tool calls from agents
  app.post('/mcp/:agentId', async (req, res) => {
    try {
      const { agentId } = req.params;
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      let transportMap = agentTransports.get(agentId);
      if (!transportMap) {
        transportMap = new Map();
        agentTransports.set(agentId, transportMap);
      }

      let transport: StreamableHTTPServerTransport | undefined;

      if (sessionId && transportMap.has(sessionId)) {
        transport = transportMap.get(sessionId)!;
      } else if (!sessionId && isInitializeRequest(req.body)) {
        console.log(`[mcp] new session: agent ${agentId}`);
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transportMap!.set(sid, transport!);
          },
        });

        transport.onclose = () => {
          const sid = transport!.sessionId;
          if (sid) transportMap!.delete(sid);
          if (transportMap!.size === 0) agentTransports.delete(agentId);
          console.log(`[mcp] session closed: agent ${agentId}`);
        };

        const server = buildMcpServer(agentId);
        await server.connect(transport);
      } else if (isInitializeRequest(req.body)) {
        // Re-initialization with a stale session ID (e.g. after server restart) — create fresh session
        console.log(`[mcp] re-initialize: agent ${agentId} (stale session)`);
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transportMap!.set(sid, transport!);
          },
        });

        transport.onclose = () => {
          const sid = transport!.sessionId;
          if (sid) transportMap!.delete(sid);
          if (transportMap!.size === 0) agentTransports.delete(agentId);
          console.log(`[mcp] session closed: agent ${agentId}`);
        };

        const server = buildMcpServer(agentId);
        await server.connect(transport);
      } else {
        // Unknown session, non-initialize request — 404 tells MCP client to re-initialize
        res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found — please re-initialize' }, id: null });
        return;
      }

      await transport!.handleRequest(req, res, req.body);
    } catch (err) {
      console.error(`[mcp] POST error (agent ${req.params.agentId}):`, err);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });

  // GET — SSE streaming channel (server→client notifications)
  app.get('/mcp/:agentId', async (req, res) => {
    try {
      const { agentId } = req.params;
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const transport = sessionId && agentTransports.get(agentId)?.get(sessionId);
      if (!transport) {
        res.status(400).json({ error: 'Invalid or missing session' });
        return;
      }
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error(`[mcp] GET error (agent ${req.params.agentId}):`, err);
      if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    }
  });

  // DELETE — session termination
  app.delete('/mcp/:agentId', async (req, res) => {
    try {
      const { agentId } = req.params;
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const transport = sessionId && agentTransports.get(agentId)?.get(sessionId);
      if (!transport) {
        res.status(400).json({ error: 'Invalid or missing session' });
        return;
      }
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error(`[mcp] DELETE error (agent ${req.params.agentId}):`, err);
      if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    }
  });

  return app;
}

function buildMcpServer(agentId: string): MCP {
  const server = new MCP({ name: 'orchestrator', version: '1.0.0' });

  server.tool(
    'ask_user',
    'Ask the human a question and wait for their answer before continuing.',
    { question: askUserSchema.shape.question, timeout_ms: askUserSchema.shape.timeout_ms },
    async (input) => {
      const answer = await askUserHandler(agentId, input as any);
      return { content: [{ type: 'text', text: answer }] };
    }
  );

  server.tool(
    'lock_files',
    'Acquire exclusive locks on files before editing them. BLOCKS until locks are available or timeout_ms elapses. On timeout, returns success=false with timed_out=true — release your own locks and retry, or ask_user what to do.',
    { files: lockFilesSchema.shape.files, reason: lockFilesSchema.shape.reason, ttl_ms: lockFilesSchema.shape.ttl_ms, timeout_ms: lockFilesSchema.shape.timeout_ms },
    async (input) => {
      const result = await lockFilesHandler(agentId, input as any);
      return { content: [{ type: 'text', text: result }] };
    }
  );

  server.tool(
    'release_files',
    'Release file locks when done editing.',
    { files: releaseFilesSchema.shape.files },
    async (input) => {
      const result = await releaseFilesHandler(agentId, input as any);
      return { content: [{ type: 'text', text: result }] };
    }
  );

  server.tool(
    'check_file_locks',
    'See what files other agents currently have locked.',
    {},
    async (input) => {
      const result = await checkFileLocksHandler(agentId, input as any);
      return { content: [{ type: 'text', text: result }] };
    }
  );

  server.tool(
    'report_status',
    'Update your status message displayed in the orchestrator dashboard.',
    { message: reportStatusSchema.shape.message },
    async (input) => {
      const result = await reportStatusHandler(agentId, input as any);
      return { content: [{ type: 'text', text: result }] };
    }
  );

  server.tool(
    'create_job',
    'Create a new job that will be queued and run by another agent. Returns { job_id, title, status }. Use wait_for_jobs to block until it completes.',
    {
      description: createJobSchema.shape.description,
      title: createJobSchema.shape.title,
      priority: createJobSchema.shape.priority,
      work_dir: createJobSchema.shape.work_dir,
      max_turns: createJobSchema.shape.max_turns,
      model: createJobSchema.shape.model,
      depends_on: createJobSchema.shape.depends_on,
    },
    async (input) => {
      const result = await createJobHandler(agentId, input as any);
      return { content: [{ type: 'text', text: result }] };
    }
  );

  server.tool(
    'wait_for_jobs',
    'Block until all specified jobs reach a terminal state (done/failed/cancelled). Returns an array of { job_id, title, status, result_text, diff } for each job.',
    {
      job_ids: waitForJobsSchema.shape.job_ids,
      timeout_ms: waitForJobsSchema.shape.timeout_ms,
    },
    async (input, extra: any) => {
      // Keepalive: send a periodic MCP notification so the SSE stream has data
      // flowing through it. Without this, Node.js keepAliveTimeout (5 s default)
      // closes the idle SSE connection before the handler returns, silently
      // dropping the tool result and leaving the agent stuck forever.
      const keepalive = async () => {
        await extra.sendNotification({
          method: 'notifications/message',
          params: { level: 'debug', logger: 'orchestrator', data: 'wait_for_jobs: keepalive' },
        });
      };
      const result = await waitForJobsHandler(agentId, input as any, keepalive);
      return { content: [{ type: 'text', text: result }] };
    }
  );

  server.tool(
    'write_note',
    'Write a note to the shared scratchpad (visible to all agents). Use namespaced keys like "plan/step1". Value can be any string; JSON.stringify for structured data.',
    {
      key: writeNoteSchema.shape.key,
      value: writeNoteSchema.shape.value,
    },
    async (input) => {
      const result = await writeNoteHandler(agentId, input as any);
      return { content: [{ type: 'text', text: result }] };
    }
  );

  server.tool(
    'read_note',
    'Read a note from the shared scratchpad. Returns { found, key, value, updated_at }.',
    { key: readNoteSchema.shape.key },
    async (input) => {
      const result = await readNoteHandler(agentId, input as any);
      return { content: [{ type: 'text', text: result }] };
    }
  );

  server.tool(
    'list_notes',
    'List all note keys in the shared scratchpad. Optionally filter by prefix (e.g. "plan/").',
    { prefix: listNotesSchema.shape.prefix },
    async (input) => {
      const result = await listNotesHandler(agentId, input as any);
      return { content: [{ type: 'text', text: result }] };
    }
  );

  server.tool(
    'watch_notes',
    'Block until specified notes exist (and optionally match a value). Use to wait for data from other agents.',
    {
      keys: watchNotesSchema.shape.keys,
      prefix: watchNotesSchema.shape.prefix,
      until_value: watchNotesSchema.shape.until_value,
      timeout_ms: watchNotesSchema.shape.timeout_ms,
    },
    async (input) => {
      const result = await watchNotesHandler(agentId, input as any);
      return { content: [{ type: 'text', text: result }] };
    }
  );

  return server;
}
