import { execSync } from 'child_process';
import type { EyeConfig } from './config.js';
import type { OrchestratorClient } from './orchestrator.js';
import type { CreateJobRequest } from '../src/shared/types.js';
import { extractSignals, evaluateComplexity } from './complexity.js';
import { resolveWorktree } from './worktree.js';

export interface ProcessEventResult {
  type: 'job' | 'debate';
  title: string;
  count: number;
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
    return { type: 'debate', title: result.debate.title, count: 1 };
  }

  // Get per-event templates — create a job for each, or one with no template
  const eventTemplateIds = prompts.eventTemplates[eventType] ?? [];
  const templateList = eventTemplateIds.length > 0 ? eventTemplateIds : [undefined];

  let firstTitle: string | null = null;
  let created = 0;

  for (const templateId of templateList) {
    const req: CreateJobRequest = { ...jobReq };
    if (templateId) {
      req.templateId = templateId;
    }
    const result = await client.createJob(req);
    if (result) {
      if (!firstTitle) firstTitle = result.title;
      created++;
    }
  }

  if (created === 0) return null;
  return { type: 'job', title: firstTitle!, count: created };
}
