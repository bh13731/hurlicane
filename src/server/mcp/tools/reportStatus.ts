import { z } from 'zod';
import * as queries from '../../db/queries.js';
import * as socket from '../../socket/SocketManager.js';

export const reportStatusSchema = z.object({
  message: z.string().describe('Status message to display in the dashboard'),
});

export async function reportStatusHandler(agentId: string, input: z.infer<typeof reportStatusSchema>): Promise<string> {
  const { message } = input;
  queries.updateAgent(agentId, { status_message: message });
  const agentWithJob = queries.getAgentWithJob(agentId);
  if (agentWithJob) socket.emitAgentUpdate(agentWithJob);
  return 'Status updated';
}
