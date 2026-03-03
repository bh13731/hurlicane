import { Router } from 'express';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import path from 'path';
import * as queries from '../db/queries.js';
import { runCleanupNow } from '../orchestrator/WorktreeCleanup.js';

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
  const { branch, repoDir: reqRepoDir, trackExisting } = req.body;
  if (!branch || typeof branch !== 'string') {
    res.status(400).json({ error: 'branch is required' });
    return;
  }

  // Validate branch name: no spaces, reasonable git-safe chars
  if (!/^[a-zA-Z0-9._\-/]+$/.test(branch)) {
    res.status(400).json({ error: 'Invalid branch name. Use alphanumeric, dots, hyphens, underscores, or slashes.' });
    return;
  }

  try {
    const shortId = randomUUID().slice(0, 8);
    const repoDir = (typeof reqRepoDir === 'string' && reqRepoDir) ? reqRepoDir : null;
    if (!repoDir) {
      res.status(400).json({ error: 'repoDir is required' });
      return;
    }
    const worktreeDir = path.resolve(repoDir, '..', '.orchestrator-worktrees', shortId);

    if (trackExisting) {
      // Fetch the branch from origin, then check out the existing branch
      execSync('git fetch origin', { cwd: repoDir, timeout: 30_000 });
      execSync(`git worktree add ${JSON.stringify(worktreeDir)} ${JSON.stringify(branch)}`, {
        cwd: repoDir,
        timeout: 30_000,
      });
    } else {
      execSync(`git worktree add ${JSON.stringify(worktreeDir)} -b ${JSON.stringify(branch)}`, {
        cwd: repoDir,
        timeout: 30_000,
      });
    }

    const wt = queries.insertWorktree({
      id: shortId,
      agent_id: '',
      job_id: '',
      path: worktreeDir,
      branch,
    });

    res.json(wt);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to create worktree' });
  }
});

router.delete('/:id', (req, res) => {
  const wt = queries.getWorktreeById(req.params.id);
  if (!wt) {
    res.status(404).json({ error: 'Worktree not found' });
    return;
  }

  try {
    const repoDir = process.cwd();
    execSync(`git worktree remove --force ${JSON.stringify(wt.path)}`, {
      cwd: repoDir,
      timeout: 30_000,
    });
    // Clean up the branch too
    try {
      execSync(`git branch -D ${JSON.stringify(wt.branch)}`, {
        cwd: repoDir,
        timeout: 10_000,
      });
    } catch { /* branch may already be gone */ }
  } catch { /* worktree dir may already be gone */ }

  queries.markWorktreeCleaned(wt.id);
  res.json({ ok: true });
});

export default router;
