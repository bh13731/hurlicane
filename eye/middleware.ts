import { execSync } from 'child_process';
import type { EyeConfig } from './config.js';
import type { OrchestratorClient, TemplateBinding, TemplateFilter } from './orchestrator.js';
import type { CreateJobRequest } from '../src/shared/types.js';
import { extractSignals, evaluateComplexity } from './complexity.js';
import { resolveWorktree } from './worktree.js';

/**
 * Extract filter-evaluable fields from the webhook payload.
 * Returns a flat record of field → string value.
 */
function extractFilterFields(eventType: string, payload: any): Record<string, string> {
  const fields: Record<string, string> = {};

  // PR draft status — available on most event types
  const pr = payload.pull_request;
  if (pr) {
    fields['pr_draft'] = pr.draft ? 'true' : 'false';
  }
  // For issue_comment, draft info isn't in payload — checked via gh CLI in handler,
  // but we can check the issue labels/state
  if (eventType === 'issue_comment' && payload.issue?.pull_request) {
    // issue_comment doesn't carry draft status; we fetch it separately below
  }

  // Review state
  if (eventType === 'pull_request_review' && payload.review) {
    fields['review_state'] = payload.review.state ?? '';
  }

  // Check/suite name
  if (eventType === 'check_suite' && payload.check_suite) {
    fields['check_name'] = payload.check_suite.app?.name ?? '';
  }
  if (eventType === 'check_run' && payload.check_run) {
    fields['check_name'] = payload.check_run.name ?? '';
  }

  return fields;
}

/**
 * Evaluate whether all filters in a binding pass against the extracted fields.
 * All filters are AND'd — every one must pass.
 */
function filtersPass(filters: TemplateFilter[], fields: Record<string, string>): boolean {
  for (const f of filters) {
    const actual = fields[f.field] ?? '';
    if (f.op === 'eq' && actual !== f.value) return false;
    if (f.op === 'neq' && actual === f.value) return false;
  }
  return true;
}

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

  // Get per-event template bindings — create a job for each that passes filters
  const bindings = prompts.eventTemplates[eventType] ?? [];
  const fields = extractFilterFields(eventType, payload);

  // For issue_comment, pr_draft isn't in the payload — fetch via gh CLI
  if (eventType === 'issue_comment' && fields['pr_draft'] === undefined && repoName && prNum) {
    try {
      const isDraft = execSync(
        `gh pr view ${JSON.stringify(prNum)} --repo ${JSON.stringify(repoName)} --json isDraft --jq .isDraft`,
        { timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] },
      ).toString().trim();
      fields['pr_draft'] = isDraft === 'true' ? 'true' : 'false';
    } catch { /* gh CLI failed — leave unset */ }
  }

  // If no bindings, create one job with no template
  const matchingBindings = bindings.length > 0
    ? bindings.filter(b => filtersPass(b.filters, fields))
    : [{ templateId: undefined, filters: [] }] as { templateId: string | undefined; filters: TemplateFilter[] }[];

  let firstTitle: string | null = null;
  let created = 0;

  for (const binding of matchingBindings) {
    const req: CreateJobRequest = { ...jobReq };
    if (binding.templateId) {
      req.templateId = binding.templateId;
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
