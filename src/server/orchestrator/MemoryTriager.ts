import { randomUUID } from 'crypto';
import * as queries from '../db/queries.js';
import type { Job } from '../../shared/types.js';

const TRIAGE_MODEL = 'claude-haiku-4-5-20251001';

interface Learning {
  title: string;
  content: string;
  tags?: string;
  scope?: 'project' | 'global';
}

interface TriageResult {
  index: number;
  classification: 'project' | 'global' | 'discard';
}

/**
 * Called after a job completes successfully. Reads any learnings the agent
 * reported via report_learnings, triages them through Haiku, and stores
 * survivors in the knowledge_base table.
 */
export async function triageLearnings(agentId: string, job: Job): Promise<void> {
  const noteKey = `_learnings/${agentId}`;
  const note = queries.getNote(noteKey);
  if (!note) return;

  let learnings: Learning[];
  try {
    learnings = JSON.parse(note.value);
    if (!Array.isArray(learnings) || learnings.length === 0) {
      queries.deleteNote(noteKey);
      return;
    }
  } catch {
    queries.deleteNote(noteKey);
    return;
  }

  const projectId: string | null = (job as any).project_id ?? null;

  // Fetch existing KB titles for dedup context
  const existingEntries = queries.listKBEntries(projectId ?? undefined);
  const existingTitles = existingEntries.map(e => e.title).slice(0, 50);

  let classifications: TriageResult[];
  try {
    classifications = await classifyLearnings(learnings, existingTitles, job.title);
  } catch (err) {
    console.error(`[memory-triage] API call failed for agent ${agentId}, storing all as project-scoped:`, err);
    // Fallback: store all as project-scoped
    classifications = learnings.map((_, i) => ({ index: i, classification: 'project' as const }));
  }

  let stored = 0;
  for (const result of classifications) {
    if (result.classification === 'discard') continue;
    const learning = learnings[result.index];
    if (!learning) continue;

    const entryProjectId = result.classification === 'global' ? null : projectId;
    queries.insertKBEntry({
      id: randomUUID(),
      title: learning.title,
      content: learning.content,
      tags: learning.tags ?? null,
      source: `agent:${agentId}`,
      agent_id: agentId,
      project_id: entryProjectId,
    });
    stored++;
  }

  // Clean up transient note
  queries.deleteNote(noteKey);

  if (stored > 0) {
    console.log(`[memory-triage] agent ${agentId}: stored ${stored}/${learnings.length} learnings`);
  }
}

async function classifyLearnings(
  learnings: Learning[],
  existingTitles: string[],
  jobTitle: string,
): Promise<TriageResult[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // No API key — store all as project-scoped
    return learnings.map((_, i) => ({ index: i, classification: 'project' as const }));
  }

  const learningsList = learnings.map((l, i) =>
    `${i}. "${l.title}": ${l.content.slice(0, 200)}${l.scope ? ` [hint: ${l.scope}]` : ''}`
  ).join('\n');

  const existingList = existingTitles.length > 0
    ? `\nExisting KB entries (avoid duplicates):\n${existingTitles.map(t => `- ${t}`).join('\n')}`
    : '';

  const prompt = `You are triaging learnings from an AI coding agent into a knowledge base.
Job completed: "${jobTitle}"

Learnings to classify:
${learningsList}
${existingList}

For each learning, classify as:
- "project" — specific to this codebase (build commands, file locations, API quirks, project conventions)
- "global" — universally useful (language patterns, tool usage tips, general debugging strategies)
- "discard" — too vague, trivially obvious, or duplicates an existing entry

Respond with ONLY a JSON array like: [{"index":0,"classification":"project"},{"index":1,"classification":"discard"}]`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: TRIAGE_MODEL,
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  clearTimeout(timeout);

  if (!response.ok) {
    throw new Error(`Anthropic API ${response.status}: ${await response.text()}`);
  }

  const data = await response.json() as any;
  const text = (data.content?.[0]?.text ?? '').trim();

  // Extract JSON array from response
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) {
    throw new Error(`Could not parse triage response: ${text.slice(0, 200)}`);
  }

  const results: TriageResult[] = JSON.parse(match[0]);
  // Validate and fill in any missing indices with project scope
  const resultMap = new Map(results.map(r => [r.index, r]));
  return learnings.map((_, i) => resultMap.get(i) ?? { index: i, classification: 'project' as const });
}
