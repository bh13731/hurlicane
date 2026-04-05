/**
 * WorkflowFinalization — PR creation and worktree cleanup for autonomous agent runs.
 *
 * Extracted from WorkflowManager.ts. Contains the self-contained finalization
 * cluster: branch push, GitHub PR creation, and worktree removal. Also owns the
 * shared utilities (parseMilestones, ensureWorktreeBranch, updateAndEmit, etc.)
 * that are part of this dependency closure.
 *
 * Invariant: this module MUST NOT import from WorkflowManager.ts.
 */
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import path from 'path';
import { captureWithContext, Sentry } from '../instrument.js';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import type { Job, Workflow } from '../../shared/types.js';
import { validateTransition } from './StateTransitions.js';

// ─── Milestone Parsing ────────────────────────────────────────────────────────

const CHECKBOX_CHECKED = /^[\t ]*[-*][\t ]+\[[xX]\]/;
const CHECKBOX_UNCHECKED = /^[\t ]*[-*][\t ]+\[\s?\]/;

export function parseMilestones(planText: string): { total: number; done: number } {
  let done = 0;
  let unchecked = 0;
  for (const line of planText.split('\n')) {
    if (CHECKBOX_CHECKED.test(line)) done++;
    else if (CHECKBOX_UNCHECKED.test(line)) unchecked++;
  }
  return { total: done + unchecked, done };
}

// ─── Worktree Branch Verification ────────────────────────────────────────────

/**
 * Verify a worktree HEAD is on the expected branch. If drifted, attempt checkout.
 * Returns { ok: true } on success, or { ok: false, error } if checkout fails.
 */
export function ensureWorktreeBranch(
  worktreePath: string,
  expectedBranch: string,
): { ok: true } | { ok: false; error: string } {
  try {
    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: worktreePath, stdio: 'pipe', timeout: 5000,
    }).toString().trim();
    if (currentBranch !== expectedBranch) {
      console.warn(`[worktree] on '${currentBranch}' instead of '${expectedBranch}' — switching`);
      execSync(`git checkout ${JSON.stringify(expectedBranch)}`, {
        cwd: worktreePath, stdio: 'pipe', timeout: 10000,
      });
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message ?? String(err) };
  }
}

// ─── Git Helpers ─────────────────────────────────────────────────────────────

function getRemoteDefaultBranch(cwd: string): string | null {
  try {
    const ref = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
      cwd,
      stdio: 'pipe',
      timeout: 5000,
    }).toString().trim();
    if (!ref.startsWith('refs/remotes/origin/')) return null;
    return ref.slice('refs/remotes/origin/'.length);
  } catch (err) {
    if (isMissingRemoteRefError(err)) return null;
    throw err;
  }
}

function isMissingRemoteRefError(err: unknown): boolean {
  const message = String((err as { message?: string } | null)?.message ?? err ?? '');
  return message.includes('not a symbolic ref')
    || message.includes('bad revision')
    || message.includes('unknown revision')
    || message.includes('ambiguous argument');
}

function countCommitsAgainstBaseRef(cwd: string, baseRef: string): number | null {
  // Verify ref exists before counting — avoids masking real git failures
  // (corrupt objects, ambiguous refs) as "ref missing"
  try {
    execSync(`git rev-parse --verify ${JSON.stringify(baseRef)}`, {
      cwd, stdio: 'pipe', timeout: 5000,
    });
  } catch (err) {
    // Classify: missing ref → try next candidate; transient error → propagate
    const msg = String((err as { message?: string } | null)?.message ?? err ?? '');
    if (msg.includes('Needed a single revision') || msg.includes('not a valid object name') || msg.includes('unknown revision')) {
      return null;
    }
    throw err;
  }

  // ref exists — any rev-list failure is unexpected, let it propagate
  const count = execSync(
    `git rev-list --count HEAD ${JSON.stringify(`^${baseRef}`)}`,
    { cwd, stdio: 'pipe', timeout: 10000 }
  ).toString().trim();
  const parsed = parseInt(count, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function countBranchCommits(cwd: string): number {
  const candidateBaseRefs = new Set<string>();
  const defaultBranch = getRemoteDefaultBranch(cwd);
  if (defaultBranch) candidateBaseRefs.add(`origin/${defaultBranch}`);
  candidateBaseRefs.add('origin/HEAD');

  for (const baseRef of candidateBaseRefs) {
    const count = countCommitsAgainstBaseRef(cwd, baseRef);
    if (count !== null) return count;
  }

  return 0;
}

// ─── PR Creation Outcome ──────────────────────────────────────────────────────

export type WorkflowPrCreationOutcome = 'created' | 'failed_with_publishable_commits' | 'no_publishable_commits';

export function getPrCreationOutcome(workflow: Workflow, prUrl: string | null): WorkflowPrCreationOutcome {
  if (prUrl) return 'created';
  if (!workflow.worktree_path || !workflow.work_dir) return 'no_publishable_commits';

  let hasPublishableCommits = false;
  try {
    hasPublishableCommits = countBranchCommits(workflow.worktree_path) > 0;
  } catch (err: any) {
    console.warn(`[workflow ${workflow.id}] getPrCreationOutcome: git error — preserving worktree as safe default:`, err?.message);
    return 'failed_with_publishable_commits';
  }

  return hasPublishableCommits ? 'failed_with_publishable_commits' : 'no_publishable_commits';
}

// ─── PR Body ─────────────────────────────────────────────────────────────────

export function _buildPrBody(workflow: Workflow, planText: string | null, options?: { partial?: boolean }): string {
  const { total, done } = parseMilestones(planText ?? '');
  const milestoneLines = planText
    ? planText.split('\n')
        .filter(l => /^\s*[-*]\s+\[/.test(l))
        .map(l => {
          const isDone = CHECKBOX_CHECKED.test(l);
          // Strip the checkbox prefix, keeping the milestone title (bold or plain)
          const title = l.replace(/^\s*[-*]\s+\[[xX ]*\]\s*/, '');
          return isDone ? `- Done: ${title}` : `- Pending: ${title}`;
        })
        .join('\n')
    : '';
  const lines = [
    `## ${workflow.title}`,
    '',
  ];
  if (options?.partial) {
    lines.push(`**Partial completion** — ${done}/${total} milestones done. Remaining milestones need manual intervention or resuming the workflow.`);
    lines.push('');
  }
  lines.push(
    `**Task:** ${workflow.task}`,
    '',
    `**Cycles:** ${workflow.current_cycle}/${workflow.max_cycles} · **Milestones:** ${done}/${total} complete`,
    '',
    '## Milestones',
    milestoneLines || '_No plan available_',
  );
  return lines.join('\n');
}

// ─── Blocked Diagnostics ─────────────────────────────────────────────────────

export const BLOCKED_LOG_DIR = path.join(process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : './data', 'blocked-diagnostics');

export function writeBlockedDiagnostic(workflow: Workflow): void {
  // Skip file writes during tests to avoid polluting data/blocked-diagnostics/
  if (process.env.VITEST) return;
  mkdirSync(BLOCKED_LOG_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${ts}_${workflow.id.slice(0, 8)}.md`;

  // Gather context
  const jobs = queries.getJobsForWorkflow(workflow.id);
  const recentJobs = jobs.slice(-10);
  const failedJobs = jobs.filter((j: Job) => j.status === 'failed');
  const recentFailed = failedJobs.slice(-5);

  // Get the last agent error + output tail for each recent failed job
  const LOG_DIR = path.join(process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : './data', 'agent-logs');
  const failedDetails = recentFailed.map((j: Job) => {
    const agents = queries.getAgentsWithJobByJobId(j.id);
    const agent = agents[0];

    // Read last 30 lines of the agent's NDJSON log for the real error
    let logTail = '';
    if (agent) {
      try {
        const logPath = path.join(LOG_DIR, `${agent.id}.ndjson`);
        const raw = readFileSync(logPath, 'utf8');
        const lines = raw.trim().split('\n').slice(-30);
        // Extract text content and errors from NDJSON
        const relevant = lines.map(line => {
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === 'error' || parsed.error) return `[ERROR] ${parsed.error ?? JSON.stringify(parsed)}`;
            if (parsed.type === 'assistant' && parsed.message?.content) {
              const texts = parsed.message.content
                .filter((c: { type: string }) => c.type === 'text')
                .map((c: { text: string }) => c.text);
              if (texts.length > 0) return texts.join('\n').slice(-500);
            }
            if (parsed.type === 'result' && parsed.result) return `[RESULT] ${JSON.stringify(parsed.result).slice(0, 300)}`;
            return null;
          } catch { return `[RAW] ${line.slice(0, 200)}`; }
        }).filter(Boolean);
        logTail = relevant.slice(-10).join('\n');
      } catch { /* log not available */ }
    }

    return {
      job_id: j.id.slice(0, 8),
      title: j.title,
      phase: j.workflow_phase,
      model: j.model,
      error: agent?.error_message ?? 'no agent error recorded',
      exit_code: agent?.exit_code,
      turns: agent?.num_turns,
      cost: agent?.cost_usd,
      agent_id: agent?.id?.slice(0, 8) ?? 'n/a',
      logTail,
    };
  });

  // Get plan note
  let planSnippet = '';
  try {
    const plan = queries.getNote(`workflow/${workflow.id}/plan`);
    if (plan) planSnippet = plan.value.slice(0, 3000);
  } catch { /* ignore */ }

  // Get latest worklog
  let worklogSnippet = '';
  try {
    const notes = queries.listNotes(`workflow/${workflow.id}/worklog`);
    if (notes.length > 0) {
      const latest = notes.sort((a, b) => b.updated_at - a.updated_at)[0];
      worklogSnippet = latest.value.slice(0, 2000);
    }
  } catch { /* ignore */ }

  // Get git state from worktree
  let gitState = '';
  if (workflow.worktree_path) {
    try {
      const status = execSync('git status --short', { cwd: workflow.worktree_path, timeout: 5000 }).toString().trim();
      const lastCommit = execSync('git log --oneline -3', { cwd: workflow.worktree_path, timeout: 5000 }).toString().trim();
      gitState = `### Working tree status\n\`\`\`\n${status || '(clean)'}\n\`\`\`\n\n### Last 3 commits\n\`\`\`\n${lastCommit}\n\`\`\``;
    } catch { gitState = '(git state unavailable)'; }
  }

  const md = `# Workflow Blocked Diagnostic

## Summary
- **Title:** ${workflow.title}
- **ID:** ${workflow.id}
- **Blocked at:** ${new Date().toISOString()}
- **Reason:** ${workflow.blocked_reason ?? 'unknown'}
- **Phase:** ${workflow.current_phase}
- **Cycle:** ${workflow.current_cycle}/${workflow.max_cycles}
- **Milestones:** ${workflow.milestones_done}/${workflow.milestones_total}
- **Implementer model:** ${workflow.implementer_model}
- **Reviewer model:** ${workflow.reviewer_model}
- **Worktree:** ${workflow.worktree_path ?? 'none'} (branch: ${workflow.worktree_branch ?? 'none'})

## Job History (last 10)
| ID | Phase | Status | Model | Title |
|----|-------|--------|-------|-------|
${recentJobs.map((j: Job) => `| ${j.id.slice(0, 8)} | ${j.workflow_phase ?? '-'} | ${j.status} | ${j.model ?? '-'} | ${j.title} |`).join('\n')}

## Failed Jobs (last 5 with details)
${failedDetails.length === 0 ? 'No failed jobs.' : failedDetails.map(f => `### ${f.title}
- **Job ID:** ${f.job_id} | **Agent ID:** ${f.agent_id}
- **Phase:** ${f.phase} | **Model:** ${f.model}
- **Exit code:** ${f.exit_code ?? 'n/a'} | **Turns used:** ${f.turns ?? 'n/a'} | **Cost:** $${f.cost?.toFixed(2) ?? 'n/a'}
- **DB Error:**
\`\`\`
${f.error}
\`\`\`
- **Agent output (last lines):**
\`\`\`
${f.logTail || '(no log output available)'}
\`\`\`
`).join('\n')}

## Total Job Stats
- Total: ${jobs.length}
- Done: ${jobs.filter((j: Job) => j.status === 'done').length}
- Failed: ${failedJobs.length}
- Cancelled: ${jobs.filter((j: Job) => j.status === 'cancelled').length}
- Success rate: ${jobs.length > 0 ? Math.round(100 * jobs.filter((j: Job) => j.status === 'done').length / jobs.length) : 0}%

## Git State
${gitState || '(no worktree configured)'}

## Latest Worklog Entry
\`\`\`
${worklogSnippet || '(no worklog found)'}
\`\`\`

## Plan (truncated)
\`\`\`
${planSnippet || '(no plan note found)'}
\`\`\`
`;

  writeFileSync(path.join(BLOCKED_LOG_DIR, filename), md, 'utf8');
  console.log(`[workflow] wrote blocked diagnostic: ${filename}`);
}

// ─── Update & Emit ────────────────────────────────────────────────────────────

export function updateAndEmit(id: string, fields: Parameters<typeof queries.updateWorkflow>[1]): void {
  let previousStatus: string | undefined;
  if (fields.status) {
    const current = queries.getWorkflowById(id);
    previousStatus = current?.status;
    validateTransition('workflow', previousStatus, fields.status, id);
  }
  const updated = queries.updateWorkflow(id, fields);
  if (!updated) {
    console.warn(`[workflow] updateAndEmit: workflow ${id} not found — DB update returned null`);
    return;
  }
  try {
    socket.emitWorkflowUpdate(updated);
  } catch (emitErr) {
    // Socket failure is non-fatal — the DB write already succeeded
    console.warn(`[workflow] updateAndEmit: socket.emitWorkflowUpdate failed for workflow ${id}:`, emitErr);
  }
  // Blocked transition — write diagnostic and optionally report to Sentry.
  // Only fire on actual transitions (not re-processing already-blocked workflows)
  if (fields.status === 'blocked' && previousStatus !== 'blocked') {
    const reason = fields.blocked_reason ?? updated.blocked_reason ?? 'unknown';
    // Operational blocks are expected workflow states — not Sentry exceptions.
    // Use an allowlist so new block reasons default to being reported.
    const OPERATIONAL_BLOCK_PATTERNS = [
      'Reached max cycles',
      'no milestone progress',
      'Diminishing returns',
    ];
    const isOperational = OPERATIONAL_BLOCK_PATTERNS.some(p => reason.includes(p));
    if (!isOperational) {
      const err = new Error(`Workflow blocked: ${updated.title} — ${reason}`);
      err.name = 'WorkflowBlocked';
      // Gather last failed job + agent error for Sentry context
      const wfJobs = queries.getJobsForWorkflow(updated.id);
      const lastFailed = [...wfJobs].reverse().find((j: Job) => j.status === 'failed');
      let lastFailedError = '';
      let lastFailedAgentId = '';
      if (lastFailed) {
        const failedAgents = queries.getAgentsWithJobByJobId(lastFailed.id);
        const failedAgent = failedAgents[0];
        lastFailedError = failedAgent?.error_message ?? '';
        lastFailedAgentId = failedAgent?.id ?? '';
      }
      Sentry.captureException(err, {
      tags: {
        component: 'WorkflowManager',
        workflow_id: updated.id,
      },
      extra: {
        title: updated.title,
        blocked_reason: reason,
        phase: updated.current_phase,
        cycle: updated.current_cycle,
        max_cycles: updated.max_cycles,
        milestones: `${updated.milestones_done}/${updated.milestones_total}`,
        implementer_model: updated.implementer_model,
        reviewer_model: updated.reviewer_model,
        worktree_branch: updated.worktree_branch ?? 'none',
        last_failed_job: lastFailed ? `${lastFailed.title} (${lastFailed.id.slice(0, 8)})` : 'none',
        last_failed_agent: lastFailedAgentId ? lastFailedAgentId.slice(0, 8) : 'none',
        last_failed_error: lastFailedError.slice(0, 500) || 'no error recorded',
        total_jobs: wfJobs.length,
        failed_jobs: wfJobs.filter((j: Job) => j.status === 'failed').length,
      },
      });
    }
    try { writeBlockedDiagnostic(updated); } catch { /* best effort */ }
  }
}

// ─── Push & PR Creation ───────────────────────────────────────────────────────

/**
 * Push the worktree branch and create a GitHub PR.
 * Does NOT remove the worktree — callers decide when to clean up.
 * Returns the PR URL on success, or null if no PR was created.
 */
export function pushAndCreatePr(workflow: Workflow, isDraft: boolean): string | null {
  const { worktree_path, worktree_branch, work_dir } = workflow;
  if (!worktree_path || !work_dir) return null;

  // Ensure the worktree is on the correct branch before pushing.
  if (worktree_branch) {
    const branchCheck = ensureWorktreeBranch(worktree_path, worktree_branch);
    if (!branchCheck.ok) {
      console.warn(`[workflow ${workflow.id}] branch check failed:`, branchCheck.error);
    }
  }

  // Count commits on the branch that aren't on the remote default branch
  let hasCommits = false;
  try {
    hasCommits = countBranchCommits(worktree_path) > 0;
  } catch (err) {
    // Safe default: assume commits exist so we attempt the push rather than silently
    // skipping PR creation on transient git errors (index.lock, timeout, etc.).
    // A wasted push attempt is far better than silently losing a PR.
    console.warn(`[workflow ${workflow.id}] rev-list failed, assuming commits exist:`, err);
    hasCommits = true;
  }

  if (!hasCommits || !worktree_branch) {
    console.log(`[workflow ${workflow.id}] no commits on branch — skipping PR`);
    return null;
  }

  try {
    // Push branch to remote
    execSync(`git push -u origin ${JSON.stringify(worktree_branch)}`, {
      cwd: worktree_path, stdio: 'pipe', timeout: 30000,
    });

    // Build PR body from plan note milestones
    const planNote = queries.getNote(`workflow/${workflow.id}/plan`);
    const body = _buildPrBody(workflow, planNote?.value ?? null, { partial: isDraft });
    const title = `[Workflow] ${workflow.title}`;

    // For draft (partial) PRs, ensure the "partial" label exists and attach it
    let labelFlag = '';
    if (isDraft) {
      try {
        execSync('gh label create partial --description "Partial workflow completion" --color FBCA04', {
          cwd: worktree_path, stdio: 'pipe', timeout: 10000,
        });
      } catch { /* label already exists — fine */ }
      labelFlag = ' --label partial';
    }

    // M14/6D: Merge conflict pre-check before PR creation
    let conflictWarning = '';
    try {
      const mergeBase = execSync('git merge-base HEAD origin/HEAD 2>/dev/null || echo ""', {
        cwd: worktree_path, stdio: 'pipe', timeout: 10000,
      }).toString().trim();
      if (mergeBase) {
        const mergeTree = execSync(`git merge-tree ${mergeBase} origin/HEAD HEAD`, {
          cwd: worktree_path, stdio: 'pipe', timeout: 10000,
        }).toString();
        if (mergeTree.includes('<<<<<<<') || mergeTree.includes('changed in both')) {
          const conflictFiles = mergeTree
            .split('\n')
            .filter(l => l.includes('changed in both'))
            .map(l => l.replace(/.*changed in both.*'([^']+)'.*/i, '$1'))
            .filter(l => l !== '');
          conflictWarning = `\n\n**Warning: Potential merge conflicts detected** with the base branch in: ${conflictFiles.join(', ') || '(unknown files)'}. Manual resolution may be needed.`;
          console.warn(`[workflow ${workflow.id}] merge conflict pre-check: conflicts in ${conflictFiles.join(', ')}`);
        }
      }
    } catch { /* merge-tree check failed — proceed with PR anyway */ }

    // Check if a PR already exists before trying to create one
    try {
      const existingUrl = execSync(
        `gh pr view --json url -q .url --head ${JSON.stringify(worktree_branch)}`,
        { cwd: worktree_path, stdio: 'pipe', timeout: 15000 }
      ).toString().trim();
      if (existingUrl) {
        updateAndEmit(workflow.id, { pr_url: existingUrl });
        console.log(`[workflow ${workflow.id}] PR already exists: ${existingUrl}`);
        return existingUrl;
      }
    } catch { /* no existing PR — create one */ }

    // Create PR via gh CLI
    const draftFlag = isDraft ? ' --draft' : '';
    const finalBody = conflictWarning ? body + conflictWarning : body;
    const prUrl = execSync(
      `gh pr create --title ${JSON.stringify(title)} --body ${JSON.stringify(finalBody)} --head ${JSON.stringify(worktree_branch)}${draftFlag}${labelFlag}`,
      { cwd: worktree_path, stdio: 'pipe', timeout: 30000 }
    ).toString().trim();

    updateAndEmit(workflow.id, { pr_url: prUrl });
    console.log(`[workflow ${workflow.id}] ${isDraft ? 'draft ' : ''}PR created: ${prUrl}`);
    return prUrl;
  } catch (err: any) {
    const stderr = err.stderr?.toString() ?? err.message ?? '';
    // gh CLI returns error if PR already exists — find and use existing
    if (stderr.includes('already exists')) {
      try {
        const existing = execSync(
          `gh pr view --json url -q .url --head ${JSON.stringify(worktree_branch)}`,
          { cwd: worktree_path, stdio: 'pipe', timeout: 15000 }
        ).toString().trim();
        if (existing) {
          updateAndEmit(workflow.id, { pr_url: existing });
          console.log(`[workflow ${workflow.id}] PR already exists: ${existing}`);
          return existing;
        }
      } catch { /* can't find existing PR */ }
    }
    console.warn(`[workflow ${workflow.id}] push/PR failed (worktree branch preserved locally):`, stderr);
    return null;
  }
}

// ─── Worktree Cleanup ─────────────────────────────────────────────────────────

function _removeWorktree(workflow: Workflow): void {
  const { worktree_path, work_dir } = workflow;
  if (!worktree_path || !work_dir) return;
  // Auto-save uncommitted work before destroying the worktree
  try {
    const status = execSync('git status --porcelain', {
      cwd: worktree_path, stdio: 'pipe', timeout: 5000,
    }).toString().trim();
    if (status) {
      console.log(`[workflow ${workflow.id}] saving uncommitted work before worktree removal`);
      execSync('git add -A', { cwd: worktree_path, stdio: 'pipe', timeout: 10000 });
      execSync('git commit -m "wip: auto-saved uncommitted work before worktree cleanup"', {
        cwd: worktree_path, stdio: 'pipe', timeout: 10000,
      });
      // Best-effort push so the work survives worktree deletion
      const branch = workflow.worktree_branch;
      if (branch) {
        try {
          execSync(`git push origin ${JSON.stringify(branch)}`, {
            cwd: worktree_path, stdio: 'pipe', timeout: 30000,
          });
        } catch { /* push failed — work is still in local branch */ }
      }
    }
  } catch { /* status/commit failed — proceed with removal anyway */ }
  try {
    execSync(`git worktree remove --force ${JSON.stringify(worktree_path)}`, {
      cwd: work_dir, stdio: 'pipe', timeout: 15000,
    });
    execSync('git worktree prune', { cwd: work_dir, stdio: 'pipe', timeout: 10000 });
    console.log(`[workflow ${workflow.id}] worktree removed`);
  } catch (err: any) {
    console.warn(`[workflow ${workflow.id}] worktree removal failed:`, err.message);
  }
}

/**
 * Called when a workflow completes successfully.
 * Pushes the worktree branch, opens a GitHub PR, then removes the local worktree.
 * If PR creation fails but the branch has publishable commits, the worktree is
 * preserved so the PR can be retried manually or on resume.
 */
export function finalizeWorkflow(workflow: Workflow): void {
  // M13/6B: Release file claims on workflow completion
  queries.releaseWorkflowClaims(workflow.id);
  if (!workflow.worktree_path || !workflow.work_dir) return;

  const prUrl = pushAndCreatePr(workflow, false);
  const prOutcome = getPrCreationOutcome(workflow, prUrl);

  if (prOutcome === 'created') {
    // PR created successfully — safe to remove worktree
    _removeWorktree(workflow);
  } else if (prOutcome === 'failed_with_publishable_commits') {
    console.warn(`[workflow ${workflow.id}] PR creation failed — worktree preserved at ${workflow.worktree_path} for retry`);
    updateAndEmit(workflow.id, {
      status: 'blocked',
      blocked_reason: `PR creation failed — worktree preserved for retry at ${workflow.worktree_path}`,
    });
  } else {
    _removeWorktree(workflow);
  }
}

/**
 * Called when a workflow is cancelled — skip the PR, just clean up the worktree.
 */
export function cleanupWorktree(workflow: Workflow): void {
  queries.releaseWorkflowClaims(workflow.id);
  _removeWorktree(workflow);
}
