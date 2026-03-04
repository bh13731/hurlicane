import { Router } from 'express';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import path from 'path';
import * as queries from '../db/queries.js';
import { cancelledAgents } from '../orchestrator/AgentRunner.js';
import { getFileLockRegistry } from '../orchestrator/FileLockRegistry.js';
import * as socket from '../socket/SocketManager.js';
import { runCleanupNow } from '../orchestrator/WorktreeCleanup.js';

/** Directory where worktrees are materialised. */
const WORKTREES_DIR = path.resolve('data', 'worktrees');

const router = Router();

router.get('/stats', (_req, res) => {
  const stats = queries.getWorktreeStats();
  res.json(stats);
});

router.get('/', (_req, res) => {
  const worktrees = queries.listActiveWorktrees();
  res.json(worktrees);
});

router.get('/by-branch/:branch(*)', (req, res) => {
  const wt = queries.getWorktreeByBranch(req.params.branch);
  if (!wt) { res.status(404).json({ error: 'no active worktree for branch' }); return; }
  res.json(wt);
});

router.post('/cleanup', (_req, res) => {
  const cleaned = runCleanupNow();
  res.json({ cleaned });
});

router.post('/', (req, res) => {
  const { branch, repoId, trackExisting } = req.body;
  if (!branch || typeof branch !== 'string') {
    res.status(400).json({ error: 'branch is required' });
    return;
  }
  if (!repoId || typeof repoId !== 'string') {
    res.status(400).json({ error: 'repoId is required' });
    return;
  }

  // Sanitize into a valid branch name: replace invalid chars with hyphens, collapse runs, trim edges
  const sanitized = branch
    .replace(/[^a-zA-Z0-9._\-/]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-./]+|[-./]+$/g, '');
  if (!sanitized) {
    res.status(400).json({ error: 'Branch name is empty after sanitization' });
    return;
  }

  const repo = queries.getRepoById(repoId);
  if (!repo) {
    res.status(404).json({ error: 'Repo not found' });
    return;
  }

  try {
    const shortId = randomUUID().slice(0, 8);
    const worktreeDir = path.join(WORKTREES_DIR, shortId);

    // Pull latest main so worktrees branch from the newest commit
    try { execSync('git pull origin main', { cwd: repo.path, timeout: 30_000, stdio: 'pipe' }); } catch { /* ignore */ }

    // If main has no commits yet (empty repo), create an initial empty commit
    try {
      execSync('git rev-parse main', { cwd: repo.path, timeout: 5_000, stdio: 'pipe' });
    } catch {
      execSync('git commit --allow-empty -m "Initial commit"', { cwd: repo.path, timeout: 10_000, stdio: 'pipe' });
    }

    if (trackExisting) {
      // Fetch so the branch ref is available, then check it out
      try { execSync('git fetch origin', { cwd: repo.path, timeout: 30_000, stdio: 'pipe' }); } catch { /* ignore */ }
      try {
        execSync(`git worktree add ${JSON.stringify(worktreeDir)} ${JSON.stringify(sanitized)}`, {
          cwd: repo.path,
          timeout: 30_000,
        });
      } catch {
        const remoteRef = `origin/${sanitized}`;
        execSync(`git worktree add --detach ${JSON.stringify(worktreeDir)} ${JSON.stringify(remoteRef)}`, {
          cwd: repo.path,
          timeout: 30_000,
        });
        execSync(`git checkout -B ${JSON.stringify(sanitized)} ${JSON.stringify(remoteRef)}`, {
          cwd: worktreeDir,
          timeout: 10_000,
        });
      }
    } else {
      execSync(`git worktree add ${JSON.stringify(worktreeDir)} -b ${JSON.stringify(sanitized)} main`, {
        cwd: repo.path,
        timeout: 30_000,
      });
    }

    const wt = queries.insertWorktree({
      id: shortId,
      repo_id: repo.id,
      agent_id: '',
      job_id: '',
      path: worktreeDir,
      branch: sanitized,
    });

    res.json(wt);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to create worktree' });
  }
});

// POST /api/worktrees/cleanup-branch — cancel agents + remove worktree for a branch
router.post('/cleanup-branch', (req, res) => {
  const { branch } = req.body;
  if (!branch || typeof branch !== 'string') {
    res.status(400).json({ error: 'branch is required' });
    return;
  }

  const wt = queries.getWorktreeByBranch(branch);
  if (!wt) {
    res.json({ ok: true, found: false, cancelledJobs: 0 });
    return;
  }

  // Find and cancel all active jobs running in this worktree
  const activeJobs = queries.listActiveJobsByWorkDir(wt.path);
  let cancelledJobCount = 0;
  for (const job of activeJobs) {
    const agents = queries.getAgentsWithJobByJobId(job.id);
    for (const agent of agents) {
      if (['starting', 'running', 'waiting_user'].includes(agent.status)) {
        cancelledAgents.add(agent.id);
        if (agent.pid) {
          try { process.kill(-agent.pid, 'SIGTERM'); } catch { /* already gone */ }
        }
        queries.updateAgent(agent.id, { status: 'cancelled', finished_at: Date.now() });
        getFileLockRegistry().releaseAll(agent.id);
        const updated = queries.getAgentWithJob(agent.id);
        if (updated) socket.emitAgentUpdate(updated);
      }
    }
    queries.updateJobStatus(job.id, 'cancelled');
    const updatedJob = queries.getJobById(job.id);
    if (updatedJob) socket.emitJobUpdate(updatedJob);
    cancelledJobCount++;
  }

  // Remove the git worktree using the bare repo
  const repo = queries.getRepoById(wt.repo_id);
  if (repo) {
    try {
      execSync(`git worktree remove --force ${JSON.stringify(wt.path)}`, {
        cwd: repo.path,
        timeout: 30_000,
      });
    } catch { /* worktree dir may already be gone */ }
  }

  queries.markWorktreeCleaned(wt.id);

  console.log(`[worktrees] cleaned up branch ${branch}: cancelled ${cancelledJobCount} jobs, removed worktree ${wt.path}`);
  res.json({ ok: true, found: true, cancelledJobs: cancelledJobCount, worktreeId: wt.id });
});

router.get('/:id/diff', (req, res) => {
  const wt = queries.getWorktreeById(req.params.id);
  if (!wt) { res.status(404).json({ error: 'Worktree not found' }); return; }

  try {
    const diff = execSync('git diff main...HEAD --no-color', {
      cwd: wt.path,
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    }).toString();

    let commits = '';
    try {
      commits = execSync('git log --oneline main..HEAD', {
        cwd: wt.path,
        timeout: 10_000,
      }).toString();
    } catch { /* no commits yet */ }

    res.json({ diff, commits });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to get diff' });
  }
});

router.post('/:id/push', (req, res) => {
  const wt = queries.getWorktreeById(req.params.id);
  if (!wt) { res.status(404).json({ error: 'Worktree not found' }); return; }

  try {
    execSync(`git push -u origin ${JSON.stringify(wt.branch)}`, {
      cwd: wt.path,
      timeout: 60_000,
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to push' });
  }
});

router.post('/:id/pr', (req, res) => {
  const wt = queries.getWorktreeById(req.params.id);
  if (!wt) { res.status(404).json({ error: 'Worktree not found' }); return; }

  try {
    // Ensure main is pushed to origin (needed if we created the initial empty commit locally)
    const repo = queries.getRepoById(wt.repo_id);
    if (repo) {
      try { execSync('git push -u origin main', { cwd: repo.path, timeout: 30_000, stdio: 'pipe' }); } catch { /* already pushed */ }
    }

    // Push the worktree branch
    execSync(`git push -u origin ${JSON.stringify(wt.branch)}`, {
      cwd: wt.path,
      timeout: 60_000,
    });

    const output = execSync(`gh pr create --fill --draft --head ${JSON.stringify(wt.branch)}`, {
      cwd: wt.path,
      timeout: 30_000,
    }).toString().trim();

    const lines = output.split('\n');
    const url = lines[lines.length - 1];
    res.json({ url });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to create PR' });
  }
});

router.delete('/:id', (req, res) => {
  const wt = queries.getWorktreeById(req.params.id);
  if (!wt) {
    res.status(404).json({ error: 'Worktree not found' });
    return;
  }

  const repo = queries.getRepoById(wt.repo_id);
  if (repo) {
    try {
      execSync(`git worktree remove --force ${JSON.stringify(wt.path)}`, {
        cwd: repo.path,
        timeout: 30_000,
      });
      try {
        execSync(`git branch -D ${JSON.stringify(wt.branch)}`, {
          cwd: repo.path,
          timeout: 10_000,
        });
      } catch { /* branch may already be gone */ }
    } catch { /* worktree dir may already be gone */ }
  }

  queries.markWorktreeCleaned(wt.id);
  res.json({ ok: true });
});

export default router;
