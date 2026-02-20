import { z } from 'zod';
import { getFileLockRegistry } from '../../orchestrator/FileLockRegistry.js';

export const releaseFilesSchema = z.object({
  files: z.array(z.string()).describe('List of file paths to release locks for'),
});

export async function releaseFilesHandler(agentId: string, input: z.infer<typeof releaseFilesSchema>): Promise<string> {
  const { files } = input;
  const registry = getFileLockRegistry();
  const released = registry.release(agentId, files);
  return JSON.stringify({ released });
}
