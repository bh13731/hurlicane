import { z } from 'zod';
import { randomUUID } from 'crypto';
import * as queries from '../../db/queries.js';
import * as socket from '../../socket/SocketManager.js';
import { nudgeQueue } from '../../orchestrator/WorkQueueManager.js';
import { createAutonomousAgentRun } from '../../orchestrator/AutonomousAgentRunManager.js';
import {
  validateTaskRequest,
  resolveTaskConfig,
  taskToJobRequest,
  taskToWorkflowRequest,
} from '../../../shared/taskNormalization.js';
import type { CreateTaskRequest } from '../../../shared/types.js';

const stopModeEnum = z.enum(['turns', 'budget', 'time', 'completion']);

export const createTaskSchema = z.object({
  description: z.string().optional().describe('Task description (required unless templateId is provided for job-routed tasks)'),
  title: z.string().optional().describe('Short title (auto-generated if omitted)'),
  preset: z.enum(['quick', 'reviewed', 'autonomous']).optional().describe('Preset hint: quick (single-shot job), reviewed (job with review pass), autonomous (multi-cycle workflow). Defaults inferred from other fields.'),
  review: z.boolean().optional().describe('Enable a review pass. Auto-enabled for reviewed/autonomous presets.'),
  iterations: z.number().optional().describe('Number of assess/review/implement cycles. 1 = job, >1 = workflow. Range: 1-50.'),
  model: z.string().optional().describe('Primary/implementer model override'),
  reviewerModel: z.string().optional().describe('Reviewer model (used when review is enabled)'),
  work_dir: z.string().optional().describe("Working directory (inherited from calling agent's job if omitted)"),
  useWorktree: z.boolean().optional().describe('Create a git worktree for isolation. Auto-enabled for iterations > 1.'),
  templateId: z.string().optional().describe('Template ID to apply'),
  projectId: z.string().optional().describe('Project to associate with (job-routed only; workflows create their own project)'),
  // Job-only stopping conditions
  stopMode: stopModeEnum.optional().describe('Stopping mode for job-routed tasks'),
  stopValue: z.number().optional().describe('Stopping value for job-routed tasks'),
  maxTurns: z.number().optional().describe('Max agent turns for job-routed tasks'),
  // Per-phase stopping conditions (workflow only)
  maxTurnsAssess: z.number().optional().describe('Assess phase turn limit (workflow only)'),
  maxTurnsReview: z.number().optional().describe('Review phase turn limit (workflow only)'),
  maxTurnsImplement: z.number().optional().describe('Implement phase turn limit (workflow only)'),
  stopModeAssess: stopModeEnum.optional().describe('Assess phase stop mode (workflow only)'),
  stopValueAssess: z.number().optional().describe('Assess phase stop value (workflow only)'),
  stopModeReview: stopModeEnum.optional().describe('Review phase stop mode (workflow only)'),
  stopValueReview: z.number().optional().describe('Review phase stop value (workflow only)'),
  stopModeImplement: stopModeEnum.optional().describe('Implement phase stop mode (workflow only)'),
  stopValueImplement: z.number().optional().describe('Implement phase stop value (workflow only)'),
  completionThreshold: z.number().optional().describe('Milestone completion threshold 0.1-1.0 (workflow only)'),
  // Advanced job options
  priority: z.number().optional().describe('Priority 0-10 (job only)'),
  depends_on: z.array(z.string()).optional().describe('Job IDs that must complete first (job only)'),
  completionChecks: z.array(z.string()).optional().describe('Completion check commands (job only)'),
});

export async function createTaskHandler(
  agentId: string,
  input: z.infer<typeof createTaskSchema>,
): Promise<string> {
  // Map MCP input to CreateTaskRequest (MCP uses work_dir/depends_on snake_case)
  const taskReq: CreateTaskRequest = {
    description: input.description,
    title: input.title,
    preset: input.preset,
    review: input.review,
    iterations: input.iterations,
    model: input.model,
    reviewerModel: input.reviewerModel,
    workDir: input.work_dir,
    useWorktree: input.useWorktree,
    templateId: input.templateId,
    projectId: input.projectId,
    stopMode: input.stopMode,
    stopValue: input.stopValue,
    maxTurns: input.maxTurns,
    maxTurnsAssess: input.maxTurnsAssess,
    maxTurnsReview: input.maxTurnsReview,
    maxTurnsImplement: input.maxTurnsImplement,
    stopModeAssess: input.stopModeAssess,
    stopValueAssess: input.stopValueAssess,
    stopModeReview: input.stopModeReview,
    stopValueReview: input.stopValueReview,
    stopModeImplement: input.stopModeImplement,
    stopValueImplement: input.stopValueImplement,
    completionThreshold: input.completionThreshold,
    priority: input.priority,
    dependsOn: input.depends_on,
    completionChecks: input.completionChecks,
  };

  // Inherit work_dir and model from calling agent's job if not specified
  const agent = queries.getAgentById(agentId);
  if (agent) {
    const parentJob = queries.getJobById(agent.job_id);
    if (parentJob) {
      if (!taskReq.workDir) taskReq.workDir = parentJob.work_dir ?? undefined;
    }
  }

  // Validate using shared normalization layer
  const error = validateTaskRequest(taskReq);
  if (error) {
    return JSON.stringify({ error });
  }

  // Resolve routing
  const config = resolveTaskConfig(taskReq);

  if (config.routesTo === 'workflow') {
    // ── Workflow path ──────────────────────────────────────────────────────
    const workflowReq = taskToWorkflowRequest(taskReq, config);
    const result = createAutonomousAgentRun(workflowReq);
    socket.emitWorkflowNew(result.workflow);
    return JSON.stringify({
      task_type: 'workflow',
      autonomous_agent_run_id: result.workflow.id,
      title: result.workflow.title,
      status: result.workflow.status,
      project_id: result.project.id,
      assess_job_id: result.jobs[0]?.id ?? null,
    });
  }

  // ── Job path ───────────────────────────────────────────────────────────────
  const jobReq = taskToJobRequest(taskReq, config);

  // Inherit model and project from calling agent if not set
  let inheritedModel: string | null = null;
  let inheritedProjectId: string | null = null;
  if (agent) {
    const parentJob = queries.getJobById(agent.job_id);
    if (parentJob) {
      if (!jobReq.model) inheritedModel = parentJob.model ?? null;
      if (!jobReq.projectId) inheritedProjectId = parentJob.project_id ?? null;
    }
  }

  const title = jobReq.title?.trim()
    || (jobReq.description || '').split('\n')[0].slice(0, 60)
    || 'Untitled';

  const job = queries.insertJob({
    id: randomUUID(),
    title,
    description: jobReq.description ?? '',
    context: jobReq.context ? JSON.stringify(jobReq.context) : null,
    priority: jobReq.priority ?? 0,
    work_dir: jobReq.workDir ?? null,
    max_turns: jobReq.maxTurns ?? 50,
    stop_mode: jobReq.stopMode ?? 'turns',
    stop_value: jobReq.stopValue ?? (jobReq.maxTurns ?? 50),
    model: jobReq.model ?? inheritedModel,
    template_id: jobReq.templateId ?? null,
    depends_on: jobReq.dependsOn?.length ? JSON.stringify(jobReq.dependsOn) : null,
    use_worktree: jobReq.useWorktree ? 1 : 0,
    project_id: jobReq.projectId ?? inheritedProjectId,
    repeat_interval_ms: jobReq.repeatIntervalMs ?? null,
    retry_policy: jobReq.retryPolicy ?? 'none',
    max_retries: jobReq.maxRetries ?? 0,
    retry_count: 0,
    original_job_id: null,
    completion_checks: jobReq.completionChecks?.length ? JSON.stringify(jobReq.completionChecks) : null,
    review_config: jobReq.reviewConfig ? JSON.stringify(jobReq.reviewConfig) : null,
    created_by_agent_id: agentId,
  });

  socket.emitJobNew(job);
  nudgeQueue();

  return JSON.stringify({
    task_type: 'job',
    job_id: job.id,
    title: job.title,
    status: job.status,
  });
}
