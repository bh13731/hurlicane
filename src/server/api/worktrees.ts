import { Router } from 'express';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import path from 'path';
import * as queries from '../db/queries.js';
import { cancelledAgents } from '../orchestrator/AgentRunner.js';
import { getFileLockRegistry } from '../orchestrator/FileLockRegistry.js';
import * as socket from '../socket/SocketManager.js';
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
      // Fetch the branch from origin, then check out the existing branch.
      // Use --detach first to avoid "already checked out" errors, then
      // create a local branch tracking the remote.
      execSync('git fetch origin', { cwd: repoDir, timeout: 30_000 });
      try {
        execSync(`git worktree add ${JSON.stringify(worktreeDir)} ${JSON.stringify(branch)}`, {
          cwd: repoDir,
          timeout: 30_000,
        });
      } catch {
        // Branch is likely already checked out in the main repo.
        // Detach at the remote ref, then create a local branch pointing there.
        const remoteRef = `origin/${branch}`;
        execSync(`git worktree add --detach ${JSON.stringify(worktreeDir)} ${JSON.stringify(remoteRef)}`, {
          cwd: repoDir,
          timeout: 30_000,
        });
        // Create a local branch in the worktree so commits land on a named branch
        execSync(`git checkout -B ${JSON.stringify(branch)} ${JSON.stringify(remoteRef)}`, {
          cwd: worktreeDir,
          timeout: 10_000,
        });
      }
    } else {
      execSync(`git worktree add ${JSON.stringify(worktreeDir)} -b ${JSON.stringify(branch)} main`, {
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
    // Cancel running agents for this job
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

  // Remove the git worktree
  try {
    // Find the repo dir from the worktree path (parent of .orchestrator-worktrees)
    const worktreeParent = path.dirname(wt.path);
    const repoDir = path.resolve(worktreeParent, '..');
    execSync(`git worktree remove --force ${JSON.stringify(wt.path)}`, {
      cwd: repoDir,
      timeout: 30_000,
    });
  } catch { /* worktree dir may already be gone */ }

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
    const output = execSync(`gh pr create --fill --draft --head ${JSON.stringify(wt.branch)}`, {
      cwd: wt.path,
      timeout: 30_000,
    }).toString().trim();

    // gh pr create prints the PR URL as the last line
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
