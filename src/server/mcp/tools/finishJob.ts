import { z } from 'zod';
import * as queries from '../../db/queries.js';
import { handleJobCompletion } from '../../orchestrator/AgentRunner.js';
import { disconnectAgent } from '../../orchestrator/PtyManager.js';

export const finishJobSchema = z.object({
  result: z.string().optional().describe('Summary of what was accomplished'),
});

export async function finishJobHandler(
  agentId: string,
  input: z.infer<typeof finishJobSchema>,
): Promise<string> {
  const agentWithJob = queries.getAgentWithJob(agentId);
  if (!agentWithJob) return JSON.stringify({ error: 'Agent not found' });

  // Idempotency: if agent is already in a terminal state, skip processing
  const TERMINAL = ['done', 'failed', 'cancelled'];
  if (agentWithJob.agent?.status && TERMINAL.includes(agentWithJob.agent.status)) {
    return JSON.stringify({ ok: true, message: 'Already completed.' });
  }

  const { job } = agentWithJob;

  // Store result as a synthetic result event so getAgentResultText can find it
  if (input.result) {
    const seq = queries.getAgentLastSeq(agentId) + 1;
    queries.insertAgentOutput({
      agent_id: agentId,
      seq,
      event_type: 'result',
      content: JSON.stringify({ type: 'result', result: input.result, is_error: false }),
      created_at: Date.now(),
    });
  }

  // Mark agent done before running post-processing
  queries.updateAgent(agentId, { status: 'done', finished_at: Date.now() });

  // Run shared post-processing (git diff, completion checks, learnings, debate, retry, etc.)
  await handleJobCompletion(agentId, job, 'done');

  // Kill the tmux session after a brief delay so this tool response can be delivered first
  setTimeout(() => disconnectAgent(agentId), 500);

  return JSON.stringify({ ok: true, message: 'Task complete. Session closing.' });
}
