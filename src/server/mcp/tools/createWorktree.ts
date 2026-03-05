import { z } from 'zod';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import path from 'path';
import * as queries from '../../db/queries.js';
import { notifyWorktreeCreated } from '../../services/SlackNotifier.js';

const WORKTREES_DIR = path.resolve('data', 'worktrees');

export const createWorktreeSchema = z.object({
  repo_name: z.string().optional().describe('Name of the registered repo. If omitted, uses the first registered repo.'),
  branch: z.string().optional().describe('Branch name for the new worktree. Auto-generated if omitted.'),
  from_remote: z.boolean().optional().describe('If true, check out an existing remote branch instead of creating a new one from main.'),
});

export async function createWorktreeHandler(agentId: string, input: z.infer<typeof createWorktreeSchema>): Promise<string> {
  const { repo_name, branch, from_remote } = input;

  // Resolve the repo
  let repo;
  if (repo_name) {
    repo = queries.getRepoByName(repo_name);
    if (!repo) {
      const repos = queries.listRepos();
      return JSON.stringify({
        success: false,
        error: `Repo "${repo_name}" not found. Available repos: ${repos.map(r => r.name).join(', ') || '(none)'}`,
      });
    }
  } else {
    const repos = queries.listRepos();
    if (repos.length === 0) {
      return JSON.stringify({ success: false, error: 'No repos registered.' });
    }
    repo = repos[0];
  }

  // Generate branch name if not provided
  const shortId = randomUUID().slice(0, 8);
  const sanitized = branch
    ? branch.replace(/[^a-zA-Z0-9._\-/]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-./]+|[-./]+$/g, '')
    : `orchestrator/agent-${shortId}`;

  if (!sanitized) {
    return JSON.stringify({ success: false, error: 'Branch name is empty after sanitization.' });
  }

  // Check if a worktree for this branch already exists
  const existing = queries.getWorktreeByBranch(sanitized);
  if (existing) {
    return JSON.stringify({
      success: true,
      worktree_path: existing.path,
      branch: existing.branch,
      already_existed: true,
    });
  }

  try {
    const worktreeDir = path.join(WORKTREES_DIR, shortId);

    // Pull latest main
    try { execSync('git pull origin main', { cwd: repo.path, timeout: 30_000, stdio: 'pipe' }); } catch { /* ignore */ }

    // Ensure main exists
    try {
      execSync('git rev-parse main', { cwd: repo.path, timeout: 5_000, stdio: 'pipe' });
    } catch {
      execSync('git commit --allow-empty -m "Initial commit"', { cwd: repo.path, timeout: 10_000, stdio: 'pipe' });
    }

    if (from_remote) {
      // Fetch and check out existing remote branch
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
      // Create new branch from main
      execSync(`git worktree add ${JSON.stringify(worktreeDir)} -b ${JSON.stringify(sanitized)} main`, {
        cwd: repo.path,
        timeout: 30_000,
      });
    }

    // Record in DB
    queries.insertWorktree({
      id: shortId,
      repo_id: repo.id,
      agent_id: agentId,
      job_id: '',
      path: worktreeDir,
      branch: sanitized,
    });

    notifyWorktreeCreated(sanitized);

    return JSON.stringify({
      success: true,
      worktree_path: worktreeDir,
      branch: sanitized,
      already_existed: false,
    });
  } catch (err: any) {
    return JSON.stringify({ success: false, error: err.message || 'Failed to create worktree' });
  }
}
