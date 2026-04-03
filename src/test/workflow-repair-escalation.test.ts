/**
 * Tests for M16/4B — Escalating repair budget.
 *
 * Verifies:
 * 1. Repair escalates through 3 levels (quick, diagnostic, full re-assess)
 * 2. Each level gets progressively more turns
 * 3. After 3 attempts, repair returns false (caller blocks workflow)
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

// Mock fs.existsSync so pre-flight checks pass
vi.mock(import('fs'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
  };
});

// Mock child_process.execSync for branch verification
vi.mock('child_process', () => ({
  exec: vi.fn(),
  execSync: vi.fn((cmd: string) => {
    if (typeof cmd === 'string' && cmd.includes('rev-parse --abbrev-ref HEAD')) {
      return Buffer.from('expected-branch\n');
    }
    return Buffer.from('');
  }),
}));

vi.mock('../server/instrument.js', () => ({
  captureWithContext: vi.fn(),
  Sentry: { captureException: vi.fn() },
}));

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

vi.mock('../server/orchestrator/WorkflowPrompts.js', () => ({
  buildAssessPrompt: vi.fn(() => 'mock assess prompt'),
  buildReviewPrompt: vi.fn(() => 'mock review prompt'),
  buildImplementPrompt: vi.fn(() => 'mock implement prompt'),
  buildWorkflowRepairPrompt: vi.fn(() => 'mock repair prompt'),
}));

vi.mock('../server/orchestrator/ModelClassifier.js', () => ({
  getAvailableModel: vi.fn((model: string) => model),
  getFallbackModel: vi.fn((model: string) => model),
  getAlternateProviderModel: vi.fn(() => null),
  markModelRateLimited: vi.fn(),
  markProviderRateLimited: vi.fn(),
  getModelProvider: vi.fn(() => 'anthropic'),
  resolveModel: vi.fn(async (job: any) => job.model ?? 'claude-sonnet-4-6'),
  _resetForTest: vi.fn(),
}));

vi.mock('../server/orchestrator/FailureClassifier.js', () => ({
  classifyJobFailure: vi.fn(() => 'unknown'),
  isFallbackEligibleFailure: vi.fn(() => false),
  isSameModelRetryEligible: vi.fn(() => false),
  shouldMarkProviderUnavailable: vi.fn(() => false),
  _resetWarnedUnclassifiedForTest: vi.fn(),
}));

describe('WorkflowManager: escalating repair budget (M16/4B)', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('escalates through 3 repair levels with increasing turn budgets', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getWorkflowById, getJobsForWorkflow } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'assess',
      current_cycle: 0,
    });

    // Simulate 3 failed assess phases (no plan written)
    upsertNote(`workflow/${workflow.id}/contract`, 'test contract', null);

    // First repair attempt: quick repair
    const job1 = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      status: 'done',
    });
    onJobCompleted(job1);

    let jobs = getJobsForWorkflow(workflow.id);
    let repairJobs = jobs.filter(j => j.title?.includes('repair'));
    expect(repairJobs).toHaveLength(1);
    expect(repairJobs[0].title).toContain('quick repair');
    const quickTurns = repairJobs[0].max_turns;

    // Second repair attempt: diagnostic repair
    const job2 = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      status: 'done',
    });
    onJobCompleted(job2);

    jobs = getJobsForWorkflow(workflow.id);
    repairJobs = jobs.filter(j => j.title?.includes('repair'));
    expect(repairJobs).toHaveLength(2);
    expect(repairJobs[1].title).toContain('diagnostic repair');
    const diagnosticTurns = repairJobs[1].max_turns;
    expect(diagnosticTurns).toBeGreaterThan(quickTurns!);

    // Third repair attempt: full re-assess repair
    const job3 = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      status: 'done',
    });
    onJobCompleted(job3);

    jobs = getJobsForWorkflow(workflow.id);
    repairJobs = jobs.filter(j => j.title?.includes('repair'));
    expect(repairJobs).toHaveLength(3);
    expect(repairJobs[2].title).toContain('full re-assess repair');
    const fullTurns = repairJobs[2].max_turns;
    expect(fullTurns).toBeGreaterThan(diagnosticTurns!);
  });

  it('blocks workflow after 3 repair attempts are exhausted', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getWorkflowById, getNote } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'assess',
      current_cycle: 0,
    });

    upsertNote(`workflow/${workflow.id}/contract`, 'test contract', null);
    // Pre-set repair attempts to 3 (all exhausted)
    upsertNote(`workflow/${workflow.id}/repair/assess/cycle-0`, '3', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      status: 'done',
    });
    onJobCompleted(job);

    const updated = getWorkflowById(workflow.id)!;
    expect(updated.status).toBe('blocked');
  });
});
