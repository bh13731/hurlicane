import { execSync } from 'child_process';
import type { EyeConfig } from './config.js';
import type { OrchestratorClient, TemplateBinding, TemplateFilter, DebateBindingConfig } from './orchestrator.js';
import type { CreateJobRequest } from '../src/shared/types.js';
import { extractSignals, evaluateComplexity } from './complexity.js';
import { resolveWorktree } from './worktree.js';

/**
 * Extract filter-evaluable fields from the webhook payload.
 * Returns a flat record of field → string value.
 */
function extractFilterFields(
  eventType: string,
  payload: any,
  author: string,
  botName: string,
): Record<string, string> {
  const fields: Record<string, string> = {};

  // PR author (owner of the PR)
  const prAuthor = payload.pull_request?.user?.login ?? payload.issue?.user?.login;
  if (prAuthor) {
    fields['pr_author'] = prAuthor;
    fields['pr_author_is_self'] = prAuthor === author ? 'true' : 'false';
  }
  // For check_suite/check_run, PR author isn't directly in payload — fetched below in processEvent

  // Sender (who triggered this event)
  if (payload.sender?.login) {
    fields['sender'] = payload.sender.login;
    fields['sender_is_self'] = payload.sender.login === author ? 'true' : 'false';
  }

  // PR draft status — available on most event types
  const pr = payload.pull_request;
  if (pr) {
    fields['pr_draft'] = pr.draft ? 'true' : 'false';
  }

  // Review state
  if (eventType === 'pull_request_review' && payload.review) {
    fields['review_state'] = payload.review.state ?? '';
    const hasBody = !!(payload.review.body && payload.review.body.trim());
    fields['review_has_body'] = hasBody ? 'true' : 'false';
  }

  // Check conclusion
  if (eventType === 'check_suite' && payload.check_suite) {
    fields['check_conclusion'] = payload.check_suite.conclusion ?? '';
    fields['check_name'] = payload.check_suite.app?.name ?? '';
  }
  if (eventType === 'check_run' && payload.check_run) {
    fields['check_conclusion'] = payload.check_run.conclusion ?? '';
    fields['check_name'] = payload.check_run.name ?? '';
  }

  // Bot detection — whether the comment/review body starts with bot prefix
  if (botName) {
    const prefix = `[${botName.replace(/^\[|\]$/g, '')}]`;
    const body = payload.comment?.body ?? payload.review?.body ?? '';
    fields['is_bot'] = (typeof body === 'string' && body.trimStart().startsWith(prefix)) ? 'true' : 'false';
  } else {
    fields['is_bot'] = 'false';
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

  // ── Fetch configurable prompts ──
  const prompts = await client.getPrompts();

  // Extract filter fields from payload
  const fields = extractFilterFields(eventType, payload, config.author, prompts.botName);

  // For check_suite/check_run, PR author isn't in the payload — fetch via gh CLI
  if ((eventType === 'check_suite' || eventType === 'check_run') && !fields['pr_author'] && repoName && prNum) {
    try {
      const prAuthor = execSync(
        `gh pr view ${JSON.stringify(prNum)} --repo ${JSON.stringify(repoName)} --json author --jq .author.login`,
        { timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] },
      ).toString().trim();
      if (prAuthor) {
        fields['pr_author'] = prAuthor;
        fields['pr_author_is_self'] = prAuthor === config.author ? 'true' : 'false';
      }
    } catch { /* gh CLI failed — leave unset */ }
  }

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

  // Fetch PR state (open/merged/closed) for filter evaluation
  if (repoName && prNum && !fields['pr_state']) {
    try {
      const state = execSync(
        `gh pr view ${JSON.stringify(prNum)} --repo ${JSON.stringify(repoName)} --json state --jq .state`,
        { timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] },
      ).toString().trim().toLowerCase();
      fields['pr_state'] = state; // "open", "merged", "closed"
    } catch { /* gh CLI failed — leave unset */ }
  }

  // Get per-event template bindings — create a job for each that passes filters
  const bindings = prompts.eventTemplates[eventType] ?? [];

  // If no bindings configured, skip (no templates = no jobs)
  if (bindings.length === 0) {
    console.log(`[eye] no template bindings for ${eventType}, skipping`);
    return null;
  }

  const matchingBindings = bindings.filter(b => filtersPass(b.filters, fields));
  if (matchingBindings.length === 0) {
    console.log(`[eye] no bindings matched filters for ${eventType} (fields: ${JSON.stringify(fields)})`);
    return null;
  }

  // Resolve worktree for branch isolation
  const wt = await resolveWorktree(client, repoName, branch);
  if (wt) {
    console.log(`[eye] worktree resolved: ${wt.workDir} (branch: ${wt.branch}, new: ${wt.isNew})`);
    jobReq.workDir = wt.workDir;
  } else {
    console.log(`[eye] no worktree resolved for branch="${branch}"`);
  }

  // Evaluate complexity with default thresholds (used when binding mode is 'auto')
  const signals = extractSignals(eventType, payload);
  const autoComplexity = evaluateComplexity(signals);

  let firstTitle: string | null = null;
  let created = 0;
  let anyDebate = false;

  for (const binding of matchingBindings) {
    const bindingMode = binding.mode ?? 'auto';
    const useDebate = bindingMode === 'debate' || (bindingMode === 'auto' && autoComplexity === 'debate');

    if (useDebate) {
      const dc: DebateBindingConfig = binding.debateConfig ?? {};
      const result = await client.createDebate({
        title: jobReq.title ?? `Debate: ${jobReq.description.slice(0, 40)}`,
        task: jobReq.description,
        claudeModel: dc.claudeModel ?? 'sonnet',
        codexModel: dc.codexModel ?? 'codex',
        maxRounds: dc.maxRounds ?? 3,
        workDir: jobReq.workDir,
        postActionPrompt: dc.postActionPrompt ?? 'Implement the agreed solution from the debate.',
        postActionRole: dc.postActionRole ?? 'claude',
        postActionVerification: dc.postActionVerification ?? true,
        templateId: binding.templateId || undefined,
      });
      if (result) {
        if (!firstTitle) firstTitle = result.debate.title;
        created++;
        anyDebate = true;
      }
    } else {
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
  }

  if (created === 0) return null;
  return { type: anyDebate ? 'debate' : 'job', title: firstTitle!, count: created };
}
