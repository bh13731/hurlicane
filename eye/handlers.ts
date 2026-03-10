import { execSync } from 'child_process';
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
    model: 'claude-opus-4-6',
    context,
  };
}

// ─── Event Handlers ─────────────────────────────────────────────────────────
//
// Each handler returns either a CreateJobRequest (matched) or a reason string
// explaining why the event was ignored.
// Filtration (author, conclusion, draft state, etc.) is handled by template
// binding filters in middleware — handlers only do structural validation and dedup.

type HandlerResult = CreateJobRequest | string;

function handleCheckSuite(
  payload: any,
  config: EyeConfig,
): HandlerResult {
  if (payload.action !== 'completed') return `action "${payload.action}" (want "completed")`;
  const suite = payload.check_suite;
  if (!suite) return 'no check_suite in payload';

  const repo = payload.repository?.full_name;
  if (!repo) return 'no repo in payload';

  const prs: any[] = suite.pull_requests ?? [];
  if (prs.length === 0) return 'no linked PRs';

  const pr = prs[0];
  const prNum = pr.number;

  const dedupKey = `ci:${repo}#${prNum}:${suite.head_sha ?? suite.id}`;
  if (isDuplicate(dedupKey)) return 'duplicate';

  const name = suite.app?.name ?? 'CI';
  const conclusion = suite.conclusion ?? 'unknown';
  const title = `CI: ${name} ${conclusion} on ${repo}#${prNum}`;
  const description = [
    `CI check suite "${name}" completed on ${repo}#${prNum} (branch: ${pr.head?.ref ?? 'unknown'}).`,
    `Conclusion: ${conclusion}.`,
    conclusion === 'failure' ? `Investigate the failure and push a fix.` : `Review the results.`,
  ].join('\n');

  return buildJob(config, title, description, 5, {
    repo,
    pr: String(prNum),
    branch: pr.head?.ref ?? '',
    check_suite_id: String(suite.id),
  });
}

function handleCheckRun(
  payload: any,
  config: EyeConfig,
): HandlerResult {
  if (payload.action !== 'completed') return `action "${payload.action}" (want "completed")`;
  const run = payload.check_run;
  if (!run) return 'no check_run in payload';

  const repo = payload.repository?.full_name;
  if (!repo) return 'no repo in payload';

  const prs: any[] = run.pull_requests ?? [];
  if (prs.length === 0) return 'no linked PRs';

  const pr = prs[0];
  const prNum = pr.number;

  const dedupKey = `ci:${repo}#${prNum}:${run.head_sha ?? run.id}`;
  if (isDuplicate(dedupKey)) return 'duplicate';

  const name = run.name ?? 'CI';
  const conclusion = run.conclusion ?? 'unknown';
  const title = `CI: ${name} ${conclusion} on ${repo}#${prNum}`;
  const description = [
    `CI check run "${name}" completed on ${repo}#${prNum} (branch: ${pr.head?.ref ?? 'unknown'}).`,
    `Conclusion: ${conclusion}.`,
    conclusion === 'failure' ? `Investigate the failure and push a fix.` : `Review the results.`,
  ].join('\n');

  return buildJob(config, title, description, 5, {
    repo,
    pr: String(prNum),
    branch: pr.head?.ref ?? '',
    check_run_id: String(run.id),
  });
}

/**
 * When a check_suite completes successfully, query GitHub to see if ALL suites
 * on that commit have passed. If so, send a Slack notification.
 */
async function checkAllSuitesPassed(
  payload: any,
  config: EyeConfig,
  client: OrchestratorClient,
): Promise<void> {
  const suite = payload.check_suite;
  if (!suite || suite.conclusion !== 'success') return;

  const repo = payload.repository?.full_name;
  const sha = suite.head_sha;
  if (!repo || !sha) return;

  const prs: any[] = suite.pull_requests ?? [];
  if (prs.length === 0) return;

  const prNum = prs[0].number;
  const branch = prs[0].head?.ref ?? '';

  const dedupKey = `all-checks:${repo}#${prNum}:${sha}`;
  if (isDuplicate(dedupKey)) return;

  try {
    const output = execSync(
      `gh api repos/${repo}/commits/${sha}/check-suites --jq '.check_suites[] | (.status + ":" + (.conclusion // "null"))'`,
      { timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).toString().trim();

    const entries = output.split('\n').filter(Boolean);
    if (entries.length === 0) return;

    // Every suite must be completed — skip if any are still queued/in_progress
    const allCompleted = entries.every(e => e.startsWith('completed:'));
    if (!allCompleted) return;

    const conclusions = entries.map(e => e.split(':')[1]);

    // All must be "success" or "neutral" (skipped checks are fine)
    const allPassed = conclusions.every(c => c === 'success' || c === 'neutral');
    if (!allPassed) return;

    console.log(`[eye] all checks passed for ${repo}#${prNum} (${sha.slice(0, 7)})`);

    // Send Slack notification via orchestrator
    try {
      const baseUrl = config.orchestratorUrl;
      await fetch(`${baseUrl}/api/slack/notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'all_checks_passed',
          repo,
          pr: prNum,
          branch,
          sha: sha.slice(0, 7),
        }),
      });
    } catch (err) {
      console.error('[eye] failed to send all-checks-passed notification:', err);
    }

    logEvent({
      ts: Date.now(),
      event_type: 'check_suite',
      action: 'all_passed',
      repo,
      author: config.author,
      decision: 'ran',
      job_title: `All checks passed: ${repo}#${prNum}`,
      detail: `${conclusions.length} suites, sha=${sha.slice(0, 7)}`,
    });
  } catch (err) {
    console.error('[eye] failed to query check suites:', err);
  }
}

/**
 * Fetch inline comments for a review via gh CLI.
 * Returns a formatted string of inline comments, or empty string if none/failure.
 */
function fetchReviewComments(repo: string, prNum: number | string, reviewId: string | number, botPrefix?: string): string {
  try {
    // Fetch all PR comments so we can resolve line numbers for replies via in_reply_to_id
    const allCommentsJson = execSync(
      `gh api repos/${repo}/pulls/${prNum}/comments --paginate`,
      { timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).toString().trim();
    const allComments: any[] = allCommentsJson ? JSON.parse(allCommentsJson) : [];
    const lineById = new Map<number, { path: string; line: number | null }>();
    for (const c of allComments) {
      lineById.set(c.id, { path: c.path, line: c.line ?? c.original_line ?? c.start_line ?? null });
    }

    // Fetch comments for this specific review
    const reviewCommentsJson = execSync(
      `gh api repos/${repo}/pulls/${prNum}/reviews/${reviewId}/comments`,
      { timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).toString().trim();
    const reviewComments: any[] = reviewCommentsJson ? JSON.parse(reviewCommentsJson) : [];

    // Filter out comments from our own bot
    const filtered = botPrefix
      ? reviewComments.filter(c => !c.body?.trimStart().startsWith(botPrefix))
      : reviewComments;

    return filtered.map(c => {
      let line: number | string = c.line ?? c.original_line ?? c.start_line ?? c.position ?? '?';
      // For replies, look up the parent comment's line number
      if (line === '?' && c.in_reply_to_id) {
        const parent = lineById.get(c.in_reply_to_id);
        if (parent?.line) line = parent.line;
      }
      return `${c.path}:${line} — ${c.body}`;
    }).join('\n');
  } catch {
    return '';
  }
}

function handlePullRequestReview(
  payload: any,
  config: EyeConfig,
  botPrefix?: string,
): HandlerResult {
  const review = payload.review;
  const pr = payload.pull_request;
  const repo = payload.repository?.full_name;
  if (!review || !pr || !repo) return 'missing review/pr/repo';

  if (payload.action !== 'submitted') return `action "${payload.action}" (want "submitted")`;

  const reviewer = review.user?.login;
  const prNum = pr.number;
  const state = review.state ?? 'unknown';

  const dedupKey = `review:${repo}#${prNum}:${review.id}`;
  if (isDuplicate(dedupKey)) return 'duplicate';

  const inlineComments = fetchReviewComments(repo, prNum, review.id, botPrefix);

  const priority = state === 'changes_requested' ? 4 : 1;
  const title = state === 'changes_requested'
    ? `Address review on ${repo}#${prNum}`
    : `Review ${state} on ${repo}#${prNum}`;

  const parts = [
    `${reviewer} left a ${state} review on ${repo}#${prNum} (branch: ${pr.head?.ref ?? 'unknown'}).`,
  ];
  if (review.body) parts.push(`\nReview comment:\n${review.body}`);
  if (inlineComments) parts.push(`\nInline comments:\n${inlineComments}`);
  if (state === 'changes_requested') {
    parts.push(`\nAddress the requested changes and push a fix.`);
  } else {
    parts.push(`\nReview and respond or address the comment as needed.`);
  }

  return buildJob(config, title, parts.join('\n'), priority, {
    repo,
    pr: String(prNum),
    branch: pr.head?.ref ?? '',
    reviewer: reviewer ?? '',
    review_id: String(review.id),
  });
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

  // Fetch PR branch via gh CLI (issue_comment payload doesn't include it)
  let branch = '';
  try {
    const branchResult = execSync(
      `gh pr view ${prNum} --repo ${repo} --json headRefName --jq .headRefName`,
      { timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).toString().trim();
    branch = branchResult || '';
  } catch (err: any) {
    console.warn(`[eye] failed to fetch PR branch for ${repo}#${prNum}:`, err.message);
  }

  const dedupKey = `comment:${repo}#${prNum}:${comment.id}`;
  if (isDuplicate(dedupKey)) return 'duplicate';

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

  if (payload.action === 'converted_to_draft') {
    // Just clear dedup — don't cancel agents or clean worktrees
    clearDedupPrefix(`ci:${repo}#${prNum}:`);
    clearDedupPrefix(`review:${repo}#${prNum}:`);
    clearDedupPrefix(`review-comment:${repo}#${prNum}:`);
    clearDedupPrefix(`comment:${repo}#${prNum}:`);
    return `cleaned dedup for ${repo}#${prNum} (converted to draft)`;
  }

  if (payload.action === 'closed') {
    // Cleanup all dedup entries for this PR
    clearDedupPrefix(`ci:${repo}#${prNum}:`);
    clearDedupPrefix(`review:${repo}#${prNum}:`);
    clearDedupPrefix(`review-comment:${repo}#${prNum}:`);
    clearDedupPrefix(`comment:${repo}#${prNum}:`);

    // Cleanup worktree + cancel running agents on this branch
    const branch = pr.head?.ref;
    const merged = pr.merged === true;
    if (branch) {
      const cleanup = await client.cleanupBranch(branch, merged);
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

  // Check if all suites passed — runs even when check_suite is disabled for failures
  if (eventType === 'check_suite' && payload.check_suite?.conclusion === 'success') {
    checkAllSuitesPassed(payload, config, client).catch(err =>
      console.error('[eye] checkAllSuitesPassed error:', err)
    );
  }

  // Check if this event type is disabled via config toggles
  const prompts = await client.getPrompts();
  if (prompts.disabledEvents.includes(eventType)) {
    return null;
  }

  // Get a CreateJobRequest from the appropriate handler
  const botPrefix = prompts.botName ? `[${prompts.botName.replace(/^\[|\]$/g, '')}]` : undefined;
  let handlerResult: HandlerResult;
  switch (eventType) {
    case 'check_suite':
      handlerResult = handleCheckSuite(payload, config);
      break;
    case 'check_run':
      handlerResult = handleCheckRun(payload, config);
      break;
    case 'pull_request_review':
      handlerResult = handlePullRequestReview(payload, config, botPrefix);
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
