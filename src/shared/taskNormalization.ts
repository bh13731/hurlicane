/**
 * Unified task normalization — resolves presets, defaults, and routing for
 * CreateTaskRequest, and converts to the existing CreateJobRequest or
 * CreateWorkflowRequest payloads consumed by the backend managers.
 *
 * Deterministic rules (no randomness, no IO):
 *   preset    → review / iterations / useWorktree defaults
 *   iterations=1  → routes to Job
 *   iterations>1  → routes to Workflow
 */

import type {
  CreateJobRequest,
  CreateTaskRequest,
  CreateWorkflowRequest,
  ResolvedTaskConfig,
  ReviewConfig,
  StopMode,
  TaskPreset,
} from './types.js';

// ─── Preset defaults ────────────────────────────────────────────────────────

interface PresetDefaults {
  review: boolean;
  iterations: number;
  useWorktree: boolean;
}

const PRESET_DEFAULTS: Record<TaskPreset, PresetDefaults> = {
  quick:      { review: false, iterations: 1,  useWorktree: false },
  reviewed:   { review: true,  iterations: 1,  useWorktree: true  },
  autonomous: { review: true,  iterations: 10, useWorktree: true  },
};

// ─── Preset inference ───────────────────────────────────────────────────────

/** Infer a preset from explicit field values when no preset is specified. */
export function inferPreset(req: CreateTaskRequest): TaskPreset {
  if (req.preset) return req.preset;
  const iterations = req.iterations ?? 1;
  if (iterations > 1) return 'autonomous';
  if (req.review === true) return 'reviewed';
  return 'quick';
}

// ─── Config resolution ──────────────────────────────────────────────────────

/**
 * Resolve the routing-critical fields for a task request.  Explicit values in
 * the request always win; gaps are filled from preset defaults.
 */
export function resolveTaskConfig(req: CreateTaskRequest): ResolvedTaskConfig {
  const preset = inferPreset(req);
  const defaults = PRESET_DEFAULTS[preset];

  const iterations = clampIterations(req.iterations ?? defaults.iterations);
  // Workflow engine always runs a review phase — force review on for workflow routing
  const review     = iterations > 1 ? true : (req.review ?? defaults.review);
  const useWorktree = req.useWorktree ?? (iterations > 1 ? true : defaults.useWorktree);

  return {
    preset,
    routesTo: iterations > 1 ? 'workflow' : 'job',
    review,
    iterations,
    useWorktree,
  };
}

// ─── Validation ─────────────────────────────────────────────────────────────

/** Validate a CreateTaskRequest.  Returns an error string or null if valid. */
export function validateTaskRequest(req: CreateTaskRequest): string | null {
  const hasDescription = !!req.description?.trim();
  const hasTemplate = !!req.templateId;

  if (!hasDescription && !hasTemplate) {
    return 'description is required (or provide a templateId)';
  }
  if (req.iterations !== undefined) {
    if (!Number.isInteger(req.iterations) || req.iterations < 1 || req.iterations > 50) {
      return 'iterations must be an integer between 1 and 50';
    }
  }
  if (req.preset !== undefined && !PRESET_DEFAULTS[req.preset]) {
    return `invalid preset: ${req.preset}`;
  }
  // Job-only options are invalid for autonomous tasks
  const config = resolveTaskConfig(req);
  if (config.routesTo === 'workflow') {
    // Workflow engine always includes a review phase — explicit review=false is contradictory
    if (req.review === false) return 'review cannot be disabled for autonomous tasks (iterations > 1) — the workflow engine always includes a review phase';
    // Workflows require a description — the task field is the workflow's main input
    if (!hasDescription) return 'description is required for autonomous tasks (templateId alone is not sufficient)';
    if (req.dependsOn?.length)       return 'dependsOn is not supported for autonomous tasks (iterations > 1)';
    if (req.interactive)             return 'interactive mode is not supported for autonomous tasks';
    if (req.debate)                  return 'debate is not supported for autonomous tasks';
    if (req.repeatIntervalMs)        return 'repeatIntervalMs is not supported for autonomous tasks';
    if (req.scheduledAt)             return 'scheduledAt is not supported for autonomous tasks';
  }
  return null;
}

// ─── Conversion: Task → Job ─────────────────────────────────────────────────

/**
 * Convert a CreateTaskRequest into a CreateJobRequest for the existing
 * WorkQueueManager.  Only valid when `resolveTaskConfig(req).routesTo === 'job'`.
 */
export function taskToJobRequest(req: CreateTaskRequest, config?: ResolvedTaskConfig): CreateJobRequest {
  const cfg = config ?? resolveTaskConfig(req);
  if (cfg.routesTo !== 'job') {
    throw new Error('Cannot convert autonomous task (iterations > 1) to a job request');
  }

  const jobReq: CreateJobRequest = {
    description: req.description ?? '',
    title: req.title,
    model: req.model,
    workDir: req.workDir,
    templateId: req.templateId,
    projectId: req.projectId,
    useWorktree: cfg.useWorktree,
    stopMode: req.stopMode,
    stopValue: req.stopValue,
    maxTurns: req.maxTurns,
    priority: req.priority,
    dependsOn: req.dependsOn,
    interactive: req.interactive,
    repeatIntervalMs: req.repeatIntervalMs,
    scheduledAt: req.scheduledAt,
    retryPolicy: req.retryPolicy,
    maxRetries: req.maxRetries,
    completionChecks: req.completionChecks,
    context: req.context,
    debate: req.debate,
    debateClaudeModel: req.debateClaudeModel,
    debateCodexModel: req.debateCodexModel,
    debateMaxRounds: req.debateMaxRounds,
  };

  // Wire up review when enabled
  if (cfg.review) {
    jobReq.reviewConfig = req.reviewConfig ?? buildReviewConfig(req.reviewerModel);
  }

  return jobReq;
}

// ─── Conversion: Task → Workflow ────────────────────────────────────────────

/**
 * Convert a CreateTaskRequest into a CreateWorkflowRequest for the existing
 * AutonomousAgentRunManager.  Only valid when `resolveTaskConfig(req).routesTo === 'workflow'`.
 */
export function taskToWorkflowRequest(req: CreateTaskRequest, config?: ResolvedTaskConfig): CreateWorkflowRequest {
  const cfg = config ?? resolveTaskConfig(req);
  if (cfg.routesTo !== 'workflow') {
    throw new Error('Cannot convert single-pass task (iterations = 1) to a workflow request');
  }

  if (!req.description?.trim()) {
    throw new Error('Workflow tasks require a description (templateId alone is not sufficient)');
  }

  return {
    task: req.description,
    title: req.title,
    workDir: req.workDir,
    implementerModel: req.model,
    reviewerModel: req.reviewerModel,
    maxCycles: cfg.iterations,
    useWorktree: cfg.useWorktree,
    templateId: req.templateId,
    projectId: req.projectId,
    completionThreshold: req.completionThreshold,
    // Per-phase stopping conditions
    maxTurnsAssess: req.maxTurnsAssess,
    maxTurnsReview: req.maxTurnsReview,
    maxTurnsImplement: req.maxTurnsImplement,
    stopModeAssess: req.stopModeAssess,
    stopValueAssess: req.stopValueAssess,
    stopModeReview: req.stopModeReview,
    stopValueReview: req.stopValueReview,
    stopModeImplement: req.stopModeImplement,
    stopValueImplement: req.stopValueImplement,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function clampIterations(n: number): number {
  return Math.min(Math.max(Math.round(n), 1), 50);
}

function buildReviewConfig(reviewerModel?: string): ReviewConfig {
  return {
    models: [reviewerModel?.trim() || 'codex'],
    auto: true,
  };
}
