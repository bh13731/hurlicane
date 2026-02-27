import * as fs from 'fs';
import * as queries from '../db/queries.js';
import { reattachAgent, getLogPath } from './AgentRunner.js';
import { isTmuxSessionAlive, attachPty } from './PtyManager.js';
import { onJobCompleted as debateOnJobCompleted } from './DebateManager.js';
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
        } else {
          // Interactive or debate-stage → done; other non-interactive → failed (no finish_job called)
          const isDebateStage = !!(job as any).debate_role;
          const finalStatus = (job.is_interactive || isDebateStage) ? 'done' : 'failed';
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
            const doneJob = queries.getJobById(agent.job_id);
            if (doneJob) {
              try { debateOnJobCompleted(doneJob); } catch (err) { console.error(`[recovery] debateOnJobCompleted error for agent ${agent.id}:`, err); }
            }
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
}
