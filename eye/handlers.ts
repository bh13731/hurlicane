import type { EyeConfig } from './config.js';
import type { OrchestratorClient } from './orchestrator.js';
import type { CreateJobRequest } from '../src/shared/types.js';
import { processEvent } from './middleware.js';

// ─── Recent Events Log ─────────────────────────────────────────────────────

export interface EyeEvent {
  ts: number;
  event_type: string;
  action: string;
  repo: string;
  result: 'job_created' | 'debate_created' | 'ignored' | 'error' | 'meta';
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

function handleCheckSuite(
  payload: any,
  config: EyeConfig,
): CreateJobRequest | null {
  if (payload.action !== 'completed') return null;
  const suite = payload.check_suite;
  if (!suite || suite.conclusion !== 'failure') return null;

  const repo = payload.repository?.full_name;
  if (!repo) return null;

  const prs: any[] = suite.pull_requests ?? [];
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
  return null;
}

function handleCheckRun(
  payload: any,
  config: EyeConfig,
): CreateJobRequest | null {
  if (payload.action !== 'completed') return null;
  const run = payload.check_run;
  if (!run || run.conclusion !== 'failure') return null;

  const repo = payload.repository?.full_name;
  if (!repo) return null;

  const prs: any[] = run.pull_requests ?? [];
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
  return null;
}

function handlePullRequestReview(
  payload: any,
  config: EyeConfig,
): CreateJobRequest | null {
  const review = payload.review;
  const pr = payload.pull_request;
  const repo = payload.repository?.full_name;
  if (!review || !pr || !repo) return null;

  // Ignore self-reviews
  const reviewer = review.user?.login;
  if (reviewer === config.author) return null;

  const prNum = pr.number;

  if (payload.action === 'submitted' && review.state === 'changes_requested') {
    const dedupKey = `review:${repo}#${prNum}:${review.id}`;
    if (isDuplicate(dedupKey)) return null;

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

  if (payload.action === 'submitted' && review.state === 'commented') {
    if (!review.body?.trim()) return null;

    const dedupKey = `review-comment:${repo}#${prNum}:${review.id}`;
    if (isDuplicate(dedupKey)) return null;

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

  return null;
}

function handleIssueComment(
  payload: any,
  config: EyeConfig,
): CreateJobRequest | null {
  if (payload.action !== 'created') return null;

  const comment = payload.comment;
  const issue = payload.issue;
  const repo = payload.repository?.full_name;
  if (!comment || !issue || !repo) return null;

  // Only handle PR comments (issues with pull_request field)
  if (!issue.pull_request) return null;

  // Ignore self-comments
  const commenter = comment.user?.login;
  if (commenter === config.author) return null;

  const prNum = issue.number;
  const dedupKey = `comment:${repo}#${prNum}:${comment.id}`;
  if (isDuplicate(dedupKey)) return null;

  const title = `Reply to comment on ${repo}#${prNum}`;
  const description = [
    `${commenter} commented on ${repo}#${prNum}.`,
    `\nComment:\n${comment.body ?? '(empty)'}`,
    `\nReview and respond to the comment as needed.`,
  ].join('\n');

  return buildJob(config, title, description, 2, {
    repo,
    pr: String(prNum),
    commenter: commenter ?? '',
    comment_id: String(comment.id),
  });
}

function handlePullRequestMeta(payload: any, _config: EyeConfig): string | null {
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

  // Handle PR meta events (dedup resets) — no job creation
  if (eventType === 'pull_request') {
    const result = handlePullRequestMeta(payload, config);
    if (result) {
      logEvent({ ts: Date.now(), event_type: eventType, action, repo, result: 'meta', job_title: null, detail: result });
    }
    return result;
  }

  // Get a CreateJobRequest from the appropriate handler
  let jobReq: CreateJobRequest | null;
  switch (eventType) {
    case 'check_suite':
      jobReq = handleCheckSuite(payload, config);
      break;
    case 'check_run':
      jobReq = handleCheckRun(payload, config);
      break;
    case 'pull_request_review':
      jobReq = handlePullRequestReview(payload, config);
      break;
    case 'issue_comment':
      jobReq = handleIssueComment(payload, config);
      break;
    default:
      return null;
  }

  if (!jobReq) {
    logEvent({
      ts: Date.now(),
      event_type: eventType,
      action,
      repo,
      result: 'ignored',
      job_title: null,
      detail: null,
    });
    return null;
  }

  // Pass through middleware: worktree resolution + complexity evaluation + dispatch
  const result = await processEvent(client, config, eventType, payload, jobReq);

  logEvent({
    ts: Date.now(),
    event_type: eventType,
    action,
    repo,
    result: result ? (result.type === 'debate' ? 'debate_created' : 'job_created') : 'error',
    job_title: result?.title ?? null,
    detail: result ? `type=${result.type}` : 'processEvent returned null',
  });

  return result?.title ?? null;
}

export function getDedupStats(): { size: number } {
  return { size: seen.size };
}
