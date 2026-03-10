import { execSync } from 'child_process';
import type { EyeConfig } from './config.js';
import type { OrchestratorClient } from './orchestrator.js';
import type { CreateJobRequest } from '../src/shared/types.js';
import { extractSignals, evaluateComplexity } from './complexity.js';
import { resolveWorktree } from './worktree.js';

export interface ProcessEventResult {
  type: 'job' | 'debate';
  title: string;
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
  const prNum = jobReq.context?.pr ?? '';

  console.log(`[eye] processEvent: ${eventType} repo=${repoName} branch="${branch}"`);

  // Skip events for PRs that have already been merged or closed.
  // After a merge, GitHub sends trailing check_suite/check_run events that would
  // otherwise create new jobs and worktrees for a branch that's already done.
  if (repoName && prNum) {
    try {
      const state = execSync(
        `gh pr view ${JSON.stringify(prNum)} --repo ${JSON.stringify(repoName)} --json state --jq .state`,
        { timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] },
      ).toString().trim();
      if (state === 'MERGED' || state === 'CLOSED') {
        console.log(`[eye] PR ${repoName}#${prNum} is ${state}, skipping event`);
        return null;
      }
    } catch {
      // gh CLI failed — continue processing
    }
  }

  // ── Fetch configurable prompts ──
  const prompts = await client.getPrompts();

  // Assign per-event template if configured
  const eventTemplate = prompts.eventTemplates[eventType];
  if (eventTemplate) {
    jobReq.templateId = eventTemplate;
  }

  // Resolve worktree for branch isolation
  const wt = await resolveWorktree(client, repoName, branch);
  if (wt) {
    console.log(`[eye] worktree resolved: ${wt.workDir} (branch: ${wt.branch}, new: ${wt.isNew})`);
    jobReq.workDir = wt.workDir;
  } else {
    console.log(`[eye] no worktree resolved for branch="${branch}"`);
  }

  // Evaluate complexity with default thresholds
  const signals = extractSignals(eventType, payload);
  const complexity = evaluateComplexity(signals);

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
