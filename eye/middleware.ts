import type { EyeConfig } from './config.js';
import type { OrchestratorClient } from './orchestrator.js';
import type { CreateJobRequest } from '../src/shared/types.js';
import { extractSignals, evaluateComplexity, parseComplexityConfig } from './complexity.js';
import { resolveWorktree } from './worktree.js';

export interface ProcessEventResult {
  type: 'job' | 'debate' | 'skipped';
  title: string;
}

/**
 * Parse "Skip repos matching: pattern" lines from the skip prompt.
 */
function parseSkipPatterns(prompt: string): string[] {
  const patterns: string[] = [];
  for (const line of prompt.split('\n')) {
    const match = line.match(/skip\s+repos?\s+matching:\s*(.+)/i);
    if (match) {
      patterns.push(...match[1].split(',').map(p => p.trim()).filter(Boolean));
    }
  }
  return patterns;
}

/**
 * Test whether a repo name matches a glob-like pattern (supports trailing *).
 */
function matchesPattern(repoName: string, pattern: string): boolean {
  if (pattern.endsWith('/*')) {
    return repoName.startsWith(pattern.slice(0, -1));
  }
  if (pattern.endsWith('*')) {
    return repoName.startsWith(pattern.slice(0, -1));
  }
  return repoName === pattern;
}

/**
 * Check whether this event should be skipped entirely.
 * Runs before complexity evaluation.
 */
async function shouldSkip(
  client: OrchestratorClient,
  repoName: string,
  skipPrompt: string,
): Promise<string | null> {
  if (!repoName) return 'no repo in payload';

  // Check custom skip patterns from prompt
  const patterns = parseSkipPatterns(skipPrompt);
  for (const pattern of patterns) {
    if (matchesPattern(repoName, pattern)) {
      return `repo "${repoName}" matches skip pattern "${pattern}"`;
    }
  }

  // Default: skip if repo isn't registered in the orchestrator
  const repo = await client.getRepoByName(repoName);
  if (!repo) return `repo "${repoName}" not registered`;
  return null;
}

/**
 * Takes a CreateJobRequest from a handler, resolves worktree, evaluates
 * complexity, then dispatches as either a simple job or a debate.
 */
export async function processEvent(
  client: OrchestratorClient,
  config: EyeConfig,
  eventType: string,
  payload: any,
  jobReq: CreateJobRequest,
): Promise<ProcessEventResult | null> {
  const repoName = payload.repository?.full_name ?? '';
  const branch = jobReq.context?.branch ?? '';

  // ── Fetch configurable prompts ──
  const prompts = await client.getPrompts();

  // ── Skip filter (before complexity evaluation) ──
  const skipReason = await shouldSkip(client, repoName, prompts.skipPrompt);
  if (skipReason) {
    console.log(`[eye] skipping ${eventType}: ${skipReason}`);
    return { type: 'skipped', title: skipReason };
  }

  // Resolve worktree for branch isolation
  const wt = await resolveWorktree(client, repoName, branch);
  if (wt) {
    jobReq.workDir = wt.workDir;
  }

  // Evaluate complexity with configurable thresholds
  const signals = extractSignals(eventType, payload);
  const complexityConfig = parseComplexityConfig(prompts.discussionPrompt);
  const complexity = evaluateComplexity(signals, complexityConfig);

  if (complexity === 'debate') {
    const result = await client.createDebate({
      title: jobReq.title ?? `Debate: ${jobReq.description.slice(0, 40)}`,
      task: jobReq.description,
      claudeModel: 'sonnet',
      codexModel: 'codex',
      maxRounds: 3,
      workDir: jobReq.workDir,
      postActionPrompt: 'Implement the agreed solution from the debate.',
      postActionRole: 'claude',
    });
    if (!result) return null;
    return { type: 'debate', title: result.debate.title };
  }

  // Simple job
  const result = await client.createJob(jobReq);
  if (!result) return null;
  return { type: 'job', title: result.title };
}
