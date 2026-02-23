import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import type { Job } from '../../shared/types.js';

// The model used to do the classification itself — always Haiku, cheap and fast
const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';

const COMPLEXITY_TO_MODEL: Record<string, string> = {
  simple:  'claude-haiku-4-5-20251001',
  medium:  'claude-sonnet-4-6[1m]',
  complex: 'claude-opus-4-6[1m]',
};

/**
 * If the job has no model set (null), ask Haiku to classify it as
 * simple/medium/complex, then map that to haiku/sonnet/opus and persist
 * the result on the job row.
 *
 * If ANTHROPIC_API_KEY is absent or the API call fails, falls back to sonnet
 * so the job still runs.
 *
 * Returns the model string that should be passed to the agent.
 */
export async function resolveModel(job: Job): Promise<string> {
  // Explicit model chosen by user — respect it
  if (job.model !== null) return job.model;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const fallback = 'claude-sonnet-4-6[1m]';
    console.warn('[classifier] ANTHROPIC_API_KEY not set — defaulting to sonnet');
    queries.updateJobModel(job.id, fallback);
    socket.emitJobUpdate(queries.getJobById(job.id)!);
    return fallback;
  }

  const prompt = buildClassifierPrompt(job);

  try {
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
        model: CLASSIFIER_MODEL,
        max_tokens: 5,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`Anthropic API ${response.status}: ${await response.text()}`);
    }

    const data = await response.json() as any;
    const word = (data.content?.[0]?.text ?? '').trim().toLowerCase();
    const complexity = (['simple', 'medium', 'complex'] as const).find(c => word.includes(c)) ?? 'medium';
    const model = COMPLEXITY_TO_MODEL[complexity];

    console.log(`[classifier] "${job.title}" → ${complexity} → ${model}`);

    queries.updateJobModel(job.id, model);
    socket.emitJobUpdate(queries.getJobById(job.id)!);

    return model;
  } catch (err) {
    const fallback = 'claude-sonnet-4-6[1m]';
    console.error(`[classifier] failed, falling back to ${fallback}:`, err);
    queries.updateJobModel(job.id, fallback);
    socket.emitJobUpdate(queries.getJobById(job.id)!);
    return fallback;
  }
}

function buildClassifierPrompt(job: Job): string {
  const desc = job.description.slice(0, 600);
  return `Classify this software task by complexity. Reply with exactly one word: simple, medium, or complex.

simple  = small, well-scoped, one file or one function (e.g. fix a typo, list files, add a log line)
medium  = moderate scope, some reasoning needed (e.g. add a feature, write tests, refactor a module)
complex = broad scope, architecture/design decisions, many files (e.g. new subsystem, large refactor)

Title: ${job.title}
Description: ${desc}`;
}
