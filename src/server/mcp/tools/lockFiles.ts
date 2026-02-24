import { z } from 'zod';
import { getFileLockRegistry } from '../../orchestrator/FileLockRegistry.js';

export const lockFilesSchema = z.object({
  files: z.array(z.string()).describe('List of file paths to lock'),
  reason: z.string().optional().describe('Why these files are being locked'),
  ttl_ms: z.number().optional().describe('How long to hold the lock in ms (default: 600000)'),
  timeout_ms: z.number().optional().describe('How long to wait for the lock in ms before giving up (default: 660000). The default timeout (660s) exceeds the default TTL (600s), so with defaults you will always eventually get the lock without timing out.'),
});

export async function lockFilesHandler(agentId: string, input: z.infer<typeof lockFilesSchema>): Promise<string> {
  const { files, reason, ttl_ms = 600000, timeout_ms = 660000 } = input;
  const registry = getFileLockRegistry();
  const result = await registry.acquire(agentId, files, reason ?? null, ttl_ms, timeout_ms);
  return JSON.stringify(result);
}
