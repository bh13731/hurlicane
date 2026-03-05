import path from 'path';
import { z } from 'zod';
import { getFileLockRegistry } from '../../orchestrator/FileLockRegistry.js';
import * as queries from '../../db/queries.js';

export const releaseFilesSchema = z.object({
  files: z.array(z.string()).describe('List of file paths to release locks for'),
});

export async function releaseFilesHandler(agentId: string, input: z.infer<typeof releaseFilesSchema>): Promise<string> {
  const { files } = input;

  // Resolve relative paths to match how they were stored
  const agent = queries.getAgentById(agentId);
  const workDir = agent ? queries.getJobById(agent.job_id)?.work_dir : null;
  const resolvedFiles = files.map(f =>
    f.startsWith('/') ? f : path.resolve(workDir || process.cwd(), f)
  );

  const registry = getFileLockRegistry();
  const released = registry.release(agentId, resolvedFiles);
  return JSON.stringify({ released });
}
