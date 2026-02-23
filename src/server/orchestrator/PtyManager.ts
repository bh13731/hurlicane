import { spawn as ptySpawn } from 'node-pty';
import type { IPty } from 'node-pty';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { SYSTEM_PROMPT, HOOK_SETTINGS } from './AgentRunner.js';
import type { Job } from '../../shared/types.js';
import { isCodexModel, codexModelName } from '../../shared/types.js';

const CLAUDE = process.env.CLAUDE_BIN ?? 'claude';
const CODEX = process.env.CODEX_BIN ?? 'codex';
const MCP_PORT = process.env.MCP_PORT ?? '3001';
const SCRIPTS_DIR = path.join(process.cwd(), 'data', 'agent-scripts');
const PTY_LOG_DIR = path.join(process.cwd(), 'data', 'agent-logs');

// agentId → active PTY instance
const _ptys = new Map<string, IPty>();

// Rolling buffer of raw PTY output per agent (capped at 2000 chunks to bound memory)
const _ptyBuffers = new Map<string, string[]>();
const _pendingResizes = new Map<string, { cols: number; rows: number }>();
const PTY_BUFFER_MAX = 2000;

function getPtyLogPath(agentId: string): string {
  return path.join(PTY_LOG_DIR, `${agentId}.pty`);
}

export function getPtyBuffer(agentId: string): string[] {
  // Always prefer disk log — it has the complete, unbounded history.
  // The in-memory buffer is capped at PTY_BUFFER_MAX and loses old data.
  try {
    const logPath = getPtyLogPath(agentId);
    const stat = fs.statSync(logPath);
    const MAX_READ_BYTES = 10 * 1024 * 1024; // 10MB cap for very long sessions

    let content: string;
    if (stat.size > MAX_READ_BYTES) {
      // Read only the tail of the file
      const buf = Buffer.alloc(MAX_READ_BYTES);
      const fd = fs.openSync(logPath, 'r');
      try {
        fs.readSync(fd, buf, 0, MAX_READ_BYTES, stat.size - MAX_READ_BYTES);
      } finally {
        fs.closeSync(fd);
      }
      content = buf.toString('utf8');
      // Skip the first (potentially partial) line
      const firstNewline = content.indexOf('\n');
      if (firstNewline >= 0) content = content.slice(firstNewline + 1);
    } else {
      content = fs.readFileSync(logPath, 'utf8');
    }

    const lines = content.split('\n').filter(Boolean);
    if (lines.length > 0) {
      return lines.map(line => JSON.parse(line) as string);
    }
  } catch { /* disk log not available */ }

  // Fall back to in-memory buffer
  return _ptyBuffers.get(agentId) ?? [];
}

function sessionName(agentId: string): string {
  return `orchestrator-${agentId}`;
}

function scriptPath(agentId: string): string {
  return path.join(SCRIPTS_DIR, `${agentId}.sh`);
}

function promptPath(agentId: string): string {
  return path.join(SCRIPTS_DIR, `${agentId}-prompt.txt`);
}

export function isTmuxSessionAlive(agentId: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', sessionName(agentId)], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export interface StartInteractiveOptions {
  agentId: string;
  job: Job;
  cols?: number;
  rows?: number;
}

export function startInteractiveAgent({ agentId, job, cols = 220, rows = 50 }: StartInteractiveOptions): void {
  const workDir = (job as any).work_dir ?? process.cwd();
  const model: string | null = (job as any).model ?? null;
  const mcpPort = Number(MCP_PORT);

  const mcpConfig = JSON.stringify({
    mcpServers: {
      orchestrator: {
        url: `http://localhost:${mcpPort}/mcp/${agentId}`,
        type: 'http',
      },
    },
  });

  // Write the prompt to a file so the launcher can pass it as a CLI arg without quoting issues
  fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
  const pFile = promptPath(agentId);
  fs.writeFileSync(pFile, buildInteractivePrompt(job), 'utf8');

  // Write a launcher script — receives the prompt as a positional arg (pre-fills input)
  const script = scriptPath(agentId);
  const useCodex = isCodexModel(model);

  let execLine: string;
  if (useCodex) {
    const mcpUrl = `http://localhost:${mcpPort}/mcp/${agentId}`;
    const codexSubModel = codexModelName(model);
    const modelFlag = codexSubModel ? ` -m ${JSON.stringify(codexSubModel)}` : '';
    // Do NOT pass the prompt as a positional arg — that causes Codex to run non-interactively
    // and exit immediately. Instead we paste it into the TUI after it initialises.
    // Note: --skip-git-repo-check is a Claude flag and does NOT exist in Codex.
    execLine = `exec ${JSON.stringify(CODEX)} --dangerously-bypass-approvals-and-sandbox -C ${JSON.stringify(workDir)} -c 'mcp_servers.orchestrator.url="${mcpUrl}"'${modelFlag}`;
  } else {
    execLine = `exec ${JSON.stringify(CLAUDE)} --dangerously-skip-permissions --settings ${JSON.stringify(HOOK_SETTINGS)} --mcp-config ${JSON.stringify(mcpConfig)} --append-system-prompt ${JSON.stringify(SYSTEM_PROMPT)}${model ? ` --model ${JSON.stringify(model)}` : ''} "$(cat ${JSON.stringify(pFile)})"`;
  }

  const scriptLines = [
    '#!/bin/sh',
    `export ORCHESTRATOR_AGENT_ID=${JSON.stringify(agentId)}`,
    `export ORCHESTRATOR_API_URL=${JSON.stringify(`http://localhost:${process.env.PORT ?? 3000}`)}`,
    `unset CLAUDECODE`,
    execLine,
  ].join('\n') + '\n';
  fs.writeFileSync(script, scriptLines, { mode: 0o755 });

  // Clear any previous PTY log so this fresh session starts from a clean slate
  fs.mkdirSync(PTY_LOG_DIR, { recursive: true });
  try { fs.unlinkSync(getPtyLogPath(agentId)); } catch { /* no previous log */ }

  try {
    // Kill any existing session with this name
    try {
      execFileSync('tmux', ['kill-session', '-t', sessionName(agentId)], { stdio: 'pipe' });
    } catch { /* no existing session — fine */ }

    // Create a new detached tmux session running our launcher script
    execFileSync('tmux', [
      'new-session', '-d',
      '-s', sessionName(agentId),
      '-x', String(cols),
      '-y', String(rows),
      script,
    ], { cwd: workDir, stdio: 'pipe' });

    // Enable mouse mode so scroll wheel enters tmux copy mode for history scrolling
    try {
      execFileSync('tmux', ['set-option', '-t', sessionName(agentId), 'mouse', 'on'], { stdio: 'pipe' });
    } catch { /* ignore — older tmux may not support per-session mouse */ }

  } catch (err: any) {
    console.error(`[pty ${agentId}] failed to create tmux session:`, err.message);
    queries.updateAgent(agentId, { status: 'failed', error_message: err.message, finished_at: Date.now() });
    queries.updateJobStatus(job.id, 'failed');
    const updated = queries.getAgentWithJob(agentId);
    if (updated) socket.emitAgentUpdate(updated);
    return;
  }

  queries.updateAgent(agentId, { status: 'starting' });
  const agentWithJob = queries.getAgentWithJob(agentId);
  if (agentWithJob) socket.emitAgentUpdate(agentWithJob);

  // After the TUI has initialised, submit the initial prompt.
  // For Claude: prompt is pre-filled via CLI arg, so just send Enter.
  // For Codex: prompt was NOT passed as CLI arg (that causes non-interactive exit),
  //   so paste it from file into the TUI first, then send Enter.
  setTimeout(async () => {
    try {
      if (isTmuxSessionAlive(agentId)) {
        if (useCodex) {
          try {
            execFileSync('tmux', ['load-buffer', '-b', `agent-${agentId}`, pFile], { stdio: 'pipe' });
            execFileSync('tmux', ['paste-buffer', '-b', `agent-${agentId}`, '-t', sessionName(agentId)], { stdio: 'pipe' });
          } catch (err: any) {
            console.warn(`[pty ${agentId}] failed to paste codex prompt:`, err.message);
          }
          // paste-buffer returns before tmux finishes feeding content into the terminal;
          // give it a moment to settle so Enter arrives after the full paste is processed.
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        try {
          execFileSync('tmux', ['send-keys', '-t', sessionName(agentId), 'Enter'], { stdio: 'pipe' });
        } catch (err: any) {
          console.warn(`[pty ${agentId}] failed to send Enter:`, err.message);
        }
      }

      queries.updateAgent(agentId, { status: 'running' });
      const updated = queries.getAgentWithJob(agentId);
      if (updated) socket.emitAgentUpdate(updated);

      // Attach node-pty to the tmux session
      attachPty(agentId, job, cols, rows);
    } catch (err: any) {
      console.error(`[pty ${agentId}] error in post-start setup:`, err.message);
      queries.updateAgent(agentId, { status: 'failed', error_message: err.message, finished_at: Date.now() });
      queries.updateJobStatus(job.id, 'failed');
      const updated = queries.getAgentWithJob(agentId);
      if (updated) socket.emitAgentUpdate(updated);
    }
  }, 4000);
}

export function attachPty(agentId: string, job: Job, cols = 220, rows = 50): void {
  if (_ptys.has(agentId)) return; // already attached

  // Use dimensions from client resize if received before PTY was attached
  const pendingSize = _pendingResizes.get(agentId);
  if (pendingSize) {
    cols = pendingSize.cols;
    rows = pendingSize.rows;
    _pendingResizes.delete(agentId);
  }

  if (!isTmuxSessionAlive(agentId)) {
    console.warn(`[pty ${agentId}] tmux session not alive, cannot attach`);
    queries.updateAgent(agentId, { status: 'done', finished_at: Date.now() });
    queries.updateJobStatus(job.id, 'done');
    const updated = queries.getAgentWithJob(agentId);
    if (updated) socket.emitAgentUpdate(updated);
    return;
  }

  let ptyInstance: IPty;
  try {
    ptyInstance = ptySpawn('tmux', ['attach-session', '-t', sessionName(agentId)], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: (job as any).work_dir ?? process.cwd(),
      env: (() => {
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) {
          if (v !== undefined) env[k] = v;
        }
        delete env['CLAUDECODE'];
        return env;
      })(),
    });
  } catch (err: any) {
    console.error(`[pty ${agentId}] failed to spawn PTY:`, err.message);
    queries.updateAgent(agentId, { status: 'failed', error_message: err.message, finished_at: Date.now() });
    queries.updateJobStatus(job.id, 'failed');
    const updated = queries.getAgentWithJob(agentId);
    if (updated) socket.emitAgentUpdate(updated);
    return;
  }

  _ptys.set(agentId, ptyInstance);
  if (!_ptyBuffers.has(agentId)) _ptyBuffers.set(agentId, []);
  console.log(`[pty ${agentId}] attached to tmux session`);

  ptyInstance.onData((data) => {
    try {
      const buf = _ptyBuffers.get(agentId);
      if (!buf) return; // already disconnected
      socket.emitPtyData(agentId, data);
      buf.push(data);
      if (buf.length > PTY_BUFFER_MAX) buf.splice(0, buf.length - PTY_BUFFER_MAX);
      // Persist to disk so history survives server restarts and buffer eviction
      try {
        fs.appendFileSync(getPtyLogPath(agentId), JSON.stringify(data) + '\n');
      } catch { /* ignore write errors */ }
    } catch (err) {
      console.error(`[pty ${agentId}] onData error:`, err);
    }
  });

  ptyInstance.onExit(() => {
    try {
      console.log(`[pty ${agentId}] PTY exited`);
      _ptys.delete(agentId);
      socket.emitPtyClosed(agentId);

      if (!isTmuxSessionAlive(agentId)) {
        queries.updateAgent(agentId, { status: 'done', finished_at: Date.now() });
        queries.updateJobStatus(job.id, 'done');
        const updated = queries.getAgentWithJob(agentId);
        if (updated) socket.emitAgentUpdate(updated);
        const updatedJob = queries.getJobById(job.id);
        if (updatedJob) socket.emitJobUpdate(updatedJob);
      }
    } catch (err) {
      console.error(`[pty ${agentId}] onExit error:`, err);
    }
  });
}

export function writeInput(agentId: string, data: string): void {
  const ptyInstance = _ptys.get(agentId);
  if (ptyInstance) ptyInstance.write(data);
}

export function resizePty(agentId: string, cols: number, rows: number): void {
  // Always store the latest size so attachPty can use it if the PTY isn't ready yet
  _pendingResizes.set(agentId, { cols, rows });
  const ptyInstance = _ptys.get(agentId);
  if (ptyInstance) ptyInstance.resize(cols, rows);
}

export function disconnectAgent(agentId: string): void {
  // Delete buffer first so the onData guard prevents writes during teardown
  _ptyBuffers.delete(agentId);
  _pendingResizes.delete(agentId);

  try {
    execFileSync('tmux', ['kill-session', '-t', sessionName(agentId)], { stdio: 'pipe' });
  } catch { /* session may already be gone */ }

  const ptyInstance = _ptys.get(agentId);
  if (ptyInstance) {
    _ptys.delete(agentId);
    try { ptyInstance.kill(); } catch { /* ignore */ }
  }

  // Clean up the launcher script and prompt file
  try { fs.unlinkSync(scriptPath(agentId)); } catch { /* ignore */ }
  try { fs.unlinkSync(promptPath(agentId)); } catch { /* ignore */ }

  socket.emitPtyClosed(agentId);
}

export function disconnectAll(): string[] {
  const ids = Array.from(_ptys.keys());
  for (const agentId of ids) {
    disconnectAgent(agentId);
  }
  return ids;
}

function buildInteractivePrompt(job: Job): string {
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
