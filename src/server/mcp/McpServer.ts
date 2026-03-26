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
import { waitForJobsHandler, waitForJobsSchema, activeWaits, abortAgentWait } from './tools/waitForJobs.js';
import { writeNoteHandler, writeNoteSchema, readNoteHandler, readNoteSchema, listNotesHandler, listNotesSchema } from './tools/notes.js';
import { watchNotesHandler, watchNotesSchema } from './tools/watchNotes.js';
import { searchKBHandler, searchKBSchema } from './tools/knowledgeBase.js';
import { reportLearningsHandler, reportLearningsSchema } from './tools/reportLearnings.js';
import { finishJobHandler, finishJobSchema } from './tools/finishJob.js';
import { createWorktreeHandler, createWorktreeSchema } from './tools/createWorktree.js';
import { slackMessageHandler, slackMessageSchema } from './tools/slackMessage.js';

// agentId → { sessionId → transport }
const agentTransports: Map<string, Map<string, StreamableHTTPServerTransport>> = new Map();

/**
 * Agents whose MCP connection dropped while wait_for_jobs was active.
 * agentId → { job_ids they were waiting on, timestamp of disconnect }
 * Consumed by StuckJobWatchdog to restart stuck agents once their deps complete.
 */
export const orphanedWaits = new Map<string, { job_ids: string[]; disconnected_at: number }>();

export function hasActiveTransport(agentId: string): boolean {
  return agentTransports.has(agentId);
}

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

function makeOnClose(agentId: string, transportMap: Map<string, StreamableHTTPServerTransport>, transport: { sessionId?: string }) {
  return () => {
    const sid = transport.sessionId;
    if (sid) transportMap.delete(sid);
    if (transportMap.size === 0) agentTransports.delete(agentId);

    const waitingOn = activeWaits.get(agentId);
    if (waitingOn && waitingOn.length > 0) {
      console.warn(`[mcp] session closed while wait_for_jobs active: agent ${agentId} waiting on [${waitingOn.join(', ')}] — aborting loop, registering orphaned wait`);
      abortAgentWait(agentId);
      orphanedWaits.set(agentId, { job_ids: [...waitingOn], disconnected_at: Date.now() });
    } else {
      console.log(`[mcp] session closed: agent ${agentId}`);
    }
  };
}

export function createMcpApp(): express.Application {
  const app = express();
  app.use(express.json());

  // POST — handles initialization + tool calls from agents
  app.post('/mcp/:agentId', async (req, res) => {
    try {
      const { agentId } = req.params;

      // MCP SDK 1.26+ requires Accept header to include both application/json and
      // text/event-stream. rmcp (Codex's Rust MCP client) only sends application/json,
      // so normalize the header here to avoid 406 responses.
      //
      // IMPORTANT: The MCP SDK uses Hono's getRequestListener which reads req.rawHeaders
      // (the raw socket header array), NOT req.headers. Both must be updated.
      const accept = req.headers['accept'] ?? '';
      if (!accept.includes('text/event-stream')) {
        const newAccept = accept ? `${accept}, text/event-stream` : 'application/json, text/event-stream';
        req.headers['accept'] = newAccept;
        // Also patch rawHeaders — Hono reads rawHeaders when converting Node.js req
        // to a Web Standard Request, so req.headers changes alone are ignored.
        const ri = req.rawHeaders.findIndex((h, i) => i % 2 === 0 && h.toLowerCase() === 'accept');
        if (ri >= 0) {
          req.rawHeaders[ri + 1] = newAccept;
        } else {
          req.rawHeaders.push('Accept', newAccept);
        }
      }

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
        // Clear any orphaned wait — agent has reconnected
        orphanedWaits.delete(agentId);
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (sid) => {
            transportMap!.set(sid, transport!);
          },
        });

        transport.onclose = makeOnClose(agentId, transportMap!, transport!);

        const server = buildMcpServer(agentId);
        await server.connect(transport);
      } else if (isInitializeRequest(req.body)) {
        // Re-initialization with a stale session ID (e.g. after server restart) — create fresh session
        console.log(`[mcp] re-initialize: agent ${agentId} (stale session)`);
        // Clear any orphaned wait — agent has reconnected
        orphanedWaits.delete(agentId);
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (sid) => {
            transportMap!.set(sid, transport!);
          },
        });

        transport.onclose = makeOnClose(agentId, transportMap!, transport!);

        const server = buildMcpServer(agentId);
        await server.connect(transport);
      } else {
        // Unknown session, non-initialize request (e.g. after server restart).
        // Claude Code and rmcp don't auto-reinitialize, so route to an existing
        // initialized transport for this agent if one exists. If not, return an
        // error — the agent is stuck and needs to be restarted.
        const existingTransport = transportMap.size > 0
          ? transportMap.values().next().value as StreamableHTTPServerTransport
          : undefined;

        if (existingTransport) {
          // Route stale session to existing transport and alias the old ID
          console.warn(`[mcp] session not found: agent ${agentId} session ${sessionId ?? '(none)'} — routing to existing transport`);
          if (sessionId) transportMap.set(sessionId, existingTransport);
          transport = existingTransport;
        } else {
          // No transport at all — return error. Agent needs restart.
          console.warn(`[mcp] session not found: agent ${agentId} session ${sessionId ?? '(none)'} — no active transport, returning error`);
          res.status(200).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found — please re-initialize' }, id: (req.body as any)?.id ?? null });
          return;
        }
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
    'Acquire exclusive locks on files before editing them. BLOCKS until locks are available or timeout_ms elapses. On timeout, returns success=false with timed_out=true — release your own locks then IMMEDIATELY call lock_files again (do not pause to reason first). If a deadlock cycle is detected (success=false, deadlock_detected=true), release ALL your currently held locks with release_files, then retry lock_files for all files you need in a single call. The default timeout (660s) exceeds the default TTL (600s), so with defaults you will always eventually get the lock without timing out.',
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
      template_id: createJobSchema.shape.template_id,
    },
    async (input) => {
      const result = await createJobHandler(agentId, input as any);
      return { content: [{ type: 'text', text: result }] };
    }
  );

  server.tool(
    'create_worktree',
    'Create a git worktree (new branch from main, or checkout of an existing remote branch). Returns { worktree_path, branch }. Pass the worktree_path as work_dir to create_job so the child job runs in that worktree.',
    {
      repo_name: createWorktreeSchema.shape.repo_name,
      branch: createWorktreeSchema.shape.branch,
      from_remote: createWorktreeSchema.shape.from_remote,
    },
    async (input) => {
      const result = await createWorktreeHandler(agentId, input as any);
      return { content: [{ type: 'text', text: result }] };
    }
  );

  server.tool(
    'wait_for_jobs',
    'Block until all specified jobs finish. Returns an array of { job_id, title, status, result_text } for each job. Each call returns after at most ~90s. If any jobs still have non-terminal status (queued/running/assigned), re-call wait_for_jobs with those job IDs until all reach a terminal state (done/failed/cancelled).',
    {
      job_ids: waitForJobsSchema.shape.job_ids,
      timeout_ms: waitForJobsSchema.shape.timeout_ms,
    },
    async (input) => {
      const result = await waitForJobsHandler(agentId, input as any);
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

  server.tool(
    'search_kb',
    'Search the knowledge base for relevant memories, patterns, and past learnings. Use at the start of a task to benefit from previous agent experiences.',
    {
      query: searchKBSchema.shape.query,
      project_id: searchKBSchema.shape.project_id,
    },
    async (input) => {
      const result = await searchKBHandler(agentId, input as any);
      return { content: [{ type: 'text', text: result }] };
    }
  );

  server.tool(
    'report_learnings',
    'Report what you learned during this task — project conventions, build quirks, useful patterns, debugging insights. Call this near the end of your work. Max 5 learnings per call.',
    {
      learnings: reportLearningsSchema.shape.learnings,
    },
    async (input) => {
      const result = await reportLearningsHandler(agentId, input as any);
      return { content: [{ type: 'text', text: result }] };
    }
  );

  server.tool(
    'finish_job',
    'Signal task completion and close this session. Call this when your task prompt explicitly tells you to (automated jobs only). Do NOT call in interactive sessions.',
    {
      result: finishJobSchema.shape.result,
    },
    async (input) => {
      const result = await finishJobHandler(agentId, input as any);
      return { content: [{ type: 'text', text: result }] };
    }
  );

  server.tool(
    'send_slack_message',
    'Send a Slack DM to the user. Use this to notify the user of important events, ask for input outside the orchestrator, or share results. The message must include a short headline and a well-formatted body using Slack Block Kit blocks (sections, headers, dividers, context, mrkdwn fields). Your agent ID is attached automatically.',
    {
      headline: slackMessageSchema.shape.headline,
      blocks: slackMessageSchema.shape.blocks,
    },
    async (input) => {
      const result = await slackMessageHandler(agentId, input as any);
      return { content: [{ type: 'text', text: result }] };
    }
  );

  return server;
}
