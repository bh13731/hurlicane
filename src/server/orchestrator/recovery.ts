import * as fs from 'fs';
import { execFileSync } from 'child_process';
import * as queries from '../db/queries.js';
import { reattachAgent, getLogPath } from './AgentRunner.js';
import { isTmuxSessionAlive, attachPty, disconnectAgent } from './PtyManager.js';
import { orphanedWaits } from '../mcp/McpServer.js';
import type { ClaudeStreamEvent } from '../../shared/types.js';
import { isCodexModel } from '../../shared/types.js';

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = no-op, just checks existence
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the agent's log file to determine the actual exit status.
 * Used for legacy stream-json (Codex batch) agents.
 */
function statusFromLog(agentId: string): 'done' | 'failed' | null {
  try {
    const content = fs.readFileSync(getLogPath(agentId), 'utf8');
    const lines = content.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i]);
        // Claude result event
        if (ev.type === 'result') {
          return ev.is_error ? 'failed' : 'done';
        }
        // Codex turn events
        if (ev.type === 'turn.completed') return 'done';
        if (ev.type === 'turn.failed') return 'failed';
      } catch { /* skip malformed lines */ }
    }
  } catch { /* log file may not exist */ }
  return null;
}

/**
 * On startup, check each previously-running agent and recover it:
 *
 * - Codex batch (pid-based, stream-json path):
 *     PID alive → reattach file tailing
 *     PID dead  → read log to determine done/failed, default to failed
 *
 * - All other agents (tmux-based):
 *     tmux alive → reattach PTY
 *     tmux dead  → interactive → mark done; batch → mark failed
 */
export function runRecovery(): void {
  const staleStatuses = ['starting', 'running', 'waiting_user'] as const;
  let codexReattached = 0;
  let codexRecovered = 0;
  let codexFailed = 0;
  let tmuxReattached = 0;
  let tmuxRecovered = 0;
  let tmuxFailed = 0;

  for (const status of staleStatuses) {
    for (const agent of queries.listAllRunningAgents()) {
      if (agent.status !== status) continue;

      const agentWithJob = queries.getAgentWithJob(agent.id);
      if (!agentWithJob) continue;
      const { job } = agentWithJob;

      const isCodexBatch = isCodexModel((job as any).model ?? null) && !job.is_interactive;

      if (isCodexBatch) {
        // Legacy stream-json path: use PID-based recovery
        const alive = agent.pid != null && isPidAlive(agent.pid);

        if (alive) {
          console.log(`[recovery] reattaching live Codex agent ${agent.id} (PID ${agent.pid})`);
          reattachAgent({ agentId: agent.id, job });
          codexReattached++;
        } else {
          const logStatus = statusFromLog(agent.id);
          const finalStatus = logStatus ?? 'failed';

          console.log(
            `[recovery] Codex agent ${agent.id} (${status}) — PID ${agent.pid ?? 'none'} not found, ` +
            `marking ${finalStatus}${logStatus ? ' (from log)' : ' (no result in log)'}`
          );

          queries.updateAgent(agent.id, {
            status: finalStatus,
            error_message: logStatus ? null : 'Agent process not found on restart.',
            finished_at: Date.now(),
          });
          queries.updateJobStatus(agent.job_id, finalStatus);
          queries.releaseLocksForAgent(agent.id);

          const pendingQ = queries.getPendingQuestion(agent.id);
          if (pendingQ) {
            queries.updateQuestion(pendingQ.id, {
              status: 'timeout',
              answer: '[TIMEOUT] Orchestrator restarted.',
              answered_at: Date.now(),
            });
          }

          if (finalStatus === 'done') codexRecovered++;
          else codexFailed++;
        }
      } else {
        // Tmux-based path (all Claude agents, interactive or not)
        if (isTmuxSessionAlive(agent.id)) {
          console.log(`[recovery] reattaching tmux agent ${agent.id} (session alive)`);
          attachPty(agent.id, job);
          tmuxReattached++;

          // If this agent was in the middle of wait_for_jobs when the server restarted,
          // re-register it as an orphaned wait so the watchdog can restart it once its
          // child jobs are all terminal. Set disconnected_at in the past to bypass the
          // 60-second grace period — the server restart already serves as that delay.
          const pendingWaitIds: string | null = (agent as any).pending_wait_ids ?? null;
          if (pendingWaitIds) {
            try {
              const jobIds: string[] = JSON.parse(pendingWaitIds);
              if (Array.isArray(jobIds) && jobIds.length > 0) {
                orphanedWaits.set(agent.id, {
                  job_ids: jobIds,
                  disconnected_at: Date.now() - 61_000, // bypass the 60s grace period
                });
                console.log(`[recovery] agent ${agent.id} was in wait_for_jobs — registered as orphaned wait for [${jobIds.join(', ')}]`);
              }
            } catch { /* malformed JSON — skip */ }
          }
        } else {
          // Interactive → done; other non-interactive → failed (no finish_job called)
          const finalStatus = job.is_interactive ? 'done' : 'failed';
          console.log(`[recovery] tmux agent ${agent.id} — session gone, marking ${finalStatus}`);

          queries.updateAgent(agent.id, {
            status: finalStatus,
            error_message: finalStatus === 'failed' ? 'Agent session not found on restart.' : null,
            finished_at: Date.now(),
          });
          queries.updateJobStatus(agent.job_id, finalStatus);
          queries.releaseLocksForAgent(agent.id);

          const pendingQ = queries.getPendingQuestion(agent.id);
          if (pendingQ) {
            queries.updateQuestion(pendingQ.id, {
              status: 'timeout',
              answer: '[TIMEOUT] Orchestrator restarted.',
              answered_at: Date.now(),
            });
          }

          if (finalStatus === 'done') {
            tmuxRecovered++;
          } else {
            tmuxFailed++;
          }
        }
      }
    }
  }

  if (codexReattached > 0) console.log(`[recovery] reattached ${codexReattached} live Codex agents`);
  if (codexRecovered > 0) console.log(`[recovery] recovered ${codexRecovered} completed Codex agents`);
  if (codexFailed > 0) console.log(`[recovery] failed ${codexFailed} dead Codex agents`);
  if (tmuxReattached > 0) console.log(`[recovery] reattached ${tmuxReattached} tmux agents`);
  if (tmuxRecovered > 0) console.log(`[recovery] recovered ${tmuxRecovered} completed tmux agents`);
  if (tmuxFailed > 0) console.log(`[recovery] failed ${tmuxFailed} dead tmux agents`);

  // Kill any orchestrator tmux sessions whose agent is already in a terminal state
  // (or not in the DB at all). These are orphaned sessions left behind when the cancel
  // endpoint failed to kill the session (e.g. pid=NULL for interactive agents).
  try {
    const raw = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], { stdio: 'pipe' }).toString();
    const terminalStatuses = new Set(['done', 'failed', 'cancelled']);
    let orphansKilled = 0;
    for (const line of raw.split('\n')) {
      const name = line.trim();
      if (!name.startsWith('orchestrator-')) continue;
      const agentId = name.slice('orchestrator-'.length);
      const agent = queries.getAgentById(agentId);
      if (!agent || terminalStatuses.has(agent.status)) {
        disconnectAgent(agentId);
        orphansKilled++;
      }
    }
    if (orphansKilled > 0) console.log(`[recovery] killed ${orphansKilled} orphaned tmux session(s)`);
  } catch { /* tmux not available or no sessions */ }
}
