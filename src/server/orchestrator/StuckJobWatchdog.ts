/**
 * StuckJobWatchdog — periodic runtime monitor for stuck/inconsistent agent state.
 *
 * Runs every 30 seconds and handles two failure modes:
 *
 * 1. Dead PIDs: an agent's process has died but the DB still shows it as
 *    running. This can happen if the server's child close-event doesn't fire
 *    (rare edge case) or for reattached agents whose poll interval has a bug.
 *    Action: same recovery as startup recovery.ts — read log to determine
 *    done/failed, update DB, release locks.
 *
 * 2. Job/agent inconsistency: a job is marked 'failed' (e.g. by recovery at
 *    restart) but an agent row is still in 'running' state. The old process
 *    from the previous server run is gone; the stale row just needs cleanup.
 *    Action: mark agent failed, emit socket update.
 */

import * as fs from 'fs';
import { randomUUID } from 'crypto';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { runAgent, getLogPath } from './AgentRunner.js';
import { getFileLockRegistry } from './FileLockRegistry.js';
import { isTmuxSessionAlive } from './PtyManager.js';

const WATCHDOG_INTERVAL_MS = 30_000;

let _timer: NodeJS.Timeout | null = null;

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function statusFromLog(agentId: string): 'done' | 'failed' | null {
  try {
    const content = fs.readFileSync(getLogPath(agentId), 'utf8');
    const lines = content.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i]);
        if (ev.type === 'result') return ev.is_error ? 'failed' : 'done';
        if (ev.type === 'turn.completed') return 'done';
        if (ev.type === 'turn.failed') return 'failed';
      } catch { /* skip */ }
    }
  } catch { /* log file may not exist */ }
  return null;
}

function killProcess(pid: number): void {
  try { process.kill(-pid, 'SIGTERM'); } catch { /* not a process group leader */ }
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
}

/**
 * Scan the agent's last output events to find a wait_for_jobs tool call.
 * Returns the job_ids it was waiting on, or null if not found.
 */
function findLastWaitForJobsIds(agentId: string): string[] | null {
  const output = queries.getAgentOutput(agentId);
  for (let i = output.length - 1; i >= 0; i--) {
    if (output[i].event_type !== 'assistant') continue;
    try {
      const ev = JSON.parse(output[i].content);
      if (ev.type !== 'assistant' || !Array.isArray(ev.message?.content)) continue;
      for (const block of ev.message.content) {
        if (
          block.type === 'tool_use' &&
          (block.name === 'mcp__orchestrator__wait_for_jobs' || block.name === 'wait_for_jobs') &&
          Array.isArray(block.input?.job_ids)
        ) {
          return block.input.job_ids as string[];
        }
      }
      break; // checked last assistant message, no wait_for_jobs
    } catch { /* skip */ }
  }
  return null;
}

function check(): void {
  const TERMINAL = ['done', 'failed', 'cancelled'];

  // ── Check 1: Dead PIDs ──────────────────────────────────────────────────────
  // Find agents still marked running/starting whose process has died.
  for (const status of ['starting', 'running', 'waiting_user'] as const) {
    for (const agent of queries.listBatchAgents(status)) {
      if (agent.pid != null && isPidAlive(agent.pid)) continue;

      // PID is dead (or was never set). Determine final status from log.
      const logStatus = statusFromLog(agent.id);

      // Before marking failed, check if agent was stuck in wait_for_jobs
      // with all deps done — if so, auto-resume instead of failing.
      if (!logStatus || logStatus === 'failed') {
        const waitedIds = findLastWaitForJobsIds(agent.id);
        if (waitedIds && waitedIds.length > 0) {
          const waitedJobs = waitedIds.map(id => queries.getJobById(id));
          const allDone = waitedJobs.every(j => j && j.status === 'done');
          if (allDone) {
            const job = queries.getJobById(agent.job_id);
            if (job && !TERMINAL.includes(job.status)) {
              console.log(`[watchdog] agent ${agent.id} died in wait_for_jobs with all deps done — auto-resuming job ${job.id}`);
              queries.updateAgent(agent.id, {
                status: 'failed',
                error_message: 'Process died during wait_for_jobs; watchdog auto-resumed.',
                finished_at: Date.now(),
              });
              getFileLockRegistry().releaseAll(agent.id);

              const pendingQ = queries.getPendingQuestion(agent.id);
              if (pendingQ) {
                queries.updateQuestion(pendingQ.id, {
                  status: 'timeout',
                  answer: '[TIMEOUT] Agent process died; watchdog re-queued.',
                  answered_at: Date.now(),
                });
              }

              const newAgentId = randomUUID();
              queries.insertAgent({ id: newAgentId, job_id: job.id, status: 'starting' });
              queries.updateJobStatus(job.id, 'assigned');

              const newAgentWithJob = queries.getAgentWithJob(newAgentId);
              if (newAgentWithJob) socket.emitAgentNew(newAgentWithJob);
              const updatedJob = queries.getJobById(job.id);
              if (updatedJob) socket.emitJobUpdate(updatedJob);

              runAgent({ agentId: newAgentId, job, resumeSessionId: agent.session_id ?? undefined });
              console.log(`[watchdog] re-spawned agent ${newAgentId} for job ${job.id} with resume session ${agent.session_id ?? '(none)'}`);
              continue;
            }
          } else {
            const stillPending = waitedJobs
              .filter(j => j && !TERMINAL.includes(j.status))
              .map(j => j!.id);
            console.log(`[watchdog] agent ${agent.id} (${status}) dead in wait_for_jobs, ${stillPending.length} deps still pending: [${stillPending.join(', ')}]`);
          }
        }
      }

      // Normal dead-agent recovery
      const finalStatus = logStatus ?? 'failed';
      console.log(
        `[watchdog] agent ${agent.id} (${status}) — PID ${agent.pid ?? 'none'} dead, ` +
        `marking ${finalStatus}${logStatus ? ' (from log)' : ' (no result in log)'}`
      );

      queries.updateAgent(agent.id, {
        status: finalStatus,
        error_message: logStatus ? null : 'Agent process died unexpectedly.',
        finished_at: Date.now(),
      });
      queries.updateJobStatus(agent.job_id, finalStatus);
      getFileLockRegistry().releaseAll(agent.id);

      const pendingQ = queries.getPendingQuestion(agent.id);
      if (pendingQ) {
        queries.updateQuestion(pendingQ.id, {
          status: 'timeout',
          answer: '[TIMEOUT] Agent process died.',
          answered_at: Date.now(),
        });
      }

      const updatedAgent = queries.getAgentWithJob(agent.id);
      if (updatedAgent) socket.emitAgentUpdate(updatedAgent);
    }
  }

  // ── Check 2: Interactive agents with dead tmux sessions ────────────────────
  // listBatchAgents() excludes interactive jobs, so the dead-PID check above
  // never sees them.  Mirror what recovery.ts does: for each interactive agent
  // whose tmux session is gone, mark it done so the job is unblocked.
  for (const agent of queries.listRunningInteractiveAgents()) {
    if (isTmuxSessionAlive(agent.id)) continue;

    console.warn(
      `[watchdog] interactive agent ${agent.id} — tmux session gone, marking done`
    );

    queries.updateAgent(agent.id, { status: 'done', finished_at: Date.now() });
    queries.updateJobStatus(agent.job_id, 'done');
    getFileLockRegistry().releaseAll(agent.id);

    const pendingQ = queries.getPendingQuestion(agent.id);
    if (pendingQ) {
      queries.updateQuestion(pendingQ.id, {
        status: 'timeout',
        answer: '[TIMEOUT] Interactive session ended.',
        answered_at: Date.now(),
      });
    }

    const updatedAgent = queries.getAgentWithJob(agent.id);
    if (updatedAgent) socket.emitAgentUpdate(updatedAgent);
  }

  // ── Check 3: Job/agent inconsistency ───────────────────────────────────────
  // A job is in a terminal state but an agent row still shows 'running'.
  // This happens when the server restarts: recovery marks the job failed/done
  // but the new server session has no knowledge of whether an old process is
  // still lurking. Clean up the stale agent row.
  for (const agent of queries.listBatchAgents('running')) {
    const job = queries.getJobById(agent.job_id);
    if (!job || !TERMINAL.includes(job.status)) continue;

    console.warn(
      `[watchdog] inconsistency: agent ${agent.id} is 'running' but job ${agent.job_id} is '${job.status}' — cleaning up`
    );

    if (agent.pid) killProcess(agent.pid);

    queries.updateAgent(agent.id, {
      status: job.status === 'done' ? 'done' : 'failed',
      error_message: `Watchdog: job was '${job.status}' while agent still showed running.`,
      finished_at: Date.now(),
    });
    getFileLockRegistry().releaseAll(agent.id);

    const updatedAgent = queries.getAgentWithJob(agent.id);
    if (updatedAgent) socket.emitAgentUpdate(updatedAgent);
  }

  // ── Check 4: Orphaned locks from terminal agents ────────────────────────────
  // Active locks (not released, not expired) held by agents that are already in
  // a terminal state. Happens when an agent is killed between watchdog ticks:
  // the previous tick marks it terminal, subsequent ticks skip it, but any locks
  // acquired after the terminal marking are never released.
  const orphaned = queries.getActiveLocksForTerminalAgents();
  if (orphaned.length > 0) {
    const agentIds = [...new Set(orphaned.map(l => l.agent_id))];
    console.warn(`[watchdog] releasing ${orphaned.length} orphaned lock(s) from ${agentIds.length} terminal agent(s): [${agentIds.map(id => id.slice(0, 6)).join(', ')}]`);
    for (const agentId of agentIds) {
      getFileLockRegistry().releaseAll(agentId);
    }
  }
}

export function startWatchdog(): void {
  console.log('[watchdog] started (interval: 30s)');
  // Run once immediately to catch anything from startup
  try { check(); } catch (err) { console.error('[watchdog] initial check error:', err); }
  _timer = setInterval(() => {
    try { check(); } catch (err) { console.error('[watchdog] check error:', err); }
  }, WATCHDOG_INTERVAL_MS);
}

export function stopWatchdog(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
