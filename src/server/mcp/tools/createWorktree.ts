import { z } from 'zod';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import path from 'path';
import * as queries from '../../db/queries.js';

const WORKTREES_DIR = path.resolve('data', 'worktrees');

export const createWorktreeSchema = z.object({
  repo_name: z.string().optional().describe('Ignored — the worktree is always created for the repo the agent is currently running in.'),
  branch: z.string().optional().describe('Branch name for the new worktree. Auto-generated if omitted.'),
  from_remote: z.boolean().optional().describe('If true, check out an existing remote branch instead of creating a new one from main.'),
});

/**
 * Resolve the repo that the calling agent is running in, based on its job's work_dir.
 * The work_dir may be the repo root itself or a worktree inside the repo.
 */
function resolveAgentRepo(agentId: string): ReturnType<typeof queries.getRepoByPath> {
  const agent = queries.getAgentById(agentId);
  if (!agent) return null;
  const job = queries.getJobById(agent.job_id);
  const workDir = job?.work_dir;
  if (!workDir) return null;

  // Check if work_dir is a known worktree — if so, use its repo_id
  const wt = queries.getWorktreeByPath(workDir);
  if (wt?.repo_id) return queries.getRepoById(wt.repo_id);

  // Otherwise check if it's a repo path directly
  return queries.getRepoByPath(workDir);
}

export async function createWorktreeHandler(agentId: string, input: z.infer<typeof createWorktreeSchema>): Promise<string> {
  const { branch, from_remote } = input;

  // Always resolve the repo from the agent's own working directory
  let repo = resolveAgentRepo(agentId);
  if (!repo) {
    // Fallback: if agent has no work_dir yet (e.g. top-level orchestrator), use first repo
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

  // Check if a worktree for this branch already exists in this repo
  const existing = queries.getWorktreeByBranch(sanitized, repo.id);
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

    const baseBranch = repo.default_branch || 'main';

    // Pull latest base branch
    try { execSync(`git pull origin ${JSON.stringify(baseBranch)}`, { cwd: repo.path, timeout: 30_000, stdio: 'pipe' }); } catch { /* ignore */ }

    // Ensure base branch exists
    try {
      execSync(`git rev-parse ${JSON.stringify(baseBranch)}`, { cwd: repo.path, timeout: 5_000, stdio: 'pipe' });
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
      // Create new branch from base branch
      execSync(`git worktree add ${JSON.stringify(worktreeDir)} -b ${JSON.stringify(sanitized)} ${JSON.stringify(baseBranch)}`, {
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
