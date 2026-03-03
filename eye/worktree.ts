import type { OrchestratorClient } from './orchestrator.js';

export interface WorktreeResult {
  workDir: string;
  branch: string;
  isNew: boolean;
}

/**
 * Find or create a worktree for the given repo+branch.
 * Returns null if the repo isn't registered or worktree creation fails.
 */
export async function resolveWorktree(
  client: OrchestratorClient,
  repoName: string,
  branch: string,
): Promise<WorktreeResult | null> {
  if (!repoName || !branch) return null;

  // 1. Look up the repo by name
  const repo = await client.getRepoByName(repoName);
  if (!repo) {
    console.log(`[eye] repo "${repoName}" not registered, skipping worktree`);
    return null;
  }

  // 2. Check for an existing active worktree on this branch
  const existing = await client.getWorktreeByBranch(branch);
  if (existing) {
    console.log(`[eye] reusing existing worktree for branch ${branch}: ${existing.path}`);
    return { workDir: existing.path, branch: existing.branch, isNew: false };
  }

  // 3. Create a new worktree (trackExisting=true to check out the remote branch)
  const wt = await client.createWorktree(branch, repo.path, true);
  if (!wt) {
    console.log(`[eye] worktree creation failed for ${branch}, falling back to repo path`);
    return { workDir: repo.path, branch, isNew: false };
  }

  return { workDir: wt.path, branch: wt.branch, isNew: true };
}
