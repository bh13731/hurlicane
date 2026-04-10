/**
 * Milestone parsing, plan recovery, and plan validation for the workflow engine.
 * Extracted from WorkflowManager.ts — pure logic with no side effects beyond
 * DB reads (queries) and log output.
 */

import * as queries from '../db/queries.js';
import type { Job } from '../../shared/types.js';

// ─── Milestone Parsing ────────────────────────────────────────────────────────

export const CHECKBOX_CHECKED = /^[\t ]*[-*][\t ]+\[[xX]\]/;
export const CHECKBOX_UNCHECKED = /^[\t ]*[-*][\t ]+\[\s?\]/;

export function parseMilestones(planText: string): { total: number; done: number } {
  let done = 0;
  let unchecked = 0;
  for (const line of planText.split('\n')) {
    if (CHECKBOX_CHECKED.test(line)) done++;
    else if (CHECKBOX_UNCHECKED.test(line)) unchecked++;
  }
  return { total: done + unchecked, done };
}

/** Check if milestone progress meets the completion threshold (0.0-1.0). */
export function meetsCompletionThreshold(
  milestones: { total: number; done: number },
  threshold: number,
): boolean {
  if (milestones.total === 0) return false;
  return milestones.done / milestones.total >= threshold;
}

// ─── Plan Recovery from Agent Output (M7/4C) ─────────────────────────────────

/**
 * Attempt to recover a plan from the assess agent's text output.
 * Scans assistant text blocks for a "# Plan" header followed by at least one
 * unchecked milestone (`- [ ]`). If multiple valid plans are found across
 * messages, uses the last one (most refined), breaking ties by milestone count.
 * Returns true if a valid plan was recovered.
 */
export function recoverPlanFromAgentOutput(job: Job, workflowId: string): boolean {
  try {
    const agents = queries.getAgentsWithJobByJobId(job.id);
    if (agents.length === 0) return false;

    let bestPlan: string | null = null;
    let bestMilestones = 0;

    for (const agent of agents) {
      const output = queries.getAgentOutput(agent.id);
      for (const row of output) {
        if (row.event_type !== 'assistant') continue;
        try {
          const ev = JSON.parse(row.content);
          if (ev.type !== 'assistant' || !Array.isArray(ev.message?.content)) continue;
          for (const block of ev.message.content) {
            if (block.type !== 'text' || typeof block.text !== 'string') continue;
            const plan = extractPlanFromText(block.text);
            if (plan) {
              const { total } = parseMilestones(plan);
              if (bestPlan === null || total >= bestMilestones) {
                bestPlan = plan;
                bestMilestones = total;
              }
            }
          }
        } catch { /* skip malformed */ }
      }
    }

    if (bestPlan) {
      queries.upsertNote(`workflow/${workflowId}/plan`, bestPlan, null);
      return true;
    }
  } catch (err) {
    console.warn(`[workflow ${workflowId}] failed to recover plan from agent output:`, err);
  }
  return false;
}

/**
 * Extract a plan section from text. Looks for a "# Plan" header and captures
 * everything from that header until the next top-level heading or end of text.
 * Returns the extracted plan if it contains at least one unchecked milestone.
 */
export function extractPlanFromText(text: string): string | null {
  const planHeaderIdx = text.search(/^#{1,3}\s+Plan\b/m);
  if (planHeaderIdx === -1) return null;

  const fromHeader = text.slice(planHeaderIdx);
  const headerMatch = fromHeader.match(/^(#{1,3})\s/);
  const headerLevel = headerMatch ? headerMatch[1].length : 1;

  const firstNewline = fromHeader.indexOf('\n');
  if (firstNewline === -1) return null;
  const rest = fromHeader.slice(firstNewline + 1);
  const nextHeaderPattern = new RegExp(`^#{1,${headerLevel}}\\s`, 'm');
  const nextIdx = rest.search(nextHeaderPattern);
  const planSection = nextIdx === -1 ? fromHeader : fromHeader.slice(0, firstNewline + 1 + nextIdx).trimEnd();

  const { total, done } = parseMilestones(planSection);
  if (total === 0 || total === done) return null;

  return planSection;
}
