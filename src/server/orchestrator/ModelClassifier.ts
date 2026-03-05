import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { callClaude } from './LLMHelper.js';
import type { Job } from '../../shared/types.js';

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
 * Returns the model string that should be passed to the agent.
 */
export async function resolveModel(job: Job): Promise<string> {
  // Explicit model chosen by user — respect it
  if (job.model !== null) return job.model;

  // Default model from settings — skip classification entirely
  const defaultModel = queries.getNote('setting:defaultModel')?.value;
  if (defaultModel) {
    console.log(`[classifier] "${job.title}" → using default model ${defaultModel}`);
    queries.updateJobModel(job.id, defaultModel);
    socket.emitJobUpdate(queries.getJobById(job.id)!);
    return defaultModel;
  }

  const prompt = buildClassifierPrompt(job);

  try {
    const word = await callClaude(prompt, { model: 'haiku', maxTokens: 5 });
    const complexity = (['simple', 'medium', 'complex'] as const).find(c => word.toLowerCase().includes(c)) ?? 'medium';
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
