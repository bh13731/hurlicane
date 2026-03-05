import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as queries from '../db/queries.js';

const WORKTREES_DIR = path.resolve('data', 'worktrees');

function removeWorktree(wtPath: string, branch: string, repoDir: string | null): void {
  // Remove the worktree
  if (fs.existsSync(wtPath)) {
    if (repoDir) {
      try {
        execSync(`git worktree remove --force ${JSON.stringify(wtPath)}`, {
          cwd: repoDir,
          timeout: 30000,
        });
      } catch {
        // If git worktree remove fails, try manual cleanup
        try { fs.rmSync(wtPath, { recursive: true, force: true }); } catch { /* ignore */ }
        try { execSync('git worktree prune', { cwd: repoDir, timeout: 10000 }); } catch { /* ignore */ }
      }
    } else {
      // No repo reference — just remove the directory
      try { fs.rmSync(wtPath, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // Delete the branch
  if (branch && repoDir) {
    try {
      execSync(`git branch -D ${JSON.stringify(branch)}`, {
        cwd: repoDir,
        timeout: 10000,
      });
    } catch { /* branch may not exist or may be checked out elsewhere */ }
  }
}

function cleanupOrphanedWorktrees(): void {
  if (!fs.existsSync(WORKTREES_DIR)) return;

  const tracked = new Set(queries.listActiveWorktrees().map(w => w.path));
  let cleaned = 0;

  try {
    const entries = fs.readdirSync(WORKTREES_DIR);
    for (const entry of entries) {
      const fullPath = path.join(WORKTREES_DIR, entry);
      if (!fs.statSync(fullPath).isDirectory()) continue;
      if (tracked.has(fullPath)) continue;

      // Orphaned directory — remove it
      try {
        fs.rmSync(fullPath, { recursive: true, force: true });
        cleaned++;
      } catch { /* ignore */ }
    }
  } catch { /* directory listing may fail */ }

  // Prune worktree references in all registered repos
  if (cleaned > 0) {
    const repos = queries.listRepos();
    for (const repo of repos) {
      try { execSync('git worktree prune', { cwd: repo.path, timeout: 10000 }); } catch { /* ignore */ }
    }
    console.log(`[worktree-cleanup] cleaned ${cleaned} orphaned worktrees`);
  }
}

/** Manual cleanup trigger — returns number of worktrees cleaned */
export function runCleanupNow(): number {
  const active = queries.listActiveWorktrees();
  let cleaned = 0;

  for (const wt of active) {
    const job = queries.getJobById(wt.job_id);
    if (!job) continue;
    if (job.status !== 'done' && job.status !== 'failed' && job.status !== 'cancelled') continue;

    try {
      const repo = queries.getRepoById(wt.repo_id);
      removeWorktree(wt.path, wt.branch, repo?.path ?? null);
      queries.markWorktreeCleaned(wt.id);
      cleaned++;
    } catch { /* skip */ }
  }

  cleanupOrphanedWorktrees();
  return cleaned;
}
