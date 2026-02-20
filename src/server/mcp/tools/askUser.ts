import { z } from 'zod';
import { randomUUID } from 'crypto';
import { getMessageRouter } from '../../orchestrator/MessageRouter.js';
import * as queries from '../../db/queries.js';
import * as socket from '../../socket/SocketManager.js';

export const askUserSchema = z.object({
  question: z.string().describe('The question to ask the user'),
  timeout_ms: z.number().optional().describe('Timeout in milliseconds (default: 300000)'),
});

export async function askUserHandler(agentId: string, input: z.infer<typeof askUserSchema>): Promise<string> {
  const { question, timeout_ms = 300000 } = input;
  const qid = randomUUID();
  const now = Date.now();

  const questionRecord = {
    id: qid,
    agent_id: agentId,
    question,
    answer: null,
    status: 'pending' as const,
    asked_at: now,
    answered_at: null,
    timeout_ms,
  };

  queries.insertQuestion(questionRecord);
  queries.updateAgent(agentId, { status: 'waiting_user' });

  // Emit events to update UI
  socket.emitQuestionNew(questionRecord);
  const agentWithJob = queries.getAgentWithJob(agentId);
  if (agentWithJob) socket.emitAgentUpdate(agentWithJob);

  // Block until answered or timed out
  const router = getMessageRouter();
  const answer = await router.waitForAnswer(qid, timeout_ms);

  // Update DB
  const status = answer.startsWith('[TIMEOUT]') ? 'timeout' : 'answered';
  queries.updateQuestion(qid, {
    answer,
    status,
    answered_at: Date.now(),
  });

  // Resume agent status
  queries.updateAgent(agentId, { status: 'running' });
  const updatedAgent = queries.getAgentWithJob(agentId);
  const updatedQuestion = queries.getQuestionById(qid)!;

  socket.emitQuestionAnswered(updatedQuestion);
  if (updatedAgent) socket.emitAgentUpdate(updatedAgent);

  return answer;
}
