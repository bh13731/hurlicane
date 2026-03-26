import { execSync } from 'child_process';
import type { EyeConfig, OrchestratorClient, TemplateBinding, TemplateFilter } from './types.js';
import type { CreateJobRequest } from '../../shared/types.js';
// resolveWorktree is no longer needed — worktrees are created at dispatch time

export function extractFilterFields(
  eventType: string,
  payload: any,
  author: string,
  botName: string,
): Record<string, string> {
  const fields: Record<string, string> = {};

  const prAuthor = payload.pull_request?.user?.login ?? payload.issue?.user?.login;
  if (prAuthor) {
    fields['pr_author'] = prAuthor;
    fields['pr_author_is_self'] = prAuthor === author ? 'true' : 'false';
  }

  if (payload.sender?.login) {
    fields['sender'] = payload.sender.login;
    fields['sender_is_self'] = payload.sender.login === author ? 'true' : 'false';
  }

  const pr = payload.pull_request;
  if (pr) {
    fields['pr_draft'] = pr.draft ? 'true' : 'false';
  }

  if ((eventType === 'pull_request_review' || eventType === 'pr_update') && payload.review) {
    fields['review_state'] = payload.review.state ?? '';
    const hasBody = !!(payload.review.body && payload.review.body.trim());
    fields['review_has_body'] = hasBody ? 'true' : 'false';
  }

  if (eventType === 'check_suite' && payload.check_suite) {
    fields['check_conclusion'] = payload.check_suite.conclusion ?? '';
    fields['check_name'] = payload.check_suite.app?.name ?? '';
  }
  if (eventType === 'check_run' && payload.check_run) {
    fields['check_conclusion'] = payload.check_run.conclusion ?? '';
    fields['check_name'] = payload.check_run.name ?? '';
  }

  if (botName) {
    const prefix = `[${botName.replace(/^\[|\]$/g, '')}]`;
    const body = payload.comment?.body ?? payload.review?.body ?? '';
    fields['is_bot'] = (typeof body === 'string' && body.trimStart().startsWith(prefix)) ? 'true' : 'false';
  } else {
    fields['is_bot'] = 'false';
  }

  return fields;
}

export function filtersPass(filters: TemplateFilter[], fields: Record<string, string>): boolean {
  for (const f of filters) {
    const actual = fields[f.field] ?? '';
    if (f.op === 'eq' && actual !== f.value) return false;
    if (f.op === 'neq' && actual === f.value) return false;
  }
  return true;
}

export interface ProcessEventResult {
  type: 'job';
  title: string;
  count: number;
}

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

  const prompts = await client.getPrompts();
  const fields = extractFilterFields(eventType, payload, config.author, prompts.botName);

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

  if (eventType === 'issue_comment' && fields['pr_draft'] === undefined && repoName && prNum) {
    try {
      const isDraft = execSync(
        `gh pr view ${JSON.stringify(prNum)} --repo ${JSON.stringify(repoName)} --json isDraft --jq .isDraft`,
        { timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] },
      ).toString().trim();
      fields['pr_draft'] = isDraft === 'true' ? 'true' : 'false';
    } catch { /* gh CLI failed — leave unset */ }
  }

  if (repoName && prNum && !fields['pr_state']) {
    try {
      const state = execSync(
        `gh pr view ${JSON.stringify(prNum)} --repo ${JSON.stringify(repoName)} --json state --jq .state`,
        { timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] },
      ).toString().trim().toLowerCase();
      fields['pr_state'] = state;
    } catch { /* gh CLI failed — leave unset */ }
  }

  const bindings = prompts.eventTemplates[eventType] ?? [];
  if (bindings.length === 0) {
    console.log(`[eye] no template bindings for ${eventType}, skipping`);
    return null;
  }

  const matchingBindings = bindings.filter(b => filtersPass(b.filters, fields));
  if (matchingBindings.length === 0) {
    console.log(`[eye] no bindings matched filters for ${eventType} (fields: ${JSON.stringify(fields)})`);
    return null;
  }

  // Resolve repo by name and set repoId + branch on the job request
  if (repoName && branch) {
    const repo = await client.getRepoByName(repoName);
    if (repo) {
      jobReq.repoId = repo.id;
      jobReq.branch = branch;
      console.log(`[eye] resolved repo "${repoName}" → ${repo.id}, branch: ${branch}`);
    } else {
      console.log(`[eye] repo "${repoName}" not registered, skipping repo/branch`);
    }
  }

  let firstTitle: string | null = null;
  let created = 0;

  for (const binding of matchingBindings) {
    console.log(`[eye] binding: templateId=${binding.templateId}`);

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
