import { randomUUID } from 'crypto';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { runAgent } from './AgentRunner.js';
import { startInteractiveAgent } from './PtyManager.js';
import { resolveModel } from './ModelClassifier.js';

const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_AGENTS ?? 20);
const POLL_INTERVAL_MS = 2000;

let _running = false;
let _timer: NodeJS.Timeout | null = null;
// Tracks jobs currently being classified so the next tick doesn't re-pick them
const _classifying = new Set<string>();

export function startWorkQueue(): void {
  if (_running) return;
  _running = true;
  console.log('[queue] WorkQueueManager started');
  _timer = setInterval(() => { tick().catch(console.error); }, POLL_INTERVAL_MS);
  tick().catch(console.error);
}

export function stopWorkQueue(): void {
  _running = false;
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

async function tick(): Promise<void> {
  if (!_running) return;

  const activeAgents = queries.listAgents().filter(a =>
    a.status === 'starting' || a.status === 'running' || a.status === 'waiting_user'
  );

  // Count classifying jobs against the concurrency limit so we don't over-dispatch
  if (activeAgents.length + _classifying.size >= MAX_CONCURRENT) return;

  const job = queries.getNextQueuedJob();
  if (!job || _classifying.has(job.id)) return;

  // Mark assigned immediately to prevent double-dispatch across ticks
  queries.updateJobStatus(job.id, 'assigned');
  socket.emitJobUpdate(queries.getJobById(job.id)!);
  _classifying.add(job.id);

  try {
    // Classify & resolve model (no-op if user already picked one)
    const model = await resolveModel(job);

    // Re-fetch so the agent sees the now-resolved model field
    const readyJob = queries.getJobById(job.id)!;

    const agentId = randomUUID();
    queries.insertAgent({ id: agentId, job_id: job.id, status: 'starting' });
    socket.emitAgentNew(queries.getAgentWithJob(agentId)!);

    console.log(`[queue] dispatching "${job.title}" → agent ${agentId} (model: ${model}, interactive: ${!!readyJob.is_interactive})`);
    if (readyJob.is_interactive) {
      startInteractiveAgent({ agentId, job: readyJob });
    } else {
      runAgent({ agentId, job: readyJob });
    }
  } catch (err: any) {
    console.error(`[queue] dispatch failed for job ${job.id}:`, err);
    queries.updateJobStatus(job.id, 'failed');
    socket.emitJobUpdate(queries.getJobById(job.id)!);
  } finally {
    _classifying.delete(job.id);
  }
}
