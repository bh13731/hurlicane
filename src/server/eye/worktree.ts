import { execSync } from 'child_process';
import type { OrchestratorClient } from './types.js';

export interface WorktreeResult {
  workDir: string;
  branch: string;
  isNew: boolean;
}

function isBranchPrClosed(repoName: string, branch: string): boolean {
  try {
    const output = execSync(
      `gh pr view ${JSON.stringify(branch)} --repo ${JSON.stringify(repoName)} --json state --jq .state`,
      { timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).toString().trim();
    return output === 'MERGED' || output === 'CLOSED';
  } catch {
    return false;
  }
}

export async function resolveWorktree(
  client: OrchestratorClient,
  repoName: string,
  branch: string,
): Promise<WorktreeResult | null> {
  if (!repoName || !branch) return null;

  const repo = await client.getRepoByName(repoName);
  if (!repo) {
    console.log(`[eye] repo "${repoName}" not registered, skipping worktree`);
    return null;
  }

  const existing = await client.getWorktreeByBranch(branch);
  if (existing) {
    console.log(`[eye] reusing existing worktree for branch ${branch}: ${existing.path}`);
    return { workDir: existing.path, branch: existing.branch, isNew: false };
  }

  if (isBranchPrClosed(repoName, branch)) {
    console.log(`[eye] PR for branch ${branch} is merged/closed, skipping worktree creation`);
    return null;
  }

  const wt = await client.createWorktree(branch, repo.id, true);
  if (!wt) {
    console.log(`[eye] worktree creation failed for ${branch}`);
    return null;
  }

  return { workDir: wt.path, branch: wt.branch, isNew: true };
}
