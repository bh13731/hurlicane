import { z } from 'zod';
import { randomUUID } from 'crypto';
import * as queries from '../../db/queries.js';
import * as socket from '../../socket/SocketManager.js';

export const createJobSchema = z.object({
  description: z.string().optional().describe('Task description. Optional when template_id is provided — the template content is used as the base prompt, and description (if given) is appended as additional instructions.'),
  title: z.string().optional().describe('Short title (auto-generated from first line if omitted)'),
  priority: z.number().optional().describe('Priority 0–10; higher runs sooner (default: 0)'),
  branch: z.string().optional().describe('Git branch for the job. Auto-generated if omitted. A worktree is created/reused for this branch.'),
  max_turns: z.number().optional().describe('Max agent turns (default: 50)'),
  model: z.string().optional().describe('Model override, e.g. "claude-opus-4-6" (default: auto-classify)'),
  depends_on: z.array(z.string()).optional().describe('Job IDs that must complete before this job runs'),
  repeat_interval_ms: z.number().optional().describe('Re-queue the job automatically after it completes; value is the delay in ms before the next run'),
  template_id: z.string().optional().describe('Template ID to use. The template content becomes the base prompt, and its settings (model, repo, project, retry, etc.) are applied as defaults. Use list_templates to discover available templates.'),
});

export async function createJobHandler(agentId: string, input: z.infer<typeof createJobSchema>): Promise<string> {
  const { description, title, priority, branch, max_turns, model, depends_on, repeat_interval_ms, template_id } = input;

  // Resolve template if specified
  const tpl = template_id ? queries.getTemplateById(template_id) : null;
  if (template_id && !tpl) {
    return JSON.stringify({ error: `Template '${template_id}' not found` });
  }

  if (!description && !tpl) {
    return JSON.stringify({ error: 'description is required when no template_id is provided' });
  }

  // Build the final description: template content as base, user description appended
  const finalDescription = tpl
    ? (description ? `${tpl.content}\n\n${description}` : tpl.content)
    : description!;

  // Inherit repo_id, project_id, model, and is_readonly from calling agent's job if not specified
  let inheritedRepoId: string | null = null;
  let inheritedProjectId: string | null = null;
  let inheritedModel: string | null = null;
  let inheritedReadonly = 0;
  const agent = queries.getAgentById(agentId);
  if (agent) {
    const parentJob = queries.getJobById(agent.job_id);
    if (parentJob) {
      inheritedRepoId = parentJob.repo_id ?? null;
      inheritedProjectId = parentJob.project_id ?? null;
      inheritedModel = parentJob.model ?? null;
      inheritedReadonly = parentJob.is_readonly ?? 0;
    }
  }

  // If the calling agent's job was spawned by the retry system (has original_job_id),
  // inherit retry settings so the new job continues the retry chain
  let retryPolicy: 'none' | 'same' | 'analyze' = 'none';
  let maxRetries = 0;
  let retryCount = 0;
  let originalJobId: string | null = null;
  let completionChecks: string | null = null;
  if (agent) {
    const parentJob = queries.getJobById(agent.job_id);
    if (parentJob?.original_job_id) {
      // This agent is an analysis agent — look up the original job to get retry settings
      const origJob = queries.getJobById(parentJob.original_job_id);
      if (origJob) {
        retryPolicy = origJob.retry_policy ?? 'none';
        maxRetries = origJob.max_retries ?? 0;
        retryCount = origJob.retry_count + 1; // increment since the original already failed once
        originalJobId = origJob.original_job_id ?? origJob.id;
        completionChecks = origJob.completion_checks ?? null;
        // Inherit is_readonly from the original job, not the analysis job
        inheritedReadonly = origJob.is_readonly ?? 0;
      }
    }
  }

  // If template is marked readonly, force readonly regardless of inherited value
  const isReadonly = (tpl?.is_readonly ? 1 : 0) || inheritedReadonly;

  const job = queries.insertJob({
    id: randomUUID(),
    title: title?.trim() || finalDescription.split('\n')[0].slice(0, 60),
    description: finalDescription,
    context: tpl?.context ?? null,
    priority: priority ?? tpl?.priority ?? 0,
    repo_id: inheritedRepoId ?? tpl?.repo_id ?? null,
    branch: branch ?? null,
    max_turns: max_turns ?? 50,
    model: model ?? tpl?.model ?? inheritedModel,
    template_id: template_id ?? null,
    depends_on: depends_on?.length ? JSON.stringify(depends_on) : null,
    is_interactive: tpl?.is_interactive ?? 0,
    is_readonly: isReadonly,
    project_id: inheritedProjectId ?? tpl?.project_id ?? null,
    repeat_interval_ms: repeat_interval_ms ?? null,
    retry_policy: retryPolicy !== 'none' ? retryPolicy : (tpl?.retry_policy ?? 'none'),
    max_retries: maxRetries > 0 ? maxRetries : (tpl?.max_retries ?? 0),
    retry_count: retryCount,
    original_job_id: originalJobId,
    completion_checks: completionChecks ?? tpl?.completion_checks ?? null,
    created_by_agent_id: agentId,
  });

  socket.emitJobNew(job);

  return JSON.stringify({
    job_id: job.id,
    title: job.title,
    status: job.status,
  });
}
