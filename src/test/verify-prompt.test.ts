/**
 * Tests for verify-phase prompt rendering:
 * - renderVerifyFailure helper in WorkflowPrompts.ts
 * - buildImplementPrompt includes verify failure section when context provides it
 */
import { describe, it, expect } from 'vitest';
import {
  renderVerifyFailure,
  buildImplementPrompt,
  type InlineWorkflowContext,
} from '../server/orchestrator/WorkflowPrompts.js';
import type { Workflow } from '../shared/types.js';

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf-verify-prompt',
    title: 'Verify Prompt Test',
    task: 'Test verify prompts',
    status: 'running',
    current_phase: 'implement',
    current_cycle: 2,
    max_cycles: 10,
    milestones_total: 3,
    milestones_done: 1,
    implementer_model: 'claude-sonnet-4-6',
    reviewer_model: 'codex',
    work_dir: '/tmp/test',
    worktree_path: null,
    worktree_branch: 'feature-branch',
    blocked_reason: null,
    pr_url: null,
    project_id: null,
    template_id: null,
    use_worktree: 1,
    max_turns_assess: 50,
    max_turns_review: 30,
    max_turns_implement: 100,
    stop_mode_assess: 'turns',
    stop_value_assess: 50,
    stop_mode_review: 'turns',
    stop_value_review: 30,
    stop_mode_implement: 'turns',
    stop_value_implement: 100,
    completion_threshold: 1.0,
    verify_command: null,
    max_verify_retries: 2,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  } as Workflow;
}

// ─── renderVerifyFailure ─────────────────────────────────────────────────────

describe('renderVerifyFailure', () => {
  it('returns empty string when failure is null', () => {
    expect(renderVerifyFailure(null)).toBe('');
  });

  it('returns empty string when failure is undefined', () => {
    expect(renderVerifyFailure(undefined)).toBe('');
  });

  it('includes command, exit code, and attempt in the output', () => {
    const out = renderVerifyFailure({
      command: 'npx tsx scripts/smoke.ts',
      exitCode: 1,
      stdout: '',
      stderr: 'Connection refused',
      attempt: 1,
      durationMs: 3200,
    });
    expect(out).toContain('Verification Failed');
    expect(out).toContain('npx tsx scripts/smoke.ts');
    expect(out).toContain('exit');
    expect(out).toContain('1');
    expect(out).toContain('attempt 1');
  });

  it('includes stderr in the output', () => {
    const out = renderVerifyFailure({
      command: 'npm test',
      exitCode: 2,
      stdout: '',
      stderr: 'Error: ECONNREFUSED 127.0.0.1:5432',
      attempt: 2,
      durationMs: 500,
    });
    expect(out).toContain('stderr');
    expect(out).toContain('ECONNREFUSED');
  });

  it('includes stdout in the output when present', () => {
    const out = renderVerifyFailure({
      command: 'npm test',
      exitCode: 1,
      stdout: 'Running tests...\nFAILED: 3 tests',
      stderr: '',
      attempt: 1,
      durationMs: 1000,
    });
    expect(out).toContain('stdout');
    expect(out).toContain('FAILED: 3 tests');
  });

  it('truncates very long output at 5000 chars', () => {
    const longStderr = 'x'.repeat(10_000);
    const out = renderVerifyFailure({
      command: 'cmd',
      exitCode: 1,
      stdout: '',
      stderr: longStderr,
      attempt: 1,
      durationMs: 100,
    });
    expect(out).toContain('truncated');
    // Should not include the full 10k string
    expect(out.length).toBeLessThan(longStderr.length);
  });
});

// ─── buildImplementPrompt with verify failure ─────────────────────────────────

describe('buildImplementPrompt with verifyFailure context', () => {
  it('does NOT include verification failed section when verifyFailure is absent', () => {
    const ctx: InlineWorkflowContext = {
      plan: '- [ ] M1',
      contract: 'Contract',
    };
    const prompt = buildImplementPrompt(makeWorkflow(), 2, ctx);
    expect(prompt).not.toContain('Verification Failed');
  });

  it('does NOT include verification failed section when verifyFailure is null', () => {
    const ctx: InlineWorkflowContext = {
      plan: '- [ ] M1',
      verifyFailure: null,
    };
    const prompt = buildImplementPrompt(makeWorkflow(), 2, ctx);
    expect(prompt).not.toContain('Verification Failed');
  });

  it('includes verification failed section when verifyFailure is provided', () => {
    const ctx: InlineWorkflowContext = {
      plan: '- [ ] M1',
      verifyFailure: {
        command: 'doppler run -- npm test',
        exitCode: 1,
        stdout: '',
        stderr: 'Test suite failed to run',
        attempt: 1,
        durationMs: 800,
      },
    };
    const prompt = buildImplementPrompt(makeWorkflow(), 2, ctx);
    expect(prompt).toContain('Verification Failed');
    expect(prompt).toContain('doppler run -- npm test');
    expect(prompt).toContain('Test suite failed to run');
    expect(prompt).toContain('exit');
    expect(prompt).toContain('1');
  });

  it('verify section appears before the task/instructions section', () => {
    const ctx: InlineWorkflowContext = {
      verifyFailure: {
        command: 'cmd',
        exitCode: 3,
        stdout: '',
        stderr: 'runtime error',
        attempt: 2,
        durationMs: 1500,
      },
    };
    const prompt = buildImplementPrompt(makeWorkflow(), 2, ctx);
    const verifyIdx = prompt.indexOf('Verification Failed');
    const taskIdx = prompt.indexOf('## Task');
    // Verify section should come before ## Task section
    expect(verifyIdx).toBeGreaterThanOrEqual(0);
    expect(taskIdx).toBeGreaterThan(verifyIdx);
  });
});

// ─── task normalization: verify fields ───────────────────────────────────────

describe('taskNormalization: verify fields', () => {
  it('validateTaskRequest rejects verifyCommand on job-routed tasks', async () => {
    const { validateTaskRequest } = await import('../shared/taskNormalization.js');
    const err = validateTaskRequest({ description: 'task', iterations: 1, verifyCommand: 'exit 0' });
    expect(err).toMatch(/verifyCommand.*workflow-only/i);
  });

  it('validateTaskRequest rejects maxVerifyRetries on job-routed tasks', async () => {
    const { validateTaskRequest } = await import('../shared/taskNormalization.js');
    const err = validateTaskRequest({ description: 'task', iterations: 1, maxVerifyRetries: 3 });
    expect(err).toMatch(/maxVerifyRetries.*workflow-only/i);
  });

  it('validateTaskRequest accepts verifyCommand on workflow-routed tasks', async () => {
    const { validateTaskRequest } = await import('../shared/taskNormalization.js');
    const err = validateTaskRequest({ description: 'task', iterations: 5, verifyCommand: 'exit 0' });
    expect(err).toBeNull();
  });

  it('taskToWorkflowRequest passes verifyCommand and maxVerifyRetries through', async () => {
    const { taskToWorkflowRequest } = await import('../shared/taskNormalization.js');
    const req = taskToWorkflowRequest({
      description: 'build it',
      iterations: 5,
      verifyCommand: 'npx tsx smoke.ts',
      maxVerifyRetries: 3,
    });
    expect(req.verifyCommand).toBe('npx tsx smoke.ts');
    expect(req.maxVerifyRetries).toBe(3);
  });

  it('taskToWorkflowRequest leaves verifyCommand undefined when not set', async () => {
    const { taskToWorkflowRequest } = await import('../shared/taskNormalization.js');
    const req = taskToWorkflowRequest({ description: 'build it', iterations: 5 });
    expect(req.verifyCommand).toBeUndefined();
    expect(req.maxVerifyRetries).toBeUndefined();
  });
});
