#!/usr/bin/env node
/**
 * GitHub PR Monitor
 * Polls all repos every 10 minutes, tracks events, writes state to state.json
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHmac, timingSafeEqual } from 'crypto';
import { createServer } from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, 'state.json');
const REPOS = [
  'lightsparkdev/webdev',
  'lightsparkdev/spark',
];
const AUTHOR = 'kphurley7';
const POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

// --- CLI arg parsing ---
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(name);
  return idx !== -1 ? (args[idx + 1] || true) : undefined;
}
const WEBHOOK_MODE = args.includes('--webhook');
const WEBHOOK_PORT = parseInt(getArg('--webhook-port'), 10) || 4567;
const WEBHOOK_SECRET = getArg('--webhook-secret') || process.env.GITHUB_WEBHOOK_SECRET;

function loadState() {
  if (existsSync(STATE_FILE)) {
    try {
      return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    } catch {}
  }
  return {
    items: [],          // unacked notification items
    nextId: 1,          // next notification number
    seenComments: {},   // key: "repo#prNum#commentId" -> true
    seenReviews: {},    // key: "repo#prNum#reviewId" -> true
    seenCiStatus: {},   // key: "repo#prNum" -> "success|failure|pending"
    knownPRs: {},       // key: "repo#prNum" -> { title, updatedAt }
    lastCheck: null,
  };
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function gh(args) {
  try {
    return JSON.parse(execSync(`gh ${args} 2>/dev/null`, { encoding: 'utf8' }));
  } catch {
    return null;
  }
}

function ghRaw(args) {
  try {
    return execSync(`gh ${args} 2>/dev/null`, { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function addItem(state, type, repo, prNum, prTitle, message) {
  const id = state.nextId++;
  state.items.push({ id, type, repo, prNum, prTitle, message, createdAt: new Date().toISOString() });
  console.log(`[NEW #${id}] (${type}) ${repo}#${prNum}: ${message}`);
}

async function checkRepo(repo, state) {
  const prs = gh(`pr list --repo "${repo}" --state open --author "${AUTHOR}" --json number,title,isDraft,updatedAt,headRefName,baseRefName`);
  if (!prs || prs.length === 0) return;

  for (const pr of prs) {
    if (pr.isDraft) continue;

    const key = `${repo}#${pr.number}`;
    const isNew = !state.knownPRs[key];
    state.knownPRs[key] = { title: pr.title, updatedAt: pr.updatedAt };

    const prDetail = gh(`pr view ${pr.number} --repo "${repo}" --json statusCheckRollup,reviews,comments`);

    if (prDetail) {
      // --- CI/CD status ---
      const rollup = prDetail.statusCheckRollup || [];
      const failing = rollup.filter(c => c.conclusion === 'FAILURE' || c.conclusion === 'TIMED_OUT');
      const allDone = rollup.length > 0 && rollup.every(c =>
        c.conclusion !== null && c.state !== 'IN_PROGRESS' && c.state !== 'QUEUED' && c.state !== 'WAITING'
      );

      let ciStatus = 'unknown';
      if (rollup.length === 0) ciStatus = 'none';
      else if (failing.length > 0) ciStatus = 'failure';
      else if (!allDone) ciStatus = 'pending';
      else ciStatus = 'success';

      const prevCi = state.seenCiStatus[key];
      if (ciStatus === 'failure' && prevCi !== 'failure') {
        const failNames = failing.map(c => c.name).join(', ');
        addItem(state, 'ci_failure', repo, pr.number, pr.title,
          `CI/CD FAILING: ${failNames || 'checks failed'}`);
      }
      state.seenCiStatus[key] = ciStatus;

      // --- Comments ---
      const comments = prDetail.comments || [];
      for (const c of comments) {
        const ck = `${key}#comment#${c.id}`;
        if (!state.seenComments[ck]) {
          state.seenComments[ck] = true;
          if (!isNew && c.author?.login !== AUTHOR) {
            addItem(state, 'comment', repo, pr.number, pr.title,
              `New comment from @${c.author?.login || 'unknown'}: "${c.body?.slice(0, 100)}${(c.body?.length || 0) > 100 ? '…' : ''}"`);
          }
        }
      }

      // --- Reviews ---
      const reviews = prDetail.reviews || [];
      for (const r of reviews) {
        const rk = `${key}#review#${r.id}`;
        if (!state.seenReviews[rk]) {
          state.seenReviews[rk] = true;
          if (!isNew && r.author?.login !== AUTHOR) {
            const stateLabel =
              r.state === 'CHANGES_REQUESTED' ? 'CHANGES REQUESTED' :
              r.state === 'APPROVED' ? 'APPROVED' :
              r.state === 'COMMENTED' ? 'review comment' : r.state;
            addItem(state, 'review', repo, pr.number, pr.title,
              `${stateLabel} by @${r.author?.login || 'unknown'}${r.body ? ': "' + r.body.slice(0, 80) + (r.body.length > 80 ? '…' : '') + '"' : ''}`);
          }
        }
      }

      // Seed seen sets for new PRs so first poll doesn't spam
      if (isNew) {
        for (const c of comments) state.seenComments[`${key}#comment#${c.id}`] = true;
        for (const r of reviews) state.seenReviews[`${key}#review#${r.id}`] = true;
        console.log(`[SEEDED] ${repo}#${pr.number}: "${pr.title}" (${comments.length} comments, ${reviews.length} reviews)`);
      }
    }
  }
}

function purgeMergedAndClosed(state) {
  // Collect unique PR keys from current items
  const prKeys = [...new Set(state.items.map(i => `${i.repo}#${i.prNum}`))];
  const removedKeys = [];

  for (const key of prKeys) {
    const [repo, numStr] = key.split('#');
    const stateStr = ghRaw(`pr view ${numStr} --repo "${repo}" --json state --jq '.state'`);
    if (stateStr === 'MERGED' || stateStr === 'CLOSED') {
      removedKeys.push(key);
    }
  }

  if (removedKeys.length > 0) {
    const before = state.items.length;
    state.items = state.items.filter(i => !removedKeys.includes(`${i.repo}#${i.prNum}`));
    console.log(`[PURGE] Removed ${before - state.items.length} item(s) for ${removedKeys.length} merged/closed PR(s): ${removedKeys.join(', ')}`);
  }
}

// --- Webhook mode ---

function verifySignature(rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  const expected = 'sha256=' + createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function handleCheckSuite(repo, payload) {
  const suite = payload.check_suite;
  if (suite.conclusion !== 'failure' && suite.conclusion !== 'timed_out') return false;

  // Find PRs associated with this check suite
  const prs = suite.pull_requests || [];
  const state = loadState();
  let changed = false;

  for (const pr of prs) {
    const key = `${repo}#${pr.number}`;
    if (!state.knownPRs[key]) continue; // not authored by AUTHOR
    const prevCi = state.seenCiStatus[key];
    if (prevCi === 'failure') continue; // already reported
    state.seenCiStatus[key] = 'failure';
    addItem(state, 'ci_failure', repo, pr.number, state.knownPRs[key].title,
      `CI/CD FAILING: ${suite.app?.name || 'checks'} — ${suite.conclusion}`);
    changed = true;
  }

  if (changed) saveState(state);
  return changed;
}

function handleCheckRun(repo, payload) {
  const run = payload.check_run;
  if (run.conclusion !== 'failure' && run.conclusion !== 'timed_out') return false;

  const prs = run.pull_requests || [];
  const state = loadState();
  let changed = false;

  for (const pr of prs) {
    const key = `${repo}#${pr.number}`;
    if (!state.knownPRs[key]) continue;
    const prevCi = state.seenCiStatus[key];
    if (prevCi === 'failure') continue;
    state.seenCiStatus[key] = 'failure';
    addItem(state, 'ci_failure', repo, pr.number, state.knownPRs[key].title,
      `CI/CD FAILING: ${run.name || 'check failed'}`);
    changed = true;
  }

  if (changed) saveState(state);
  return changed;
}

function handlePullRequestReview(repo, payload) {
  const pr = payload.pull_request;
  const review = payload.review;

  if (pr.user.login !== AUTHOR) return false;
  if (pr.draft) return false;

  const key = `${repo}#${pr.number}`;
  const state = loadState();

  // Ensure PR is tracked
  if (!state.knownPRs[key]) {
    state.knownPRs[key] = { title: pr.title, updatedAt: pr.updated_at };
  }

  const rk = `${key}#review#${review.id}`;
  if (state.seenReviews[rk]) return false;
  state.seenReviews[rk] = true;

  if (review.user.login === AUTHOR) {
    saveState(state);
    return false;
  }

  const reviewState = (review.state || '').toUpperCase();
  const stateLabel =
    reviewState === 'CHANGES_REQUESTED' ? 'CHANGES REQUESTED' :
    reviewState === 'APPROVED' ? 'APPROVED' :
    reviewState === 'COMMENTED' ? 'review comment' : reviewState;

  addItem(state, 'review', repo, pr.number, pr.title,
    `${stateLabel} by @${review.user.login}${review.body ? ': "' + review.body.slice(0, 80) + (review.body.length > 80 ? '…' : '') + '"' : ''}`);

  saveState(state);
  return true;
}

function handleIssueComment(repo, payload) {
  const issue = payload.issue;
  const comment = payload.comment;

  // Only PR comments
  if (!issue.pull_request) return false;

  const prNum = issue.number;
  const key = `${repo}#${prNum}`;
  const state = loadState();

  // Check if this PR is one of ours (by knownPRs or issue author)
  if (!state.knownPRs[key] && issue.user.login !== AUTHOR) return false;

  // Ensure PR is tracked
  if (!state.knownPRs[key]) {
    state.knownPRs[key] = { title: issue.title, updatedAt: issue.updated_at };
  }

  const ck = `${key}#comment#${comment.id}`;
  if (state.seenComments[ck]) return false;
  state.seenComments[ck] = true;

  // Don't notify for our own comments
  if (comment.user.login === AUTHOR) {
    saveState(state);
    return false;
  }

  addItem(state, 'comment', repo, prNum, state.knownPRs[key].title,
    `New comment from @${comment.user.login}: "${comment.body?.slice(0, 100)}${(comment.body?.length || 0) > 100 ? '…' : ''}"`);

  saveState(state);
  return true;
}

function handlePullRequest(repo, payload) {
  const pr = payload.pull_request;
  const action = payload.action;

  if (pr.user.login !== AUTHOR) return false;

  const key = `${repo}#${pr.number}`;
  const state = loadState();

  if (action === 'opened' || action === 'reopened' || action === 'ready_for_review') {
    if (!pr.draft) {
      state.knownPRs[key] = { title: pr.title, updatedAt: pr.updated_at };
      console.log(`[WEBHOOK] Tracking ${key}: "${pr.title}"`);
    }
    saveState(state);
    return true;
  }

  if (action === 'closed') {
    // Purge items and tracking for this PR
    const before = state.items.length;
    state.items = state.items.filter(i => !(i.repo === repo && i.prNum === pr.number));
    if (state.items.length < before) {
      console.log(`[WEBHOOK PURGE] Removed ${before - state.items.length} item(s) for closed ${key}`);
    }
    delete state.knownPRs[key];
    delete state.seenCiStatus[key];
    // Clean up seen* entries for this PR
    for (const k of Object.keys(state.seenComments)) {
      if (k.startsWith(key + '#')) delete state.seenComments[k];
    }
    for (const k of Object.keys(state.seenReviews)) {
      if (k.startsWith(key + '#')) delete state.seenReviews[k];
    }
    console.log(`[WEBHOOK] Untracked closed ${key}`);
    saveState(state);
    return true;
  }

  if (action === 'synchronize') {
    // New push — reset CI so new failures are reported
    if (state.seenCiStatus[key]) {
      state.seenCiStatus[key] = 'pending';
      console.log(`[WEBHOOK] Reset CI status for ${key} (new push)`);
    }
    if (state.knownPRs[key]) {
      state.knownPRs[key].updatedAt = pr.updated_at;
    }
    saveState(state);
    return true;
  }

  if (action === 'converted_to_draft') {
    delete state.knownPRs[key];
    console.log(`[WEBHOOK] Untracked draft ${key}`);
    saveState(state);
    return true;
  }

  return false;
}

function handleWebhookEvent(eventType, payload) {
  const repoFullName = payload.repository?.full_name;
  if (!repoFullName || !REPOS.includes(repoFullName)) {
    console.log(`[WEBHOOK] Ignored event for repo: ${repoFullName || 'unknown'}`);
    return;
  }

  console.log(`[WEBHOOK] ${eventType} event for ${repoFullName}`);

  switch (eventType) {
    case 'check_suite':
      if (payload.action === 'completed') handleCheckSuite(repoFullName, payload);
      break;
    case 'check_run':
      if (payload.action === 'completed') handleCheckRun(repoFullName, payload);
      break;
    case 'pull_request_review':
      if (payload.action === 'submitted') handlePullRequestReview(repoFullName, payload);
      break;
    case 'issue_comment':
      if (payload.action === 'created') handleIssueComment(repoFullName, payload);
      break;
    case 'pull_request':
      handlePullRequest(repoFullName, payload);
      break;
    default:
      console.log(`[WEBHOOK] Unhandled event type: ${eventType}`);
  }
}

function startWebhookServer() {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (req.method === 'POST' && req.url === '/') {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks);
        const signature = req.headers['x-hub-signature-256'];

        if (!verifySignature(rawBody, signature)) {
          console.log('[WEBHOOK] Signature verification failed');
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid signature' }));
          return;
        }

        // Ack immediately
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));

        // Process event
        try {
          const payload = JSON.parse(rawBody.toString('utf8'));
          const eventType = req.headers['x-github-event'];
          handleWebhookEvent(eventType, payload);
        } catch (e) {
          console.error('[WEBHOOK] Error processing event:', e.message);
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  server.listen(WEBHOOK_PORT, () => {
    console.log(`[WEBHOOK] Server listening on port ${WEBHOOK_PORT}`);
    console.log(`[WEBHOOK] Health: http://localhost:${WEBHOOK_PORT}/health`);
    console.log(`[WEBHOOK] Watching repos: ${REPOS.join(', ')}`);
    console.log(`State file: ${STATE_FILE}`);
  });

  return server;
}

async function poll() {
  const state = loadState();
  console.log(`\n[${new Date().toISOString()}] Polling ${REPOS.length} repos...`);

  for (const repo of REPOS) {
    try {
      await checkRepo(repo, state);
    } catch (e) {
      console.error(`Error checking ${repo}:`, e.message);
    }
  }

  // Purge items for PRs that have been merged or closed since last poll
  try {
    purgeMergedAndClosed(state);
  } catch (e) {
    console.error('Error purging merged/closed PRs:', e.message);
  }

  state.lastCheck = new Date().toISOString();
  saveState(state);
  console.log(`[${new Date().toISOString()}] Done. ${state.items.length} unacked item(s).`);
}

if (WEBHOOK_MODE) {
  if (!WEBHOOK_SECRET) {
    console.error('Error: --webhook-secret or GITHUB_WEBHOOK_SECRET env var is required in webhook mode');
    process.exit(1);
  }
  startWebhookServer();
} else {
  await poll();
  setInterval(poll, POLL_INTERVAL_MS);
  console.log(`\nMonitor running. Polling every ${POLL_INTERVAL_MS / 60000} minutes.`);
  console.log(`State file: ${STATE_FILE}`);
}
