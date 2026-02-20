import { z } from 'zod';
import * as queries from '../../db/queries.js';

export const checkFileLocksSchema = z.object({}).describe('No parameters needed');

export async function checkFileLocksHandler(_agentId: string, _input: z.infer<typeof checkFileLocksSchema>): Promise<string> {
  const locks = queries.getAllActiveLocks();
  return JSON.stringify(locks.map(l => ({
    file_path: l.file_path,
    agent_id: l.agent_id,
    reason: l.reason,
    acquired_at: l.acquired_at,
    expires_at: l.expires_at,
  })));
}
