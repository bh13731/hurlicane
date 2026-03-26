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

    // For non-readonly jobs with a repo_id, ensure a worktree exists for the repo/branch
    const dispatchJob = (!readyJob.is_readonly && readyJob.repo_id)
      ? ensureWorktree(readyJob, agentId)
      : readyJob;

    // Codex batch agents still use runAgent (stream-json path); all others use tmux.
    const useCodexBatch = isCodexModel((dispatchJob as any).model ?? null) && !dispatchJob.is_interactive;
    const autoFinish = !dispatchJob.is_interactive;
    console.log(`[queue] dispatching "${job.title}" → agent ${agentId} (model: ${model}, interactive: ${!!readyJob.is_interactive}${readyJob.repo_id ? `, repo: ${readyJob.repo_id}` : ''}${readyJob.branch ? `, branch: ${readyJob.branch}` : ''}${useCodexBatch ? ', codex-batch' : ''})`);
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
 * Ensure a worktree exists for the job's repo_id + branch.
 * If one already exists, reuse it. Otherwise create a new one.
 * Updates the job's branch in the DB if it was auto-generated.
 */
function ensureWorktree(job: Job, agentId: string): Job {
  if (!job.repo_id) throw new Error('repo_id is required for worktree creation');

  const repo = queries.getRepoById(job.repo_id);
  if (!repo) throw new Error(`No registered repo found for id: ${job.repo_id}`);

  // If the job already has a branch, check for an existing worktree
  if (job.branch) {
    const existing = queries.getWorktreeByBranch(job.branch, job.repo_id);
    if (existing) {
      console.log(`[queue] reusing existing worktree for branch ${job.branch}: ${existing.path}`);
      return job;
    }
  }

  const shortId = agentId.slice(0, 8);

  // Generate branch name if not provided
  const branchName = job.branch ?? (() => {
    const slug = job.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    return `orchestrator/${slug}-${shortId}`;
  })();

  const worktreeDir = path.resolve('data', 'worktrees', shortId);

  // Prune stale worktree references so branch names can be reused
  try { execSync('git worktree prune', { cwd: repo.path, timeout: 10_000, stdio: 'pipe' }); } catch { /* ignore */ }

  const baseBranch = repo.default_branch || 'main';

  // Pull latest base branch so the worktree branches from the newest commit
  try { execSync(`git pull origin ${JSON.stringify(baseBranch)}`, { cwd: repo.path, timeout: 30_000, stdio: 'pipe' }); } catch { /* ignore */ }

  // If base branch has no commits yet (empty repo), create an initial empty commit
  try {
    execSync(`git rev-parse ${JSON.stringify(baseBranch)}`, { cwd: repo.path, timeout: 5_000, stdio: 'pipe' });
  } catch {
    execSync('git commit --allow-empty -m "Initial commit"', { cwd: repo.path, timeout: 10_000, stdio: 'pipe' });
  }

  console.log(`[queue] creating worktree: ${worktreeDir} (branch: ${branchName}, base: ${baseBranch})`);
  execSync(`git worktree add ${JSON.stringify(worktreeDir)} -b ${JSON.stringify(branchName)} ${JSON.stringify(baseBranch)}`, {
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
  } catch (err) { console.warn('[queue] failed to record worktree:', err); }

  // If branch was auto-generated, persist it back to the job
  if (!job.branch) {
    queries.updateJobBranch(job.id, branchName);
  }

  return { ...job, branch: branchName };
}
