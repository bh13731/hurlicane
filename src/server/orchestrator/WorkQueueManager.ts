import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import * as path from 'path';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { runAgent } from './AgentRunner.js';
import { startInteractiveAgent } from './PtyManager.js';
import { resolveModel } from './ModelClassifier.js';
import type { Job } from '../../shared/types.js';

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

    // If worktree requested, create one and override the working directory
    const dispatchJob = readyJob.use_worktree
      ? createWorktree(readyJob, agentId)
      : readyJob;

    console.log(`[queue] dispatching "${job.title}" → agent ${agentId} (model: ${model}, interactive: ${!!readyJob.is_interactive}${readyJob.use_worktree ? ', worktree' : ''})`);
    if (dispatchJob.is_interactive) {
      startInteractiveAgent({ agentId, job: dispatchJob });
    } else {
      runAgent({ agentId, job: dispatchJob });
    }
  } catch (err: any) {
    console.error(`[queue] dispatch failed for job ${job.id}:`, err);
    queries.updateJobStatus(job.id, 'failed');
    socket.emitJobUpdate(queries.getJobById(job.id)!);
  } finally {
    _classifying.delete(job.id);
  }
}

/**
 * Create a git worktree for a job and return a shallow copy of the job
 * with work_dir pointing to the new worktree.
 */
function createWorktree(job: Job, agentId: string): Job {
  const repoDir = (job as any).work_dir ?? process.cwd();
  const shortId = agentId.slice(0, 8);

  // Slugify job title for the branch name
  const slug = job.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  const branchName = `orchestrator/${slug}-${shortId}`;

  // Place worktrees in a sibling directory to keep the source repo clean
  const worktreeDir = path.resolve(repoDir, '..', '.orchestrator-worktrees', shortId);

  console.log(`[queue] creating worktree: ${worktreeDir} (branch: ${branchName})`);
  execSync(`git worktree add ${JSON.stringify(worktreeDir)} -b ${JSON.stringify(branchName)}`, {
    cwd: repoDir,
    timeout: 30000,
  });

  // Return a copy of the job with the overridden work_dir
  return { ...job, work_dir: worktreeDir } as any;
}
