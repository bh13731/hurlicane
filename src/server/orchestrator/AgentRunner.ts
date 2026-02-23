import { spawn, execSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { getFileLockRegistry } from './FileLockRegistry.js';
import { onJobCompleted as debateOnJobCompleted } from './DebateManager.js';
import type { Job, ClaudeStreamEvent, CodexStreamEvent } from '../../shared/types.js';
import { isCodexModel, codexModelName } from '../../shared/types.js';

const CLAUDE = process.env.CLAUDE_BIN ?? 'claude';
const CODEX = process.env.CODEX_BIN ?? 'codex';
const MCP_PORT = process.env.MCP_PORT ?? '3001';
const LOGS_DIR = path.join(process.cwd(), 'data', 'agent-logs');

const HOOK_SCRIPT = path.resolve(process.cwd(), 'scripts/check-lock-hook.mjs');

export const HOOK_SETTINGS = JSON.stringify({
  hooks: {
    PreToolUse: [{
      matcher: "Edit|Write|MultiEdit|NotebookEdit",
      hooks: [{ type: "command", command: `node ${HOOK_SCRIPT}` }]
    }]
  }
});

export const SYSTEM_PROMPT = `You are a Claude Code agent in a multi-agent orchestration system.
Use these MCP tools from the 'orchestrator' server:

FILE LOCKING (required before any edits):
  - lock_files(files, reason): Acquire exclusive locks BEFORE editing or creating files. BLOCKS until
    the locks are available — you will resume automatically once they are free. If it times out
    (success=false, timed_out=true), release any locks you currently hold then retry, or ask_user.
  - release_files(files): Release locks when you are done with those files.
  - check_file_locks(): See what files other agents currently have locked.

COORDINATION:
  - report_status(message): Update your status message in the orchestrator dashboard.
  - ask_user(question): Ask the human a question and WAIT for their answer before continuing.

ORCHESTRATION (spawn and coordinate sub-agents):
  - create_job(description, title?, priority?, work_dir?, max_turns?, model?, depends_on?):
      Create a new job that will be run by another agent. Returns { job_id, title, status }.
      work_dir defaults to your own working directory.
  - wait_for_jobs(job_ids, timeout_ms?):
      Block until all specified jobs finish. Returns each job's status, result_text, and diff.
      Use this after create_job to collect results from sub-agents.

SHARED SCRATCHPAD (coordinate data between agents):
  - write_note(key, value): Write a note visible to all agents. Use namespaced keys like "results/step1".
  - read_note(key): Read a note. Returns { found, key, value, updated_at }.
  - list_notes(prefix?): List note keys, optionally filtered by prefix.
  - watch_notes(keys?, prefix?, until_value?, timeout_ms?):
      Block until notes exist. In keys mode, all listed keys must exist.
      In prefix mode, at least one note under the prefix must exist.
      If until_value is set, matched notes must have that exact value.
      Use this to wait for data from other agents instead of polling read_note.

IMPORTANT RULES:
- Always call lock_files BEFORE modifying any file. It will wait for you automatically.
- Always call release_files as soon as you finish with each file — don't hold locks longer than needed.
- Use report_status regularly to let the human know what you are doing.

ORCHESTRATION PATTERN (for decomposing large tasks):
  1. Call report_status to describe your plan.
  2. Use create_job for each parallel sub-task. Collect the returned job_ids.
  3. Use depends_on to express ordering if some sub-tasks depend on others.
  4. Call wait_for_jobs(job_ids) to block until all sub-tasks complete.
  5. Read result_text and diff from the results to synthesize a final answer.
  6. Optionally use write_note/read_note to pass structured data between agents.`;

export interface RunOptions {
  agentId: string;
  job: Job;
  mcpPort?: number;
  resumeSessionId?: string;
}

// Map of agentId → active tailer cleanup handles
const _tailers = new Map<string, { watcher?: fs.FSWatcher; interval: NodeJS.Timeout }>();

// Agents that were explicitly cancelled — handleAgentExit checks this to avoid overwriting 'cancelled' status
export const cancelledAgents = new Set<string>();

export function getLogPath(agentId: string): string {
  return path.join(LOGS_DIR, `${agentId}.ndjson`);
}

export function getStderrPath(agentId: string): string {
  return path.join(LOGS_DIR, `${agentId}.stderr`);
}

export function runAgent(options: RunOptions): void {
  const { agentId, job } = options;
  const mcpPort = options.mcpPort ?? Number(MCP_PORT);

  fs.mkdirSync(LOGS_DIR, { recursive: true });

  const logPath = getLogPath(agentId);
  const errPath = getStderrPath(agentId);

  // Open file descriptors for the child to write into directly
  const logFd = fs.openSync(logPath, 'w');
  const errFd = fs.openSync(errPath, 'w');

  const workDir = (job as any).work_dir ?? process.cwd();
  const maxTurns = (job as any).max_turns ?? 50;
  const model: string | null = (job as any).model ?? null;
  const useCodex = isCodexModel(model);

  const mcpUrl = `http://localhost:${mcpPort}/mcp/${agentId}`;

  let binary: string;
  let args: string[];

  if (useCodex) {
    const codexSubModel = codexModelName(model);
    const codexArgs = [
      ...(options.resumeSessionId
        ? ['exec', 'resume', options.resumeSessionId]
        : ['exec']),
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '-C', workDir,
      '--skip-git-repo-check',
      '-c', `mcp_servers.orchestrator.url="${mcpUrl}"`,
      ...(codexSubModel ? ['-m', codexSubModel] : []),
    ];
    binary = CODEX;
    args = codexArgs;
  } else {
    const mcpConfig = JSON.stringify({
      mcpServers: {
        orchestrator: {
          url: mcpUrl,
          type: 'http',
        },
      },
    });

    args = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--settings', HOOK_SETTINGS,
      '--mcp-config', mcpConfig,
      '--append-system-prompt', SYSTEM_PROMPT,
      '--max-turns', String(maxTurns),
      ...(model ? ['--model', model] : []),
      ...(options.resumeSessionId ? ['--resume', options.resumeSessionId] : []),
    ];
    binary = CLAUDE;
  }

  console.log(`[agent ${agentId}] spawning ${useCodex ? 'codex' : 'claude'} for job "${job.title}"${model ? ` (model: ${model})` : ''}`);

  const child = spawn(binary, args, {
    cwd: workDir,
    detached: true,            // becomes process group leader — survives server restart
    stdio: ['pipe', logFd, errFd],  // stdout/stderr go to files, not pipes
    env: (() => {
      const env = { ...process.env };
      delete env['CLAUDECODE'];
      env['ORCHESTRATOR_AGENT_ID'] = agentId;
      env['ORCHESTRATOR_API_URL'] = `http://localhost:${process.env.PORT ?? 3000}`;
      return env;
    })(),
  });

  // Parent releases its copies of the file descriptors — child keeps its own
  fs.closeSync(logFd);
  fs.closeSync(errFd);

  // Write prompt to stdin then close (child reads it all before doing anything else)
  child.stdin.write(buildPrompt(job));
  child.stdin.end();

  // Capture the current git HEAD SHA so we can diff after the agent finishes
  try {
    const sha = execSync('git rev-parse HEAD', { cwd: workDir, timeout: 5000 }).toString().trim();
    queries.updateAgent(agentId, { base_sha: sha });
  } catch { /* not a git repo or git not available */ }

  queries.updateAgent(agentId, { pid: child.pid ?? null, status: 'running' });
  const agentWithJob = queries.getAgentWithJob(agentId);
  if (agentWithJob) socket.emitAgentUpdate(agentWithJob);

  // Start tailing the log file; pass the child so we know when it exits
  startTailing(agentId, job, logPath, 0, child);
}

/**
 * Called from recovery.ts when the agent's PID is still alive after a server restart.
 * Re-tails the log file from where we left off.
 */
export function reattachAgent(options: RunOptions): void {
  const { agentId, job } = options;
  const logPath = getLogPath(agentId);
  const agent = queries.getAgentById(agentId);
  // Skip lines we already stored before the restart
  const skipLines = agent ? queries.getAgentLastSeq(agentId) + 1 : 0;

  console.log(`[agent ${agentId}] reattaching (PID ${agent?.pid}, skipping ${skipLines} already-stored lines)`);
  startTailing(agentId, job, logPath, skipLines, null, agent?.pid);
}

function startTailing(
  agentId: string,
  job: Job,
  logPath: string,
  skipLines: number,
  child: ChildProcess | null,
  pid?: number,
): void {
  // Stop any previous tailer for this agent (shouldn't happen, but be safe)
  stopTailing(agentId);

  let seq = skipLines;     // next seq number to assign
  let skipped = 0;         // lines consumed but not stored
  let filePos = 0;         // byte offset read so far
  let lineBuf = '';        // incomplete last line

  function readNewContent(): void {
    let size: number;
    try {
      size = fs.statSync(logPath).size;
    } catch {
      return; // file not created yet
    }
    if (size <= filePos) return;

    let buf: Buffer;
    let bytesRead: number;
    try {
      buf = Buffer.alloc(size - filePos);
      const fd = fs.openSync(logPath, 'r');
      try {
        bytesRead = fs.readSync(fd, buf, 0, buf.length, filePos);
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      console.warn(`[agent ${agentId}] readNewContent error:`, err);
      return;
    }
    filePos += bytesRead;

    lineBuf += buf.toString('utf8');
    const parts = lineBuf.split('\n');
    lineBuf = parts.pop() ?? ''; // keep partial last line for next read

    for (const line of parts) {
      if (!line.trim()) continue;
      if (skipped < skipLines) {
        skipped++;
        continue; // already stored in a previous session
      }
      try {
        const event: ClaudeStreamEvent = JSON.parse(line);
        handleStreamEvent(agentId, event, line, seq++);
      } catch {
        storeOutput(agentId, seq++, 'raw', line);
      }
    }
  }

  // Initial read (catches output written before we set up the watcher)
  readNewContent();

  // Watch for new data; fall back to polling every 2s in case fs.watch misses events
  let watcher: fs.FSWatcher | undefined;
  try {
    let debounce: NodeJS.Timeout | null = null;
    watcher = fs.watch(logPath, { persistent: false }, () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(readNewContent, 50);
    });
  } catch { /* log file may not exist yet; the interval will catch up */ }

  const interval = setInterval(readNewContent, 2000);
  _tailers.set(agentId, { watcher, interval });

  if (child) {
    // Normal spawn: wait for the process to exit via child event
    child.on('close', (code) => {
      setTimeout(() => {
        try {
          readNewContent(); // flush any remaining output
          stopTailing(agentId);
          handleAgentExit(agentId, job, code);
        } catch (err) {
          console.error(`[agent ${agentId}] error in close handler:`, err);
        }
      }, 500);
    });

    child.on('error', (err) => {
      try {
        console.error(`[agent ${agentId}] spawn error:`, err);
        stopTailing(agentId);
        queries.updateAgent(agentId, { status: 'failed', error_message: err.message, finished_at: Date.now() });
        queries.updateJobStatus(job.id, 'failed');
        const updated = queries.getAgentWithJob(agentId);
        if (updated) socket.emitAgentUpdate(updated);
      } catch (innerErr) {
        console.error(`[agent ${agentId}] error in spawn error handler:`, innerErr);
      }
    });
  } else {
    // Reattach mode: poll the PID to detect when the process exits
    const agentPid = pid ?? queries.getAgentById(agentId)?.pid;
    if (!agentPid) return;

    const pidPoll = setInterval(() => {
      try {
        process.kill(agentPid, 0); // no-op signal; throws ESRCH if process is gone
      } catch {
        clearInterval(pidPoll);
        setTimeout(() => {
          try {
            readNewContent();
            stopTailing(agentId);
            // Read exit code from stderr file if available; use 0 if result event was 'success'
            handleAgentExit(agentId, job, null);
          } catch (err) {
            console.error(`[agent ${agentId}] error in reattach exit handler:`, err);
          }
        }, 500);
      }
    }, 3000);
  }
}

function stopTailing(agentId: string): void {
  const t = _tailers.get(agentId);
  if (t) {
    t.watcher?.close();
    clearInterval(t.interval);
    _tailers.delete(agentId);
  }
}

function handleAgentExit(agentId: string, job: Job, exitCode: number | null): void {
  console.log(`[agent ${agentId}] exited (code ${exitCode ?? 'unknown'})`);

  // If the agent was cancelled, the cancel endpoint already updated DB + emitted socket events
  if (cancelledAgents.has(agentId)) {
    cancelledAgents.delete(agentId);
    return;
  }

  // Try to determine success/failure from the last result event in the log
  let statusFromLog: 'done' | 'failed' | null = null;
  let logErrorMsg: string | null = null;
  let costUsd: number | null = null;
  let durationMs: number | null = null;
  let numTurns: number | null = null;
  try {
    const content = fs.readFileSync(getLogPath(agentId), 'utf8');
    const lines = content.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i]);
        // Claude result event
        if (ev.type === 'result') {
          statusFromLog = ev.is_error ? 'failed' : 'done';
          costUsd = ev.total_cost_usd ?? null;
          durationMs = ev.duration_ms ?? null;
          numTurns = ev.num_turns ?? null;
          break;
        }
        // Codex turn events
        if (ev.type === 'turn.completed') {
          statusFromLog = 'done';
          break;
        }
        if (ev.type === 'turn.failed') {
          statusFromLog = 'failed';
          logErrorMsg = ev.error?.message ?? null;
          break;
        }
        // Codex inline error event (captured before turn.failed)
        if (ev.type === 'error' && ev.message && !logErrorMsg) {
          logErrorMsg = ev.message;
        }
      } catch { /* skip */ }
    }
  } catch { /* log file may be gone */ }

  const status = statusFromLog ?? (exitCode === 0 ? 'done' : 'failed');

  // Prefer the error message extracted from the log (meaningful for Codex);
  // fall back to stderr only when the log has no useful message.
  let stderrMsg: string | null = logErrorMsg;
  if (!stderrMsg && status === 'failed') {
    try {
      const lines = fs.readFileSync(getStderrPath(agentId), 'utf8').split('\n').filter(Boolean);
      stderrMsg = lines.slice(-10).join('\n') || null;
    } catch { /* no stderr file */ }
  }

  queries.updateAgent(agentId, {
    status,
    exit_code: exitCode ?? -1,
    error_message: stderrMsg,
    cost_usd: costUsd,
    duration_ms: durationMs,
    num_turns: numTurns,
    finished_at: Date.now(),
  });

  // Capture git diff between base_sha and current HEAD (committed + staged changes)
  const agentRec = queries.getAgentById(agentId);
  const workDir2 = (job as any).work_dir ?? process.cwd();
  if (agentRec?.base_sha) {
    try {
      const committed = execSync(
        `git log --patch --no-color ${agentRec.base_sha}..HEAD`,
        { cwd: workDir2, timeout: 10000 }
      ).toString();
      const uncommitted = execSync(
        'git diff HEAD --no-color',
        { cwd: workDir2, timeout: 10000 }
      ).toString();
      const fullDiff = [committed, uncommitted].filter(s => s.trim()).join('\n');
      if (fullDiff.trim()) {
        queries.updateAgent(agentId, { diff: fullDiff.slice(0, 524288) });
      }
    } catch { /* not a git repo, no changes, or git not available */ }
  }
  queries.updateJobStatus(job.id, status);
  getFileLockRegistry().releaseAll(agentId);

  const updated = queries.getAgentWithJob(agentId);
  if (updated) socket.emitAgentUpdate(updated);
  const updatedJob = queries.getJobById(job.id);
  if (updatedJob) {
    try { socket.emitJobUpdate(updatedJob); } catch (err) { console.error(`[agent ${agentId}] emitJobUpdate error:`, err); }
    // If this job is part of a debate, check if the round is complete
    try { debateOnJobCompleted(updatedJob); } catch (err) { console.error(`[agent ${agentId}] debateOnJobCompleted error:`, err); }
  }
}

function handleStreamEvent(agentId: string, event: ClaudeStreamEvent | CodexStreamEvent, raw: string, seq: number): void {
  storeOutput(agentId, seq, event.type, raw);

  // Claude: capture session_id from system init event
  if (event.type === 'system' && (event as ClaudeStreamEvent).session_id) {
    queries.updateAgent(agentId, { session_id: (event as ClaudeStreamEvent).session_id });
  }

  // Codex: capture thread_id as session_id from thread.started event
  if (event.type === 'thread.started' && (event as CodexStreamEvent).thread_id) {
    queries.updateAgent(agentId, { session_id: (event as CodexStreamEvent).thread_id });
  }

  const latestRow = queries.getLatestAgentOutput(agentId);
  if (latestRow) socket.emitAgentOutput(agentId, latestRow);
}

function storeOutput(agentId: string, seq: number, eventType: string, content: string): void {
  queries.insertAgentOutput({
    agent_id: agentId,
    seq,
    event_type: eventType,
    content,
    created_at: Date.now(),
  });
}

function buildPrompt(job: Job): string {
  const model: string | null = (job as any).model ?? null;
  let prompt = '';

  // Codex has no --append-system-prompt flag, so prepend it to the prompt
  if (isCodexModel(model)) {
    prompt += SYSTEM_PROMPT + '\n\n---\n\n';
  }

  prompt += `# Task: ${job.title}\n\n`;

  const templateId = (job as any).template_id as string | null;
  if (templateId) {
    const template = queries.getTemplateById(templateId);
    if (template) {
      prompt += `## Guidelines\n\n${template.content}\n\n## Task Description\n\n`;
    }
  }

  prompt += job.description;

  if (job.context) {
    try {
      const ctx = JSON.parse(job.context);
      prompt += '\n\n## Additional Context\n';
      for (const [k, v] of Object.entries(ctx)) {
        prompt += `- **${k}**: ${v}\n`;
      }
    } catch { /* ignore */ }
  }
  return prompt;
}
