#!/usr/bin/env node
/**
 * GitHub PR Monitor
 * Polls all repos every 10 minutes, tracks events, writes state to state.json
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, 'state.json');
const REPOS = [
  'lightsparkdev/webdev',
  'lightsparkdev/spark',
];
const AUTHOR = 'kphurley7';
const POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

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

  state.lastCheck = new Date().toISOString();
  saveState(state);
  console.log(`[${new Date().toISOString()}] Done. ${state.items.length} unacked item(s).`);
}

await poll();
setInterval(poll, POLL_INTERVAL_MS);
console.log(`\nMonitor running. Polling every ${POLL_INTERVAL_MS / 60000} minutes.`);
console.log(`State file: ${STATE_FILE}`);
