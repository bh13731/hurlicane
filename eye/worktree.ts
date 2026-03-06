import { execSync } from 'child_process';
import type { OrchestratorClient } from './orchestrator.js';

export interface WorktreeResult {
  workDir: string;
  branch: string;
  isNew: boolean;
}

/**
 * Check if the PR for a branch has been merged or closed via gh CLI.
 * Returns true if the PR is in a terminal state and no new worktree should be created.
 */
function isBranchPrClosed(repoName: string, branch: string): boolean {
  try {
    const output = execSync(
      `gh pr view ${JSON.stringify(branch)} --repo ${JSON.stringify(repoName)} --json state --jq .state`,
      { timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).toString().trim();
    return output === 'MERGED' || output === 'CLOSED';
  } catch {
    // No PR exists or gh failed — allow worktree creation
    return false;
  }
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

  // 3. Before creating a new worktree, check if the branch's PR is already merged/closed.
  //    After a PR is merged, GitHub still sends trailing events (check_suite, check_run, etc.)
  //    which would otherwise recreate the worktree that was just cleaned up.
  if (isBranchPrClosed(repoName, branch)) {
    console.log(`[eye] PR for branch ${branch} is merged/closed, skipping worktree creation`);
    return null;
  }

  // 4. Create a new worktree (trackExisting=true to check out the remote branch)
  const wt = await client.createWorktree(branch, repo.id, true);
  if (!wt) {
    console.log(`[eye] worktree creation failed for ${branch}`);
    return null;
  }

  return { workDir: wt.path, branch: wt.branch, isNew: true };
}
