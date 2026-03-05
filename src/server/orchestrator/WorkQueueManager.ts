import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import * as path from 'path';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { runAgent } from './AgentRunner.js';
import { startInteractiveAgent } from './PtyManager.js';
import { resolveModel } from './ModelClassifier.js';
import type { Job } from '../../shared/types.js';
import { isCodexModel } from '../../shared/types.js';
import { notifyWorktreeCreated } from '../services/SlackNotifier.js';

let _maxConcurrent = Number(process.env.MAX_CONCURRENT_AGENTS ?? 20);
const POLL_INTERVAL_MS = 2000;

export function getMaxConcurrent(): number { return _maxConcurrent; }
export function setMaxConcurrent(n: number): void { _maxConcurrent = n; }

let _running = false;
let _timer: NodeJS.Timeout | null = null;
// Tracks jobs currently being classified so the next tick doesn't re-pick them
const _classifying = new Set<string>();

export function startWorkQueue(): void {
  if (_running) return;
  _running = true;
  console.log('[queue] WorkQueueManager started');
  _timer = setInterval(() => { try { tick().catch(console.error); } catch (err) { console.error('[queue] tick error:', err); } }, POLL_INTERVAL_MS);
  try { tick().catch(console.error); } catch (err) { console.error('[queue] initial tick error:', err); }
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

  // Cascade-fail: mark queued jobs as failed if any dependency failed/cancelled
  for (const job of queries.getJobsWithFailedDeps()) {
    const failedDeps = queries.getFailedDepsForJob(job.id);
    const names = failedDeps.map(d => `${d.title} (${d.status})`).join(', ');
    console.log(`[queue] cascade-fail "${job.title}" — failed deps: ${names}`);
    queries.updateJobStatus(job.id, 'failed');
    socket.emitJobUpdate(queries.getJobById(job.id)!);
  }

  const activeAgents = queries.listAgents().filter(a =>
    a.status === 'starting' || a.status === 'running' || a.status === 'waiting_user'
  );

  // Count classifying jobs against the concurrency limit so we don't over-dispatch
  if (activeAgents.length + _classifying.size >= _maxConcurrent) return;

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
    queries.insertAgent({ id: agentId, job_id: job.id, status: 'starting', parent_agent_id: (readyJob as any).created_by_agent_id ?? undefined });
    socket.emitAgentNew(queries.getAgentWithJob(agentId)!);

    // Readonly jobs skip worktree creation and run directly in the repo
    // If worktree requested, create one and override the working directory
    const dispatchJob = (readyJob.use_worktree && !readyJob.is_readonly)
      ? createWorktree(readyJob, agentId)
      : readyJob;

    // Codex batch agents still use runAgent (stream-json path); all others use tmux.
    // Debate-stage jobs use --print inside tmux (piped through tee to .ndjson for UI display)
    // and exit naturally — no finish_job needed.
    const useCodexBatch = isCodexModel((dispatchJob as any).model ?? null) && !dispatchJob.is_interactive;
    const isDebateStage = !!(dispatchJob as any).debate_role;
    const autoFinish = !dispatchJob.is_interactive && !isDebateStage;
    console.log(`[queue] dispatching "${job.title}" → agent ${agentId} (model: ${model}, interactive: ${!!readyJob.is_interactive}${readyJob.use_worktree ? ', worktree' : ''}${useCodexBatch ? ', codex-batch' : ''}${isDebateStage ? ', debate-stage' : ''})`);
    if (useCodexBatch) {
      runAgent({ agentId, job: dispatchJob });
    } else {
      startInteractiveAgent({ agentId, job: dispatchJob, autoFinish });
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
  const repoDir = (job as any).work_dir;
  if (!repoDir) throw new Error('work_dir is required for worktree creation');

  // If work_dir is already a worktree, reuse it instead of creating a new one
  const existingWt = queries.getWorktreeByPath(repoDir);
  if (existingWt) {
    console.log(`[queue] work_dir is already worktree ${existingWt.id} (branch: ${existingWt.branch}), reusing`);
    return job;
  }

  // Look up the repo record so we know the repo path and id
  const repo = queries.getRepoByPath(repoDir);
  if (!repo) throw new Error(`No registered repo found for path: ${repoDir}`);

  const shortId = agentId.slice(0, 8);

  // Slugify job title for the branch name
  const slug = job.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  const branchName = `orchestrator/${slug}-${shortId}`;

  const worktreeDir = path.resolve('data', 'worktrees', shortId);

  // Prune stale worktree references so branch names can be reused
  try { execSync('git worktree prune', { cwd: repo.path, timeout: 10_000, stdio: 'pipe' }); } catch { /* ignore */ }

  // Pull latest main so the worktree branches from the newest commit
  try { execSync('git pull origin main', { cwd: repo.path, timeout: 30_000, stdio: 'pipe' }); } catch { /* ignore */ }

  // If main has no commits yet (empty repo), create an initial empty commit
  try {
    execSync('git rev-parse main', { cwd: repo.path, timeout: 5_000, stdio: 'pipe' });
  } catch {
    execSync('git commit --allow-empty -m "Initial commit"', { cwd: repo.path, timeout: 10_000, stdio: 'pipe' });
  }

  console.log(`[queue] creating worktree: ${worktreeDir} (branch: ${branchName}, base: main)`);
  execSync(`git worktree add ${JSON.stringify(worktreeDir)} -b ${JSON.stringify(branchName)} main`, {
    cwd: repo.path,
    timeout: 30_000,
  });

  // Record worktree in DB for cleanup tracking
  try {
    queries.insertWorktree({
      id: randomUUID(),
      repo_id: repo.id,
      agent_id: agentId,
      job_id: job.id,
      path: worktreeDir,
      branch: branchName,
    });
    notifyWorktreeCreated(branchName, job.title);
  } catch (err) { console.warn('[queue] failed to record worktree:', err); }

  // Return a copy of the job with the overridden work_dir
  return { ...job, work_dir: worktreeDir } as any;
}
