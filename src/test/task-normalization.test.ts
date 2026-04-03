/**
 * Tests for the unified task normalization layer.
 * Pure functions — no DB, no socket mocking needed.
 */
import { describe, it, expect } from 'vitest';
import {
  inferPreset,
  resolveTaskConfig,
  validateTaskRequest,
  taskToJobRequest,
  taskToWorkflowRequest,
} from '../shared/taskNormalization.js';
import type { CreateTaskRequest } from '../shared/types.js';

// ─── inferPreset ────────────────────────────────────────────────────────────

describe('inferPreset', () => {
  it('returns the explicit preset when provided', () => {
    expect(inferPreset({ description: 'x', preset: 'autonomous' })).toBe('autonomous');
    expect(inferPreset({ description: 'x', preset: 'reviewed' })).toBe('reviewed');
    expect(inferPreset({ description: 'x', preset: 'quick' })).toBe('quick');
  });

  it('infers autonomous when iterations > 1', () => {
    expect(inferPreset({ description: 'x', iterations: 5 })).toBe('autonomous');
  });

  it('infers reviewed when review=true and iterations absent/1', () => {
    expect(inferPreset({ description: 'x', review: true })).toBe('reviewed');
    expect(inferPreset({ description: 'x', review: true, iterations: 1 })).toBe('reviewed');
  });

  it('infers quick by default', () => {
    expect(inferPreset({ description: 'x' })).toBe('quick');
    expect(inferPreset({ description: 'x', review: false })).toBe('quick');
  });

  it('iterations > 1 wins over review=false', () => {
    expect(inferPreset({ description: 'x', review: false, iterations: 3 })).toBe('autonomous');
  });
});

// ─── resolveTaskConfig ──────────────────────────────────────────────────────

describe('resolveTaskConfig', () => {
  it('quick preset defaults', () => {
    const cfg = resolveTaskConfig({ description: 'x', preset: 'quick' });
    expect(cfg).toEqual({
      preset: 'quick',
      routesTo: 'job',
      review: false,
      iterations: 1,
      useWorktree: false,
    });
  });

  it('reviewed preset defaults', () => {
    const cfg = resolveTaskConfig({ description: 'x', preset: 'reviewed' });
    expect(cfg).toEqual({
      preset: 'reviewed',
      routesTo: 'job',
      review: true,
      iterations: 1,
      useWorktree: true,
    });
  });

  it('autonomous preset defaults', () => {
    const cfg = resolveTaskConfig({ description: 'x', preset: 'autonomous' });
    expect(cfg).toEqual({
      preset: 'autonomous',
      routesTo: 'workflow',
      review: true,
      iterations: 10,
      useWorktree: true,
    });
  });

  it('explicit values override preset defaults', () => {
    const cfg = resolveTaskConfig({
      description: 'x',
      preset: 'quick',
      review: true,
      iterations: 5,
      useWorktree: true,
    });
    // iterations > 1 but preset was explicitly 'quick'
    expect(cfg.preset).toBe('quick');
    expect(cfg.routesTo).toBe('workflow');
    expect(cfg.review).toBe(true);
    expect(cfg.iterations).toBe(5);
    expect(cfg.useWorktree).toBe(true);
  });

  it('useWorktree defaults to true when iterations > 1 regardless of preset', () => {
    const cfg = resolveTaskConfig({ description: 'x', preset: 'quick', iterations: 3 });
    expect(cfg.useWorktree).toBe(true);
  });

  it('useWorktree can be explicitly disabled for autonomous tasks', () => {
    const cfg = resolveTaskConfig({ description: 'x', preset: 'autonomous', useWorktree: false });
    expect(cfg.useWorktree).toBe(false);
  });

  it('forces review=true for workflow-routed tasks even when explicitly false', () => {
    const cfg = resolveTaskConfig({ description: 'x', iterations: 5, review: false });
    expect(cfg.routesTo).toBe('workflow');
    expect(cfg.review).toBe(true);
  });

  it('forces review=true for autonomous preset with explicit review=false', () => {
    const cfg = resolveTaskConfig({ description: 'x', preset: 'autonomous', review: false });
    expect(cfg.routesTo).toBe('workflow');
    expect(cfg.review).toBe(true);
  });

  it('preserves review=false for job-routed tasks', () => {
    const cfg = resolveTaskConfig({ description: 'x', iterations: 1, review: false });
    expect(cfg.routesTo).toBe('job');
    expect(cfg.review).toBe(false);
  });

  it('clamps iterations to [1, 50]', () => {
    expect(resolveTaskConfig({ description: 'x', iterations: 0 }).iterations).toBe(1);
    expect(resolveTaskConfig({ description: 'x', iterations: 100 }).iterations).toBe(50);
    expect(resolveTaskConfig({ description: 'x', iterations: -5 }).iterations).toBe(1);
  });

  it('rounds fractional iterations', () => {
    expect(resolveTaskConfig({ description: 'x', iterations: 2.7 }).iterations).toBe(3);
  });

  it('routing: iterations=1 → job, iterations>1 → workflow', () => {
    expect(resolveTaskConfig({ description: 'x', iterations: 1 }).routesTo).toBe('job');
    expect(resolveTaskConfig({ description: 'x', iterations: 2 }).routesTo).toBe('workflow');
    expect(resolveTaskConfig({ description: 'x', iterations: 50 }).routesTo).toBe('workflow');
  });
});

// ─── validateTaskRequest ────────────────────────────────────────────────────

describe('validateTaskRequest', () => {
  it('requires description or templateId', () => {
    expect(validateTaskRequest({})).toMatch(/description is required/);
    expect(validateTaskRequest({ description: '' })).toMatch(/description is required/);
    expect(validateTaskRequest({ description: '  ' })).toMatch(/description is required/);
    expect(validateTaskRequest({ description: 'do something' })).toBeNull();
  });

  it('allows template-only tasks (no description) for job-routed tasks', () => {
    expect(validateTaskRequest({ templateId: 'tpl-1' })).toBeNull();
    expect(validateTaskRequest({ description: '', templateId: 'tpl-1' })).toBeNull();
    expect(validateTaskRequest({ description: '  ', templateId: 'tpl-1' })).toBeNull();
    expect(validateTaskRequest({ templateId: 'tpl-1', preset: 'quick' })).toBeNull();
    expect(validateTaskRequest({ templateId: 'tpl-1', preset: 'reviewed' })).toBeNull();
  });

  it('rejects template-only tasks for workflow-routed tasks (autonomous)', () => {
    expect(validateTaskRequest({ templateId: 'tpl-1', iterations: 5 }))
      .toMatch(/description is required for autonomous/);
    expect(validateTaskRequest({ templateId: 'tpl-1', preset: 'autonomous' }))
      .toMatch(/description is required for autonomous/);
  });

  it('rejects out-of-range iterations', () => {
    expect(validateTaskRequest({ description: 'x', iterations: 0 })).toMatch(/iterations/);
    expect(validateTaskRequest({ description: 'x', iterations: 51 })).toMatch(/iterations/);
    expect(validateTaskRequest({ description: 'x', iterations: 1.5 })).toMatch(/iterations/);
  });

  it('rejects invalid preset', () => {
    expect(validateTaskRequest({ description: 'x', preset: 'invalid' as any })).toMatch(/invalid preset/);
  });

  it('rejects explicit review=false for workflow-routed tasks', () => {
    expect(validateTaskRequest({ description: 'x', iterations: 5, review: false }))
      .toMatch(/review cannot be disabled/);
    expect(validateTaskRequest({ description: 'x', preset: 'autonomous', review: false }))
      .toMatch(/review cannot be disabled/);
    // Quick preset with iterations override still routes to workflow
    expect(validateTaskRequest({ description: 'x', preset: 'quick', iterations: 3, review: false }))
      .toMatch(/review cannot be disabled/);
  });

  it('allows review=true or review=undefined for workflow-routed tasks', () => {
    expect(validateTaskRequest({ description: 'x', iterations: 5, review: true })).toBeNull();
    expect(validateTaskRequest({ description: 'x', iterations: 5 })).toBeNull();
    expect(validateTaskRequest({ description: 'x', preset: 'autonomous' })).toBeNull();
  });

  it('allows review=false for job-routed tasks', () => {
    expect(validateTaskRequest({ description: 'x', iterations: 1, review: false })).toBeNull();
    expect(validateTaskRequest({ description: 'x', preset: 'quick', review: false })).toBeNull();
  });

  it('rejects job-only options on autonomous tasks', () => {
    const base: CreateTaskRequest = { description: 'x', iterations: 5 };
    expect(validateTaskRequest({ ...base, dependsOn: ['abc'] })).toMatch(/dependsOn/);
    expect(validateTaskRequest({ ...base, interactive: true })).toMatch(/interactive/);
    expect(validateTaskRequest({ ...base, debate: true })).toMatch(/debate/);
    expect(validateTaskRequest({ ...base, repeatIntervalMs: 60000 })).toMatch(/repeatIntervalMs/);
    expect(validateTaskRequest({ ...base, scheduledAt: Date.now() })).toMatch(/scheduledAt/);
  });

  it('rejects single-pass stop settings on autonomous tasks', () => {
    const base: CreateTaskRequest = { description: 'x', iterations: 5 };
    expect(validateTaskRequest({ ...base, stopMode: 'turns' })).toMatch(/stopMode/);
    expect(validateTaskRequest({ ...base, stopValue: 25 })).toMatch(/stopValue/);
    expect(validateTaskRequest({ ...base, maxTurns: 25 })).toMatch(/maxTurns/);
  });

  it('rejects single-pass stop settings on autonomous preset override combinations', () => {
    expect(validateTaskRequest({
      description: 'x',
      preset: 'autonomous',
      stopMode: 'budget',
    })).toMatch(/stopMode/);

    expect(validateTaskRequest({
      description: 'x',
      preset: 'quick',
      iterations: 3,
      stopValue: 10,
    })).toMatch(/stopValue/);

    expect(validateTaskRequest({
      description: 'x',
      preset: 'reviewed',
      iterations: 4,
      maxTurns: 40,
    })).toMatch(/maxTurns/);
  });

  it('rejects priority on autonomous tasks', () => {
    expect(validateTaskRequest({ description: 'x', iterations: 5, priority: 10 }))
      .toMatch(/priority is not supported/);
    expect(validateTaskRequest({ description: 'x', preset: 'autonomous', priority: 1 }))
      .toMatch(/priority is not supported/);
  });

  it('rejects retryPolicy on autonomous tasks', () => {
    expect(validateTaskRequest({ description: 'x', iterations: 5, retryPolicy: 'analyze' }))
      .toMatch(/retryPolicy is not supported/);
  });

  it('rejects maxRetries on autonomous tasks', () => {
    expect(validateTaskRequest({ description: 'x', iterations: 5, maxRetries: 3 }))
      .toMatch(/maxRetries is not supported/);
  });

  it('rejects completionChecks on autonomous tasks', () => {
    expect(validateTaskRequest({ description: 'x', iterations: 5, completionChecks: ['lint'] }))
      .toMatch(/completionChecks is not supported/);
    // Empty array should pass (falsy length)
    expect(validateTaskRequest({ description: 'x', iterations: 5, completionChecks: [] }))
      .toBeNull();
  });

  it('rejects context on autonomous tasks', () => {
    expect(validateTaskRequest({ description: 'x', iterations: 5, context: { env: 'prod' } }))
      .toMatch(/context is not supported/);
  });

  it('rejects reviewConfig on autonomous tasks', () => {
    expect(validateTaskRequest({ description: 'x', iterations: 5, reviewConfig: { models: ['codex'], auto: true } }))
      .toMatch(/reviewConfig is not supported/);
  });

  it('rejects remaining job-only fields on preset override combinations routing to workflow', () => {
    // Quick preset with iterations override
    expect(validateTaskRequest({ description: 'x', preset: 'quick', iterations: 3, priority: 5 }))
      .toMatch(/priority is not supported/);
    // Reviewed preset with iterations override
    expect(validateTaskRequest({ description: 'x', preset: 'reviewed', iterations: 4, retryPolicy: 'same' }))
      .toMatch(/retryPolicy is not supported/);
    // Autonomous preset with context
    expect(validateTaskRequest({ description: 'x', preset: 'autonomous', context: { key: 'val' } }))
      .toMatch(/context is not supported/);
  });

  it('allows priority, retryPolicy, maxRetries, completionChecks, context, reviewConfig on job-routed tasks', () => {
    expect(validateTaskRequest({
      description: 'x',
      iterations: 1,
      priority: 10,
      retryPolicy: 'analyze',
      maxRetries: 3,
      completionChecks: ['lint', 'test'],
      context: { env: 'prod' },
      reviewConfig: { models: ['codex'], auto: true },
    })).toBeNull();
  });

  it('allows job-only options on single-pass tasks', () => {
    expect(validateTaskRequest({
      description: 'x',
      iterations: 1,
      dependsOn: ['abc'],
      interactive: true,
    })).toBeNull();
  });
});

// ─── taskToJobRequest ───────────────────────────────────────────────────────

describe('taskToJobRequest', () => {
  it('maps core fields', () => {
    const result = taskToJobRequest({
      description: 'Fix the bug',
      title: 'Bug fix',
      model: 'claude-sonnet-4-6',
      workDir: '/repo',
      templateId: 'tpl-1',
      projectId: 'proj-1',
    });
    expect(result.description).toBe('Fix the bug');
    expect(result.title).toBe('Bug fix');
    expect(result.model).toBe('claude-sonnet-4-6');
    expect(result.workDir).toBe('/repo');
    expect(result.templateId).toBe('tpl-1');
    expect(result.projectId).toBe('proj-1');
  });

  it('uses resolved useWorktree from config', () => {
    const result = taskToJobRequest({ description: 'x', preset: 'reviewed' });
    expect(result.useWorktree).toBe(true);
  });

  it('passes through advanced options', () => {
    const result = taskToJobRequest({
      description: 'x',
      priority: 10,
      dependsOn: ['a', 'b'],
      retryPolicy: 'analyze',
      maxRetries: 3,
      completionChecks: ['lint', 'test'],
      context: { env: 'prod' },
      debate: true,
      debateClaudeModel: 'claude-opus-4-6',
      debateCodexModel: 'codex',
      debateMaxRounds: 5,
    });
    expect(result.priority).toBe(10);
    expect(result.dependsOn).toEqual(['a', 'b']);
    expect(result.retryPolicy).toBe('analyze');
    expect(result.maxRetries).toBe(3);
    expect(result.completionChecks).toEqual(['lint', 'test']);
    expect(result.context).toEqual({ env: 'prod' });
    expect(result.debate).toBe(true);
    expect(result.debateClaudeModel).toBe('claude-opus-4-6');
    expect(result.debateCodexModel).toBe('codex');
    expect(result.debateMaxRounds).toBe(5);
  });

  it('auto-builds reviewConfig when review is enabled', () => {
    const result = taskToJobRequest({
      description: 'x',
      preset: 'reviewed',
      reviewerModel: 'claude-opus-4-6',
    });
    expect(result.reviewConfig).toEqual({
      models: ['claude-opus-4-6'],
      auto: true,
    });
  });

  it('uses default reviewer model in reviewConfig when not specified', () => {
    const result = taskToJobRequest({
      description: 'x',
      review: true,
    });
    expect(result.reviewConfig).toEqual({
      models: ['codex'],
      auto: true,
    });
  });

  it('preserves explicit reviewConfig over auto-built one', () => {
    const explicitConfig = { models: ['model-a', 'model-b'], auto: false };
    const result = taskToJobRequest({
      description: 'x',
      review: true,
      reviewConfig: explicitConfig,
    });
    expect(result.reviewConfig).toEqual(explicitConfig);
  });

  it('does not set reviewConfig when review is off', () => {
    const result = taskToJobRequest({ description: 'x', preset: 'quick' });
    expect(result.reviewConfig).toBeUndefined();
  });

  it('handles template-only tasks (empty description)', () => {
    const result = taskToJobRequest({ templateId: 'tpl-1' });
    expect(result.description).toBe('');
    expect(result.templateId).toBe('tpl-1');
  });

  it('handles template-only task with review enabled', () => {
    const result = taskToJobRequest({ templateId: 'tpl-1', review: true });
    expect(result.description).toBe('');
    expect(result.templateId).toBe('tpl-1');
    expect(result.reviewConfig).toEqual({ models: ['codex'], auto: true });
  });

  it('throws when called for autonomous task', () => {
    expect(() => taskToJobRequest({ description: 'x', iterations: 5 })).toThrow(/iterations > 1/);
  });
});

// ─── taskToWorkflowRequest ──────────────────────────────────────────────────

describe('taskToWorkflowRequest', () => {
  it('maps core fields using task-request field names', () => {
    const result = taskToWorkflowRequest({
      description: 'Refactor module',
      title: 'Refactor',
      model: 'claude-sonnet-4-6',
      reviewerModel: 'codex',
      iterations: 5,
      workDir: '/repo',
      templateId: 'tpl-1',
      projectId: 'proj-1',
    });
    expect(result.task).toBe('Refactor module');
    expect(result.title).toBe('Refactor');
    expect(result.implementerModel).toBe('claude-sonnet-4-6');
    expect(result.reviewerModel).toBe('codex');
    expect(result.maxCycles).toBe(5);
    expect(result.workDir).toBe('/repo');
    expect(result.templateId).toBe('tpl-1');
    expect(result.projectId).toBe('proj-1');
  });

  it('maps per-phase stop conditions', () => {
    const result = taskToWorkflowRequest({
      description: 'x',
      iterations: 3,
      maxTurnsAssess: 40,
      maxTurnsReview: 20,
      maxTurnsImplement: 80,
      stopModeAssess: 'budget',
      stopValueAssess: 5,
      stopModeReview: 'time',
      stopValueReview: 30,
      stopModeImplement: 'turns',
      stopValueImplement: 80,
      completionThreshold: 0.8,
    });
    expect(result.maxTurnsAssess).toBe(40);
    expect(result.maxTurnsReview).toBe(20);
    expect(result.maxTurnsImplement).toBe(80);
    expect(result.stopModeAssess).toBe('budget');
    expect(result.stopValueAssess).toBe(5);
    expect(result.stopModeReview).toBe('time');
    expect(result.stopValueReview).toBe(30);
    expect(result.stopModeImplement).toBe('turns');
    expect(result.stopValueImplement).toBe(80);
    expect(result.completionThreshold).toBe(0.8);
  });

  it('throws on stopMode (single-pass field unsupported for workflows)', () => {
    expect(() => taskToWorkflowRequest({
      description: 'x',
      iterations: 3,
      stopMode: 'turns',
    })).toThrow(/stopMode is not supported for workflow/);
  });

  it('throws on stopValue (single-pass field unsupported for workflows)', () => {
    expect(() => taskToWorkflowRequest({
      description: 'x',
      iterations: 3,
      stopValue: 99,
    })).toThrow(/stopValue is not supported for workflow/);
  });

  it('throws on maxTurns (single-pass field unsupported for workflows)', () => {
    expect(() => taskToWorkflowRequest({
      description: 'x',
      iterations: 3,
      maxTurns: 99,
    })).toThrow(/maxTurns is not supported for workflow/);
  });

  it('throws on all three single-pass stop fields together', () => {
    expect(() => taskToWorkflowRequest({
      description: 'x',
      iterations: 3,
      stopMode: 'turns',
      stopValue: 99,
      maxTurns: 99,
    })).toThrow(/stopMode is not supported for workflow/);
  });

  it('throws on priority (job-only field unsupported for workflows)', () => {
    expect(() => taskToWorkflowRequest({
      description: 'x',
      iterations: 3,
      priority: 10,
    })).toThrow(/priority is not supported for workflow/);
  });

  it('throws on retryPolicy (job-only field unsupported for workflows)', () => {
    expect(() => taskToWorkflowRequest({
      description: 'x',
      iterations: 3,
      retryPolicy: 'analyze',
    })).toThrow(/retryPolicy is not supported for workflow/);
  });

  it('throws on maxRetries (job-only field unsupported for workflows)', () => {
    expect(() => taskToWorkflowRequest({
      description: 'x',
      iterations: 3,
      maxRetries: 3,
    })).toThrow(/maxRetries is not supported for workflow/);
  });

  it('throws on completionChecks (job-only field unsupported for workflows)', () => {
    expect(() => taskToWorkflowRequest({
      description: 'x',
      iterations: 3,
      completionChecks: ['lint', 'test'],
    })).toThrow(/completionChecks is not supported for workflow/);
  });

  it('allows empty completionChecks array on workflow tasks', () => {
    const result = taskToWorkflowRequest({
      description: 'x',
      iterations: 3,
      completionChecks: [],
    });
    expect(result.task).toBe('x');
  });

  it('throws on context (job-only field unsupported for workflows)', () => {
    expect(() => taskToWorkflowRequest({
      description: 'x',
      iterations: 3,
      context: { env: 'prod' },
    })).toThrow(/context is not supported for workflow/);
  });

  it('throws on reviewConfig (job-only field unsupported for workflows)', () => {
    expect(() => taskToWorkflowRequest({
      description: 'x',
      iterations: 3,
      reviewConfig: { models: ['codex'], auto: true },
    })).toThrow(/reviewConfig is not supported for workflow/);
  });

  it('uses resolved useWorktree from config', () => {
    const result = taskToWorkflowRequest({
      description: 'x',
      iterations: 10,
      useWorktree: false,
    });
    expect(result.useWorktree).toBe(false);
  });

  it('throws when called for single-pass task', () => {
    expect(() => taskToWorkflowRequest({ description: 'x', iterations: 1 })).toThrow(/iterations = 1/);
  });

  it('throws when description is missing (template-only)', () => {
    expect(() => taskToWorkflowRequest({ templateId: 'tpl-1', iterations: 5 }))
      .toThrow(/Workflow tasks require a description/);
  });
});

// ─── Round-trip: preset → resolve → convert determinism ─────────────────────

describe('round-trip determinism', () => {
  it('quick preset always routes to job', () => {
    const req: CreateTaskRequest = { description: 'hello', preset: 'quick' };
    const cfg = resolveTaskConfig(req);
    expect(cfg.routesTo).toBe('job');
    const job = taskToJobRequest(req, cfg);
    expect(job.description).toBe('hello');
    expect(job.useWorktree).toBe(false);
    expect(job.reviewConfig).toBeUndefined();
  });

  it('reviewed preset routes to job with review', () => {
    const req: CreateTaskRequest = { description: 'review me', preset: 'reviewed' };
    const cfg = resolveTaskConfig(req);
    expect(cfg.routesTo).toBe('job');
    const job = taskToJobRequest(req, cfg);
    expect(job.useWorktree).toBe(true);
    expect(job.reviewConfig).toEqual({ models: ['codex'], auto: true });
  });

  it('autonomous preset routes to workflow', () => {
    const req: CreateTaskRequest = { description: 'big task', preset: 'autonomous' };
    const cfg = resolveTaskConfig(req);
    expect(cfg.routesTo).toBe('workflow');
    const wf = taskToWorkflowRequest(req, cfg);
    expect(wf.task).toBe('big task');
    expect(wf.maxCycles).toBe(10);
    expect(wf.useWorktree).toBe(true);
  });

  it('template-only task routes to job with empty description', () => {
    const req: CreateTaskRequest = { templateId: 'tpl-1' };
    expect(validateTaskRequest(req)).toBeNull();
    const cfg = resolveTaskConfig(req);
    expect(cfg.routesTo).toBe('job');
    const job = taskToJobRequest(req, cfg);
    expect(job.description).toBe('');
    expect(job.templateId).toBe('tpl-1');
  });

  it('same input always produces the same output', () => {
    const req: CreateTaskRequest = { description: 'test', model: 'claude-opus-4-6', iterations: 3 };
    const a = resolveTaskConfig(req);
    const b = resolveTaskConfig(req);
    expect(a).toEqual(b);
    expect(taskToWorkflowRequest(req, a)).toEqual(taskToWorkflowRequest(req, b));
  });
});
