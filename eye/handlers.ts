import type { EyeConfig } from './config.js';
import type { OrchestratorClient } from './orchestrator.js';
import type { CreateJobRequest } from '../src/shared/types.js';
import { processEvent } from './middleware.js';

// ─── Recent Events Log ─────────────────────────────────────────────────────

export type Decision = 'ignored' | 'debated' | 'ran';

export interface EyeEvent {
  ts: number;
  event_type: string;
  action: string;
  repo: string;
  author: string;
  decision: Decision;
  job_title: string | null;
  detail: string | null;
}

const MAX_EVENTS = 200;
const recentEvents: EyeEvent[] = [];

function logEvent(e: EyeEvent): void {
  recentEvents.push(e);
  if (recentEvents.length > MAX_EVENTS) recentEvents.shift();
}

export function getRecentEvents(): EyeEvent[] {
  return recentEvents;
}

// ─── Dedup ──────────────────────────────────────────────────────────────────

const DEDUP_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** key → timestamp of when it was recorded */
const seen = new Map<string, number>();

function isDuplicate(key: string): boolean {
  const now = Date.now();
  const ts = seen.get(key);
  if (ts && now - ts < DEDUP_TTL_MS) return true;
  seen.set(key, now);
  return false;
}

function clearDedupPrefix(prefix: string): void {
  for (const key of seen.keys()) {
    if (key.startsWith(prefix)) seen.delete(key);
  }
}

/** Periodically purge expired entries */
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of seen) {
    if (now - ts >= DEDUP_TTL_MS) seen.delete(key);
  }
}, 60_000).unref();

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildJob(
  _config: EyeConfig,
  title: string,
  description: string,
  priority: number,
  context?: Record<string, string>,
): CreateJobRequest {
  return {
    title,
    description,
    priority,
    context,
  };
}

// ─── Event Handlers ─────────────────────────────────────────────────────────
//
// Each handler returns either a CreateJobRequest (matched) or a reason string
// explaining why the event was ignored.

type HandlerResult = CreateJobRequest | string;

function handleCheckSuite(
  payload: any,
  config: EyeConfig,
): HandlerResult {
  if (payload.action !== 'completed') return `action "${payload.action}" (want "completed")`;
  const suite = payload.check_suite;
  if (!suite) return 'no check_suite in payload';
  if (suite.conclusion !== 'failure') return `suite ${suite.conclusion ?? 'pending'}`;

  const repo = payload.repository?.full_name;
  if (!repo) return 'no repo in payload';

  const sender = payload.sender?.login;
  if (sender !== config.author) return `sender "${sender}" is not author`;

  const prs: any[] = suite.pull_requests ?? [];
  if (prs.length === 0) return 'no linked PRs';

  for (const pr of prs) {
    const prNum = pr.number;
    const dedupKey = `ci:${repo}#${prNum}:${suite.head_sha ?? suite.id}`;
    if (isDuplicate(dedupKey)) continue;

    const name = suite.app?.name ?? 'CI';
    const title = `Fix CI: ${name} on ${repo}#${prNum}`;
    const description = [
      `CI check suite "${name}" failed on ${repo}#${prNum} (branch: ${pr.head?.ref ?? 'unknown'}).`,
      `Conclusion: ${suite.conclusion}.`,
      `Investigate the failure and push a fix.`,
    ].join('\n');

    return buildJob(config, title, description, 5, {
      repo,
      pr: String(prNum),
      branch: pr.head?.ref ?? '',
      check_suite_id: String(suite.id),
    });
  }
  return 'duplicate';
}

function handleCheckRun(
  payload: any,
  config: EyeConfig,
): HandlerResult {
  if (payload.action !== 'completed') return `action "${payload.action}" (want "completed")`;
  const run = payload.check_run;
  if (!run) return 'no check_run in payload';
  if (run.conclusion !== 'failure') return `run ${run.conclusion ?? 'pending'}`;

  const repo = payload.repository?.full_name;
  if (!repo) return 'no repo in payload';

  const sender = payload.sender?.login;
  if (sender !== config.author) return `sender "${sender}" is not author`;

  const prs: any[] = run.pull_requests ?? [];
  if (prs.length === 0) return 'no linked PRs';

  for (const pr of prs) {
    const prNum = pr.number;
    const dedupKey = `ci:${repo}#${prNum}:${run.head_sha ?? run.id}`;
    if (isDuplicate(dedupKey)) continue;

    const name = run.name ?? 'CI';
    const title = `Fix CI: ${name} on ${repo}#${prNum}`;
    const description = [
      `CI check run "${name}" failed on ${repo}#${prNum} (branch: ${pr.head?.ref ?? 'unknown'}).`,
      `Conclusion: ${run.conclusion}.`,
      `Investigate the failure and push a fix.`,
    ].join('\n');

    return buildJob(config, title, description, 5, {
      repo,
      pr: String(prNum),
      branch: pr.head?.ref ?? '',
      check_run_id: String(run.id),
    });
  }
  return 'duplicate';
}

function handlePullRequestReview(
  payload: any,
  config: EyeConfig,
): HandlerResult {
  const review = payload.review;
  const pr = payload.pull_request;
  const repo = payload.repository?.full_name;
  if (!review || !pr || !repo) return 'missing review/pr/repo';

  const reviewer = review.user?.login;
  const prNum = pr.number;
  const state = review.state ?? 'unknown';

  if (payload.action === 'submitted' && state === 'changes_requested') {
    const dedupKey = `review:${repo}#${prNum}:${review.id}`;
    if (isDuplicate(dedupKey)) return 'duplicate';

    const title = `Address review on ${repo}#${prNum}`;
    const description = [
      `${reviewer} requested changes on ${repo}#${prNum} (branch: ${pr.head?.ref ?? 'unknown'}).`,
      review.body ? `\nReview comment:\n${review.body}` : '',
      `\nAddress the requested changes and push a fix.`,
    ].join('\n');

    return buildJob(config, title, description, 4, {
      repo,
      pr: String(prNum),
      branch: pr.head?.ref ?? '',
      reviewer: reviewer ?? '',
      review_id: String(review.id),
    });
  }

  if (payload.action === 'submitted' && state === 'commented') {
    const dedupKey = `review-comment:${repo}#${prNum}:${review.id}`;
    if (isDuplicate(dedupKey)) return 'duplicate';

    const title = `Review comment on ${repo}#${prNum}`;
    const description = [
      `${reviewer} left a review comment on ${repo}#${prNum} (branch: ${pr.head?.ref ?? 'unknown'}).`,
      `\nComment:\n${review.body}`,
      `\nReview and respond or address the comment as needed.`,
    ].join('\n');

    return buildJob(config, title, description, 1, {
      repo,
      pr: String(prNum),
      branch: pr.head?.ref ?? '',
      reviewer: reviewer ?? '',
      review_id: String(review.id),
    });
  }

  return `review state "${state}"`;
}

async function handleIssueComment(
  payload: any,
  config: EyeConfig,
): Promise<HandlerResult> {
  if (payload.action !== 'created') return `action "${payload.action}" (want "created")`;

  const comment = payload.comment;
  const issue = payload.issue;
  const repo = payload.repository?.full_name;
  if (!comment || !issue || !repo) return 'missing comment/issue/repo';

  if (!issue.pull_request) return 'not a PR comment';

  const commenter = comment.user?.login;

  const prNum = issue.number;
  const dedupKey = `comment:${repo}#${prNum}:${comment.id}`;
  if (isDuplicate(dedupKey)) return 'duplicate';

  // Fetch PR branch via gh CLI (issue_comment payload doesn't include it)
  let branch = '';
  try {
    const { execSync } = await import('child_process');
    branch = execSync(
      `gh pr view ${prNum} --repo ${repo} --json headRefName --jq .headRefName`,
      { timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).toString().trim();
  } catch (err: any) {
    console.warn(`[eye] failed to fetch PR branch for ${repo}#${prNum}:`, err.message);
  }

  const title = `Reply to comment on ${repo}#${prNum}`;
  const description = [
    `${commenter} commented on ${repo}#${prNum}${branch ? ` (branch: ${branch})` : ''}.`,
    `\nComment:\n${comment.body ?? '(empty)'}`,
    `\nReview and respond to the comment as needed.`,
  ].join('\n');

  return buildJob(config, title, description, 2, {
    repo,
    pr: String(prNum),
    branch,
    commenter: commenter ?? '',
    comment_id: String(comment.id),
  });
}

async function handlePullRequestMeta(payload: any, _config: EyeConfig, client: OrchestratorClient): Promise<string | null> {
  const pr = payload.pull_request;
  const repo = payload.repository?.full_name;
  if (!pr || !repo) return null;

  const prNum = pr.number;
  const prefix = `ci:${repo}#${prNum}:`;

  if (payload.action === 'synchronize') {
    // New push — reset CI dedup so new failures create jobs
    clearDedupPrefix(prefix);
    return `reset CI dedup for ${repo}#${prNum}`;
  }

  if (payload.action === 'closed' || (payload.action === 'converted_to_draft')) {
    // Cleanup all dedup entries for this PR
    clearDedupPrefix(`ci:${repo}#${prNum}:`);
    clearDedupPrefix(`review:${repo}#${prNum}:`);
    clearDedupPrefix(`review-comment:${repo}#${prNum}:`);
    clearDedupPrefix(`comment:${repo}#${prNum}:`);

    // Cleanup worktree + cancel running agents on this branch
    const branch = pr.head?.ref;
    if (branch) {
      const cleanup = await client.cleanupBranch(branch);
      if (cleanup?.found) {
        return `cleaned dedup + worktree for ${repo}#${prNum} (cancelled ${cleanup.cancelledJobs} jobs)`;
      }
    }

    return `cleaned dedup for ${repo}#${prNum}`;
  }

  return null;
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

export async function dispatch(
  eventType: string,
  payload: any,
  config: EyeConfig,
  client: OrchestratorClient,
): Promise<string | null> {
  const repo = payload.repository?.full_name ?? '';
  const action = payload.action ?? '';
  const author = payload.sender?.login ?? '';

  // Handle PR meta events (dedup resets + worktree cleanup) — no job creation
  if (eventType === 'pull_request') {
    return await handlePullRequestMeta(payload, config, client);
  }

  // Skip events on branches/PRs not owned by the configured author
  const prOwner = payload.pull_request?.user?.login ?? payload.issue?.user?.login;
  if (prOwner && prOwner !== config.author) {
    return null;
  }

  // Check if this event type is disabled via config toggles
  const prompts = await client.getPrompts();
  if (prompts.disabledEvents.includes(eventType)) {
    return null;
  }

  // Get a CreateJobRequest from the appropriate handler
  let handlerResult: HandlerResult;
  switch (eventType) {
    case 'check_suite':
      handlerResult = handleCheckSuite(payload, config);
      break;
    case 'check_run':
      handlerResult = handleCheckRun(payload, config);
      break;
    case 'pull_request_review':
      handlerResult = handlePullRequestReview(payload, config);
      break;
    case 'issue_comment':
      handlerResult = await handleIssueComment(payload, config);
      break;
    default:
      return null;
  }

  // String result = reason the handler ignored this event
  if (typeof handlerResult === 'string') {
    logEvent({
      ts: Date.now(),
      event_type: eventType,
      action,
      repo,
      author,
      decision: 'ignored',
      job_title: null,
      detail: handlerResult,
    });
    return null;
  }

  const jobReq = handlerResult;

  // Pass through middleware: worktree resolution + complexity evaluation + dispatch
  const result = await processEvent(client, config, eventType, payload, jobReq);

  if (result) {
    logEvent({
      ts: Date.now(),
      event_type: eventType,
      action,
      repo,
      author,
      decision: result.type === 'debate' ? 'debated' : 'ran',
      job_title: result.title,
      detail: `type=${result.type}`,
    });
  }

  return result?.title ?? null;
}

export function getDedupStats(): { size: number } {
  return { size: seen.size };
}
