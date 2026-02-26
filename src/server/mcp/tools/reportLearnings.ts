import { z } from 'zod';
import * as queries from '../../db/queries.js';

const learningItem = z.object({
  title: z.string().describe('Short title for this learning'),
  content: z.string().describe('What was learned — be specific and actionable'),
  tags: z.string().optional().describe('Comma-separated tags (e.g. "build,testing")'),
  scope: z.enum(['project', 'global']).optional().describe('Hint: "project" for repo-specific, "global" for universal. Defaults to project.'),
});

export const reportLearningsSchema = z.object({
  learnings: z.array(learningItem).min(1).max(5).describe('Array of learnings to report (max 5)'),
});

export async function reportLearningsHandler(agentId: string, input: z.infer<typeof reportLearningsSchema>): Promise<string> {
  const { learnings } = input;
  const key = `_learnings/${agentId}`;
  queries.upsertNote(key, JSON.stringify(learnings), agentId);
  return JSON.stringify({
    ok: true,
    stored: learnings.length,
    message: `Stored ${learnings.length} learning(s) for triage after job completes.`,
  });
}
