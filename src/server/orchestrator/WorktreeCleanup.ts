import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as queries from '../db/queries.js';

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;  // 5 minutes
let _timer: NodeJS.Timeout | null = null;

export function startWorktreeCleanup(): void {
  if (_timer) return;
  console.log('[worktree-cleanup] started');
  _timer = setInterval(() => { try { tick(); } catch (err) { console.error('[worktree-cleanup] tick error:', err); } }, CLEANUP_INTERVAL_MS);
}

export function stopWorktreeCleanup(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

function tick(): void {
  const active = queries.listActiveWorktrees();
  let cleaned = 0;

  for (const wt of active) {
    const job = queries.getJobById(wt.job_id);
    if (!job) continue;
    // Only clean up worktrees whose jobs are terminal
    if (job.status !== 'done' && job.status !== 'failed' && job.status !== 'cancelled') continue;

    try {
      removeWorktree(wt.path, wt.branch);
      queries.markWorktreeCleaned(wt.id);
      cleaned++;
    } catch (err) {
      console.warn(`[worktree-cleanup] failed to clean ${wt.path}:`, err);
    }
  }

  // Also clean orphaned worktrees not tracked in DB
  cleanupOrphanedWorktrees();

  if (cleaned > 0) {
    console.log(`[worktree-cleanup] cleaned ${cleaned} worktrees`);
  }
}

function removeWorktree(wtPath: string, branch: string): void {
  const repoDir = process.cwd();

  // Remove the worktree
  if (fs.existsSync(wtPath)) {
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
  }

  // Delete the branch
  if (branch) {
    try {
      execSync(`git branch -D ${JSON.stringify(branch)}`, {
        cwd: repoDir,
        timeout: 10000,
      });
    } catch { /* branch may not exist or may be checked out elsewhere */ }
  }
}

function cleanupOrphanedWorktrees(): void {
  const repoDir = process.cwd();
  const worktreeBase = path.resolve(repoDir, '..', '.orchestrator-worktrees');

  if (!fs.existsSync(worktreeBase)) return;

  const tracked = new Set(queries.listActiveWorktrees().map(w => w.path));
  let cleaned = 0;

  try {
    const entries = fs.readdirSync(worktreeBase);
    for (const entry of entries) {
      const fullPath = path.join(worktreeBase, entry);
      if (!fs.statSync(fullPath).isDirectory()) continue;
      if (tracked.has(fullPath)) continue;

      // Orphaned directory — remove it
      try {
        execSync(`git worktree remove --force ${JSON.stringify(fullPath)}`, {
          cwd: repoDir,
          timeout: 30000,
        });
        cleaned++;
      } catch {
        try {
          fs.rmSync(fullPath, { recursive: true, force: true });
          cleaned++;
        } catch { /* ignore */ }
      }
    }
  } catch { /* directory listing may fail */ }

  if (cleaned > 0) {
    try { execSync('git worktree prune', { cwd: repoDir, timeout: 10000 }); } catch { /* ignore */ }
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
      removeWorktree(wt.path, wt.branch);
      queries.markWorktreeCleaned(wt.id);
      cleaned++;
    } catch { /* skip */ }
  }

  cleanupOrphanedWorktrees();
  return cleaned;
}
