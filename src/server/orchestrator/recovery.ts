import * as fs from 'fs';
import * as queries from '../db/queries.js';
import { reattachAgent, getLogPath } from './AgentRunner.js';
import { isTmuxSessionAlive, attachPty } from './PtyManager.js';
import type { ClaudeStreamEvent } from '../../shared/types.js';

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
 * Mirrors the logic in AgentRunner.handleAgentExit so a completed agent
 * isn't incorrectly marked failed just because the server restarted.
 */
function statusFromLog(agentId: string): 'done' | 'failed' | null {
  try {
    const content = fs.readFileSync(getLogPath(agentId), 'utf8');
    const lines = content.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i]) as ClaudeStreamEvent;
        if (ev.type === 'result') {
          return ev.is_error ? 'failed' : 'done';
        }
      } catch { /* skip malformed lines */ }
    }
  } catch { /* log file may not exist */ }
  return null;
}

/**
 * On startup, check each previously-running agent:
 *   - PID still alive → re-attach file tailing and keep monitoring it
 *   - PID gone        → read the log to determine done/failed; default to failed
 */
export function runRecovery(): void {
  const staleStatuses = ['starting', 'running', 'waiting_user'] as const;
  let reattached = 0;
  let recovered = 0;
  let failed = 0;

  for (const status of staleStatuses) {
    for (const agent of queries.listBatchAgents(status)) {
      const alive = agent.pid != null && isPidAlive(agent.pid);

      if (alive) {
        console.log(`[recovery] reattaching live agent ${agent.id} (PID ${agent.pid})`);
        const agentWithJob = queries.getAgentWithJob(agent.id);
        if (agentWithJob) {
          reattachAgent({ agentId: agent.id, job: agentWithJob.job });
          reattached++;
        }
      } else {
        const logStatus = statusFromLog(agent.id);
        const finalStatus = logStatus ?? 'failed';

        console.log(
          `[recovery] agent ${agent.id} (${status}) — PID ${agent.pid ?? 'none'} not found, ` +
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

        if (finalStatus === 'done') recovered++;
        else failed++;
      }
    }
  }

  if (reattached > 0) console.log(`[recovery] reattached ${reattached} live agents`);
  if (recovered > 0) console.log(`[recovery] recovered ${recovered} completed agents`);
  if (failed > 0) console.log(`[recovery] failed ${failed} dead agents`);

  // Recovery for interactive agents: reattach if tmux session is still alive
  let interactiveReattached = 0;
  let interactiveFailed = 0;
  for (const agent of queries.listRunningInteractiveAgents()) {
    const agentWithJob = queries.getAgentWithJob(agent.id);
    if (!agentWithJob) continue;

    if (isTmuxSessionAlive(agent.id)) {
      console.log(`[recovery] reattaching interactive agent ${agent.id} (tmux session alive)`);
      attachPty(agent.id, agentWithJob.job);
      interactiveReattached++;
    } else {
      console.log(`[recovery] interactive agent ${agent.id} — tmux session gone, marking done`);
      queries.updateAgent(agent.id, { status: 'done', finished_at: Date.now() });
      queries.updateJobStatus(agent.job_id, 'done');
      queries.releaseLocksForAgent(agent.id);
      interactiveFailed++;
    }
  }
  if (interactiveReattached > 0) console.log(`[recovery] reattached ${interactiveReattached} interactive agents`);
  if (interactiveFailed > 0) console.log(`[recovery] marked ${interactiveFailed} interactive agents done (session gone)`);
}
