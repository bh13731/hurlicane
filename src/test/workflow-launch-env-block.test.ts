/**
 * Regression test for Sentry issue 7398855174.
 *
 * Reproduces the exact path: a workflow phase fails with `launch_environment`
 * classification (e.g. during graceful shutdown), no fallback model is
 * available, and `updateAndEmit` blocks the workflow. The `operationalBlock`
 * flag on `updateAndEmit` ensures fallback-eligible failure exhaustion is
 * treated as operational, suppressing the noisy Sentry error.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setupTestDb,
  cleanupTestDb,
  createSocketMock,
  resetManagerState,
  insertTestProject,
  insertTestWorkflow,
  insertTestJob,
} from './helpers.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock(import('fs'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
  };
});

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execSync: vi.fn((cmd: string) => {
    if (typeof cmd === 'string' && cmd.includes('--is-inside-work-tree')) {
      return Buffer.from('true\n');
    }
    if (typeof cmd === 'string' && cmd.includes('rev-parse HEAD') && !cmd.includes('--abbrev-ref')) {
      return Buffer.from('abc123\n');
    }
    if (typeof cmd === 'string' && cmd.includes('rev-parse --abbrev-ref HEAD')) {
      return Buffer.from('expected-branch\n');
    }
    return Buffer.from('');
  }),
}));

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

vi.mock('../server/orchestrator/WorkflowPrompts.js', () => ({
  buildAssessPrompt: vi.fn(() => 'mock assess prompt'),
  buildReviewPrompt: vi.fn(() => 'mock review prompt'),
  buildImplementPrompt: vi.fn(() => 'mock implement prompt'),
  buildWorkflowRepairPrompt: vi.fn(() => 'mock repair prompt'),
  buildSimplifiedAssessRepairPrompt: vi.fn(() => 'mock simplified assess repair prompt'),
}));

// ModelClassifier: all models are unavailable (simulates shutdown / total rate-limit).
// This reproduces the Sentry scenario where no fallback model is available at all.
vi.mock('../server/orchestrator/ModelClassifier.js', () => ({
  getAvailableModel: vi.fn(() => null),
  getFallbackModel: vi.fn((model: string) => model),
  getAlternateProviderModel: vi.fn(() => null),
  markModelRateLimited: vi.fn(),
  markProviderRateLimited: vi.fn(),
  getModelProvider: vi.fn((model: string) => model.startsWith('codex') ? 'openai' : 'anthropic'),
  resolveModel: vi.fn(async (job: any) => job.model ?? 'claude-sonnet-4-6'),
  _resetForTest: vi.fn(),
}));

// FailureClassifier: launch_environment is fallback-eligible.
vi.mock('../server/orchestrator/FailureClassifier.js', () => ({
  classifyJobFailure: vi.fn(() => 'launch_environment'),
  isFallbackEligibleFailure: vi.fn((kind: string) =>
    kind === 'launch_environment'
      || kind === 'rate_limit'
      || kind === 'provider_overload'
      || kind === 'provider_capability'
      || kind === 'provider_billing'
      || kind === 'auth_failure'
  ),
  isSameModelRetryEligible: vi.fn(() => false),
  shouldMarkProviderUnavailable: vi.fn(() => false),
  _resetWarnedUnclassifiedForTest: vi.fn(),
}));

// Mock Sentry so we can assert captureException calls.
vi.mock('../server/instrument.js', () => ({
  captureWithContext: vi.fn(),
  Sentry: { captureException: vi.fn() },
}));

// ─────────────────────────────────────────────────────────────────────────────

describe('WorkflowManager: launch_environment + no-fallback Sentry path (issue 7398855174)', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('blocks workflow when implement phase fails with launch_environment and no fallback model', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 1,
      implementer_model: 'codex',
    });
    queries.upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [ ] M2', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'implement',
      status: 'failed',
      model: 'codex',
    });

    onJobCompleted(job);

    const updated = queries.getWorkflowById(workflow.id)!;
    expect(updated.status).toBe('blocked');
    expect(updated.blocked_reason).toContain('launch_environment');
    expect(updated.blocked_reason).toContain('no fallback model available');
  });

  it('blocked reason includes the phase name and current model', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 1,
      implementer_model: 'codex',
    });
    queries.upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [ ] M2', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'implement',
      status: 'failed',
      model: 'codex',
    });

    onJobCompleted(job);

    const updated = queries.getWorkflowById(workflow.id)!;
    expect(updated.blocked_reason).toContain("Phase 'implement'");
    expect(updated.blocked_reason).toContain('codex');
  });

  it('does NOT fire Sentry for launch_environment no-fallback block (operational — fixed by M2)', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');
    const { Sentry } = await import('../server/instrument.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 1,
      implementer_model: 'codex',
    });
    queries.upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [ ] M2', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'implement',
      status: 'failed',
      model: 'codex',
    });

    onJobCompleted(job);

    // Fallback-eligible failures (launch_environment, rate_limit, etc.) that exhaust all
    // fallback models are operational — they happen during shutdown or provider outages.
    // The operationalBlock flag on updateAndEmit suppresses Sentry for these.
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('does NOT fire Sentry for operational blocks like max-cycles (negative control)', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');
    const { Sentry } = await import('../server/instrument.js');
    const { classifyJobFailure } = await import('../server/orchestrator/FailureClassifier.js');

    // Override classifier to return something non-fallback-eligible
    vi.mocked(classifyJobFailure).mockReturnValue('unknown');

    const project = await insertTestProject();
    // Workflow at max_cycles=1, implement completing cycle 1
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 1,
      max_cycles: 1,
      implementer_model: 'codex',
    });
    queries.upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [ ] M2', null);
    queries.upsertNote(`workflow/${workflow.id}/contract`, '# contract', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'implement',
      status: 'done',
    });

    onJobCompleted(job);

    const updated = queries.getWorkflowById(workflow.id)!;
    expect(updated.status).toBe('blocked');
    expect(updated.blocked_reason).toContain('max cycles');
    // Operational — Sentry should NOT fire
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('writes an operational-block note when blocking for no-fallback', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');
    const { classifyJobFailure } = await import('../server/orchestrator/FailureClassifier.js');
    // Restore mock after the negative-control test overrides it to 'unknown'
    vi.mocked(classifyJobFailure).mockReturnValue('launch_environment');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 1,
      implementer_model: 'codex',
    });
    queries.upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [ ] M2', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'implement',
      status: 'failed',
      model: 'codex',
    });

    onJobCompleted(job);

    // The operational-block note should be present for recovery
    const note = queries.getNote(`workflow/${workflow.id}/operational-block`);
    expect(note).not.toBeNull();
    const parsed = JSON.parse(note!.value);
    expect(parsed.phase).toBe('implement');
    expect(parsed.cycle).toBe(1);
    expect(parsed.model).toBe('codex');
    expect(parsed.failureKind).toBe('launch_environment');
  });
});

describe('WorkflowManager: operational-block recovery in reconcileRunningWorkflows', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();
    // Restore default mock implementations that individual tests may override
    const { getAvailableModel } = await import('../server/orchestrator/ModelClassifier.js');
    vi.mocked(getAvailableModel).mockImplementation(() => null);
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('recovers a blocked workflow when the original model becomes available', async () => {
    const { reconcileRunningWorkflows } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');
    const { getAvailableModel } = await import('../server/orchestrator/ModelClassifier.js');
    const socket = await import('../server/socket/SocketManager.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'blocked',
      current_phase: 'implement',
      current_cycle: 1,
      implementer_model: 'codex',
    });
    queries.upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [ ] M2', null);
    queries.upsertNote(`workflow/${workflow.id}/contract`, '# contract', null);

    // The failed job that caused the block
    await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'implement',
      status: 'failed',
      model: 'codex',
    });

    // Write the operational-block note (as _onJobCompleted would)
    queries.upsertNote(`workflow/${workflow.id}/operational-block`, JSON.stringify({
      phase: 'implement',
      cycle: 1,
      model: 'codex',
      failureKind: 'launch_environment',
      ts: Date.now(),
    }), null);

    // Simulate model becoming available again (e.g. after restart clears rate limits)
    vi.mocked(getAvailableModel).mockImplementation((model: string) => model);

    reconcileRunningWorkflows();

    const updated = queries.getWorkflowById(workflow.id)!;
    expect(updated.status).toBe('running');
    expect(updated.blocked_reason).toBeNull();

    // A new phase job should have been spawned
    expect(vi.mocked(socket.emitJobNew).mock.calls.length).toBeGreaterThan(0);
    const newJob = vi.mocked(socket.emitJobNew).mock.calls[0][0];
    expect(newJob.workflow_phase).toBe('implement');

    // The operational-block note should be cleaned up
    expect(queries.getNote(`workflow/${workflow.id}/operational-block`)).toBeNull();
  });

  it('stays blocked when no model is available yet', async () => {
    const { reconcileRunningWorkflows } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'blocked',
      current_phase: 'implement',
      current_cycle: 1,
      implementer_model: 'codex',
    });

    await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'implement',
      status: 'failed',
      model: 'codex',
    });

    queries.upsertNote(`workflow/${workflow.id}/operational-block`, JSON.stringify({
      phase: 'implement',
      cycle: 1,
      model: 'codex',
      failureKind: 'launch_environment',
      ts: Date.now(),
    }), null);

    // All models still unavailable (default mock returns null for codex)
    reconcileRunningWorkflows();

    const updated = queries.getWorkflowById(workflow.id)!;
    expect(updated.status).toBe('blocked');
    // Note should remain for future recovery attempts
    expect(queries.getNote(`workflow/${workflow.id}/operational-block`)).not.toBeNull();
  });

  it('does not touch blocked workflows without an operational-block note', async () => {
    const { reconcileRunningWorkflows } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');
    const { getAvailableModel } = await import('../server/orchestrator/ModelClassifier.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'blocked',
      current_phase: 'implement',
      current_cycle: 1,
      implementer_model: 'codex',
    });

    await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'implement',
      status: 'failed',
      model: 'codex',
    });

    // No operational-block note — this is a non-operational block (e.g. code failure)

    // Even if models are available, the workflow should not be recovered
    vi.mocked(getAvailableModel).mockImplementation((model: string) => model);

    reconcileRunningWorkflows();

    const updated = queries.getWorkflowById(workflow.id)!;
    expect(updated.status).toBe('blocked');
  });

  it('recovers with a fallback model when original is still unavailable', async () => {
    const { reconcileRunningWorkflows } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');
    const { getAvailableModel } = await import('../server/orchestrator/ModelClassifier.js');
    const socket = await import('../server/socket/SocketManager.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'blocked',
      current_phase: 'implement',
      current_cycle: 1,
      implementer_model: 'codex',
    });
    queries.upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [ ] M2', null);
    queries.upsertNote(`workflow/${workflow.id}/contract`, '# contract', null);

    await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'implement',
      status: 'failed',
      model: 'codex',
    });

    queries.upsertNote(`workflow/${workflow.id}/operational-block`, JSON.stringify({
      phase: 'implement',
      cycle: 1,
      model: 'codex',
      failureKind: 'launch_environment',
      ts: Date.now(),
    }), null);

    // Original model (codex) still unavailable, but Claude is available as fallback
    vi.mocked(getAvailableModel).mockImplementation((model: string) => {
      if (model === 'codex') return null;
      return model;
    });

    reconcileRunningWorkflows();

    const updated = queries.getWorkflowById(workflow.id)!;
    expect(updated.status).toBe('running');

    // Should have spawned with a fallback model (not codex)
    expect(vi.mocked(socket.emitJobNew).mock.calls.length).toBeGreaterThan(0);
    const newJob = vi.mocked(socket.emitJobNew).mock.calls[0][0];
    expect(newJob.workflow_phase).toBe('implement');
    expect(newJob.model).not.toBe('codex');
  });
});
