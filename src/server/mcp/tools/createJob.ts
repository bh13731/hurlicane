import { z } from 'zod';
import { randomUUID } from 'crypto';
import * as queries from '../../db/queries.js';
import * as socket from '../../socket/SocketManager.js';

export const createJobSchema = z.object({
  description: z.string().describe('Full task description for the new job'),
  title: z.string().optional().describe('Short title (auto-generated from first line if omitted)'),
  priority: z.number().optional().describe('Priority 0–10; higher runs sooner (default: 0)'),
  work_dir: z.string().optional().describe("Working directory (defaults to this agent's working directory)"),
  max_turns: z.number().optional().describe('Max agent turns (default: 50)'),
  model: z.string().optional().describe('Model override, e.g. "claude-opus-4-6" (default: auto-classify)'),
  depends_on: z.array(z.string()).optional().describe('Job IDs that must complete before this job runs'),
  use_worktree: z.boolean().optional().describe('Create a git worktree so the agent works in an isolated checkout'),
});

export async function createJobHandler(agentId: string, input: z.infer<typeof createJobSchema>): Promise<string> {
  const { description, title, priority, work_dir, max_turns, model, depends_on, use_worktree } = input;

  // Inherit work_dir, project_id, and model from calling agent's job if not specified
  let resolvedWorkDir = work_dir ?? null;
  let inheritedProjectId: string | null = null;
  let inheritedModel: string | null = null;
  const agent = queries.getAgentById(agentId);
  if (agent) {
    const parentJob = queries.getJobById(agent.job_id);
    if (parentJob) {
      if (!resolvedWorkDir) resolvedWorkDir = (parentJob as any)?.work_dir ?? null;
      inheritedProjectId = parentJob.project_id ?? null;
      inheritedModel = parentJob.model ?? null;
    }
  }

  const job = queries.insertJob({
    id: randomUUID(),
    title: title?.trim() || description.split('\n')[0].slice(0, 60),
    description,
    context: null,
    priority: priority ?? 0,
    work_dir: resolvedWorkDir,
    max_turns: max_turns ?? 50,
    model: model ?? inheritedModel,
    template_id: null,
    depends_on: depends_on?.length ? JSON.stringify(depends_on) : null,
    use_worktree: use_worktree ? 1 : 0,
    project_id: inheritedProjectId,
  });

  socket.emitJobNew(job);

  return JSON.stringify({
    job_id: job.id,
    title: job.title,
    status: job.status,
  });
}
