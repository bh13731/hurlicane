import { Router } from 'express';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import path from 'path';
import * as queries from '../db/queries.js';
import { cancelledAgents } from '../orchestrator/AgentRunner.js';
import { getFileLockRegistry } from '../orchestrator/FileLockRegistry.js';
import * as socket from '../socket/SocketManager.js';
import { runCleanupNow } from '../orchestrator/WorktreeCleanup.js';
import { notifyMerge } from '../services/SlackNotifier.js';

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

    // Prune stale worktree references so branch names can be reused
    try { execSync('git worktree prune', { cwd: repo.path, timeout: 10_000, stdio: 'pipe' }); } catch { /* ignore */ }

    // If the branch is already checked out in another worktree, remove it first
    try {
      const wtList = execSync('git worktree list --porcelain', { cwd: repo.path, timeout: 10_000, stdio: 'pipe' }).toString();
      const entries = wtList.split('\n\n');
      for (const entry of entries) {
        const branchMatch = entry.match(/^branch refs\/heads\/(.+)$/m);
        const pathMatch = entry.match(/^worktree (.+)$/m);
        if (branchMatch && pathMatch && branchMatch[1] === sanitized && pathMatch[1] !== repo.path) {
          const oldPath = pathMatch[1];
          console.log(`[worktrees] removing old worktree at ${oldPath} that holds branch ${sanitized}`);
          try { execSync(`git worktree remove --force ${JSON.stringify(oldPath)}`, { cwd: repo.path, timeout: 15_000, stdio: 'pipe' }); } catch { /* ignore */ }
          // Mark as cleaned in DB if tracked
          const oldWt = queries.getWorktreeByPath(oldPath);
          if (oldWt) { queries.markWorktreeCleaned(oldWt.id); }
        }
      }
    } catch { /* ignore */ }

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
  const { branch, merged } = req.body;
  if (!branch || typeof branch !== 'string') {
    res.status(400).json({ error: 'branch is required' });
    return;
  }

  const wt = queries.getWorktreeByBranch(branch);
  if (!wt) {
    if (merged) {
      notifyMerge(branch);
    }
    res.json({ ok: true, found: false, cancelledJobs: 0 });
    return;
  }

  if (merged) {
    const job = queries.getJobById(wt.job_id);
    notifyMerge(branch, job?.title);
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

    let output: string;
    try {
      output = execSync(`gh pr create --fill --draft --head ${JSON.stringify(wt.branch)}`, {
        cwd: wt.path,
        timeout: 30_000,
      }).toString().trim();
    } catch {
      // --fill fails when there are no commits between base and head (e.g. remote branch tracking).
      // Fall back to explicit title/body.
      output = execSync(`gh pr create --draft --head ${JSON.stringify(wt.branch)} --title ${JSON.stringify(wt.branch)} --body ""`, {
        cwd: wt.path,
        timeout: 30_000,
      }).toString().trim();
    }

    const lines = output.split('\n');
    const url = lines[lines.length - 1];
    res.json({ url });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to create PR' });
  }
});

router.get('/:id/status', (req, res) => {
  const wt = queries.getWorktreeById(req.params.id);
  if (!wt) { res.status(404).json({ error: 'Worktree not found' }); return; }

  try {
    // Check if local HEAD matches remote
    let synced = false;
    try {
      execSync(`git fetch origin ${JSON.stringify(wt.branch)}`, {
        cwd: wt.path,
        timeout: 30_000,
        stdio: 'pipe',
      });
      const localHead = execSync('git rev-parse HEAD', { cwd: wt.path, timeout: 5_000, stdio: 'pipe' }).toString().trim();
      const remoteHead = execSync(`git rev-parse origin/${wt.branch}`, { cwd: wt.path, timeout: 5_000, stdio: 'pipe' }).toString().trim();
      synced = localHead === remoteHead;
    } catch {
      // Remote branch doesn't exist yet — not synced
      synced = false;
    }

    // Check PR status via gh CLI
    let prUrl: string | null = null;
    let prState: string | null = null;
    let autoMerge = false;
    try {
      const ghOutput = execSync(
        `gh pr view ${JSON.stringify(wt.branch)} --json url,state,autoMergeRequest`,
        { cwd: wt.path, timeout: 15_000, stdio: 'pipe' },
      ).toString().trim();
      const prData = JSON.parse(ghOutput);
      prUrl = prData.url || null;
      prState = prData.state || null;
      autoMerge = prData.autoMergeRequest != null;
    } catch {
      // No PR exists for this branch
    }

    res.json({ synced, prUrl, prState, autoMerge });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to get status' });
  }
});

router.post('/:id/automerge', (req, res) => {
  const wt = queries.getWorktreeById(req.params.id);
  if (!wt) { res.status(404).json({ error: 'Worktree not found' }); return; }

  try {
    execSync(`gh pr merge ${JSON.stringify(wt.branch)} --auto --squash`, {
      cwd: wt.path,
      timeout: 15_000,
      stdio: 'pipe',
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to enable auto-merge' });
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
