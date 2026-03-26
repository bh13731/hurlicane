import path from 'path';
import { z } from 'zod';
import { getFileLockRegistry } from '../../orchestrator/FileLockRegistry.js';
import * as queries from '../../db/queries.js';

export const lockFilesSchema = z.object({
  files: z.array(z.string()).describe('List of file paths to lock (absolute or relative to work directory)'),
  reason: z.string().optional().describe('Why these files are being locked'),
  ttl_ms: z.number().optional().describe('How long to hold the lock in ms (default: 600000)'),
  timeout_ms: z.number().optional().describe('How long to wait for the lock in ms before giving up (default: 660000). The default timeout (660s) exceeds the default TTL (600s), so with defaults you will always eventually get the lock without timing out.'),
});

export async function lockFilesHandler(agentId: string, input: z.infer<typeof lockFilesSchema>): Promise<string> {
  // Reject lock requests from readonly agents
  const agent = queries.getAgentById(agentId);
  if (agent) {
    const job = queries.getJobById(agent.job_id);
    if (job?.is_readonly) {
      return JSON.stringify({ success: false, error: 'This is a read-only job. File locking is not allowed.' });
    }
  }

  const { files, reason, ttl_ms = 600000, timeout_ms = 660000 } = input;

  // Resolve relative paths to absolute using the agent's work directory
  // so lock paths match the hook's resolved paths
  const job = agent ? queries.getJobById(agent.job_id) : null;
  const workDir = job ? queries.resolveJobWorkDir(job) : process.cwd();
  const resolvedFiles = files.map(f =>
    f.startsWith('/') ? f : path.resolve(workDir, f)
  );

  const registry = getFileLockRegistry();
  const result = await registry.acquire(agentId, resolvedFiles, reason ?? null, ttl_ms, timeout_ms);
  return JSON.stringify(result);
}
