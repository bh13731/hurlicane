/**
 * AgentRunner.handleJobCompletion: deferred git diff capture tests.
 *
 * Proves:
 * 1. Workflow/debate callbacks fire without waiting for async diff capture.
 * 2. The deferred diff is stored and the agent record is re-emitted.
 * 3. When completion_checks includes 'diff_not_empty', diff is captured
 *    synchronously (execSync) before the check runs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setupTestDb,
  cleanupTestDb,
  createSocketMock,
  resetManagerState,
  insertTestJob,
} from './helpers.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

vi.mock('../server/orchestrator/PtyManager.js', () => ({
  startInteractiveAgent: vi.fn(),
  isTmuxSessionAlive: vi.fn(() => false),
  saveSnapshot: vi.fn(),
  ensureCodexTrusted: vi.fn(),
}));

vi.mock('../server/orchestrator/ModelClassifier.js', () => ({
  resolveModel: vi.fn(async (job: any) => job.model ?? 'claude-sonnet-4-6'),
  getFallbackModel: vi.fn((m: string) => m),
  markModelRateLimited: vi.fn(),
  markProviderRateLimited: vi.fn(),
  getModelProvider: vi.fn(() => 'anthropic'),
  _resetForTest: vi.fn(),
}));

vi.mock('../server/orchestrator/WorkflowPrompts.js', () => ({
  buildAssessPrompt: vi.fn(() => 'mock assess'),
  buildReviewPrompt: vi.fn(() => 'mock review'),
  buildImplementPrompt: vi.fn(() => 'mock implement'),
  buildWorkflowRepairPrompt: vi.fn(() => 'mock repair'),
}));

vi.mock('../server/orchestrator/FailureClassifier.js', () => ({
  classifyJobFailure: vi.fn(() => 'unknown'),
  isFallbackEligibleFailure: vi.fn(() => false),
  isSameModelRetryEligible: vi.fn(() => false),
  shouldMarkProviderUnavailable: vi.fn(() => false),
}));

// Track which git commands go through sync vs async paths
const execSyncCalls: string[] = [];
const execAsyncCalls: string[] = [];
let execAsyncDiffContent = '';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn((cmd: string) => {
    execSyncCalls.push(cmd);
    return Buffer.from('');
  }),
  exec: vi.fn((cmd: string, _opts: any, cb: any) => {
    execAsyncCalls.push(cmd);
    // Resolve on next microtask so the deferred promise settles
    const stdout = cmd.includes('git log --patch') ? execAsyncDiffContent : '';
    process.nextTick(() => cb(null, { stdout, stderr: '' }));
    return { on: vi.fn() };
  }),
}));

vi.mock('../server/orchestrator/WorkflowManager.js', () => ({
  onJobCompleted: vi.fn(),
  _resetForTest: vi.fn(),
}));

vi.mock('../server/orchestrator/DebateManager.js', () => ({
  onJobCompleted: vi.fn(),
  _resetForTest: vi.fn(),
}));

vi.mock('../server/orchestrator/CompletionChecks.js', () => ({
  runCompletionChecks: vi.fn(() => null),
}));

vi.mock('../server/orchestrator/RetryManager.js', () => ({
  handleRetry: vi.fn(),
}));

vi.mock('../server/orchestrator/MemoryTriager.js', () => ({
  triageLearnings: vi.fn(async () => {}),
}));

vi.mock('../server/orchestrator/RecoveryLedger.js', () => ({
  claimRecovery: vi.fn(),
  clearRecoveryState: vi.fn(),
  _resetForTest: vi.fn(),
}));

vi.mock('../server/orchestrator/PrCreator.js', () => ({
  createPrForJob: vi.fn(async () => null),
  pushBranchForFailedJob: vi.fn(),
}));

vi.mock('../server/orchestrator/EyeConfig.js', () => ({
  buildEyePrompt: vi.fn(() => 'mock eye prompt'),
  isEyeJob: vi.fn(() => false),
}));

vi.mock('../server/orchestrator/FileLockRegistry.js', () => ({
  getFileLockRegistry: vi.fn(() => ({
    releaseAll: vi.fn(),
  })),
}));

describe('AgentRunner: deferred diff capture', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    execSyncCalls.length = 0;
    execAsyncCalls.length = 0;
    execAsyncDiffContent = '';
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('workflow callbacks fire without waiting for deferred diff capture', async () => {
    const queries = await import('../server/db/queries.js');
    const { handleJobCompletion } = await import('../server/orchestrator/AgentRunner.js');
    const { onJobCompleted: wfCallback } = await import('../server/orchestrator/WorkflowManager.js');

    // Job with no completion_checks — typical workflow job
    const job = await insertTestJob({ id: 'diff-order-job', status: 'running' });
    const agent = queries.insertAgent({ id: 'diff-order-agent', job_id: job.id, status: 'running' });
    queries.updateAgent(agent.id, { base_sha: 'abc123' });
    queries.updateJobStatus(job.id, 'running');

    // handleJobCompletion should complete without waiting for async diff
    await handleJobCompletion(agent.id, job, 'done');

    // Workflow callback was called during the synchronous critical path
    expect(wfCallback).toHaveBeenCalledTimes(1);

    // execSync should NOT have been called for diff (only for tag cleanup)
    const syncDiffCalls = execSyncCalls.filter(
      c => c.includes('git log --patch') || c.includes('git diff HEAD')
    );
    expect(syncDiffCalls).toHaveLength(0);

    // Async exec WAS called for diff capture (deferred path)
    const asyncDiffCalls = execAsyncCalls.filter(
      c => c.includes('git log --patch') || c.includes('git diff HEAD')
    );
    expect(asyncDiffCalls.length).toBeGreaterThanOrEqual(1);

    // Wait for deferred diff to finish
    const { _lastDeferredDiffPromise } = await import('../server/orchestrator/AgentRunner.js');
    if (_lastDeferredDiffPromise) await _lastDeferredDiffPromise;
  });

  it('diff_not_empty completion check gets synchronous diff capture', async () => {
    const queries = await import('../server/db/queries.js');
    const { handleJobCompletion } = await import('../server/orchestrator/AgentRunner.js');
    const { runCompletionChecks } = await import('../server/orchestrator/CompletionChecks.js');

    // Job WITH diff_not_empty completion check
    const job = queries.insertJob({
      id: 'sync-diff-job',
      title: 'Sync Diff Job',
      description: 'test',
      context: null,
      priority: 0,
      status: 'running' as any,
      completion_checks: JSON.stringify(['diff_not_empty']),
    });
    const agent = queries.insertAgent({ id: 'sync-diff-agent', job_id: job.id, status: 'running' });
    queries.updateAgent(agent.id, { base_sha: 'def456' });

    await handleJobCompletion(agent.id, job, 'done');

    // execSync SHOULD have been called for diff (synchronous path for completion check)
    const syncDiffCalls = execSyncCalls.filter(
      c => c.includes('git log --patch') || c.includes('git diff HEAD')
    );
    expect(syncDiffCalls).toHaveLength(2);

    // Async exec should NOT have been called for diff (already captured sync)
    const asyncDiffCalls = execAsyncCalls.filter(
      c => c.includes('git log --patch') || c.includes('git diff HEAD')
    );
    expect(asyncDiffCalls).toHaveLength(0);

    // Completion checks were still called
    expect(runCompletionChecks).toHaveBeenCalledTimes(1);
  });

  it('deferred diff capture stores the diff and re-emits agent update', async () => {
    const queries = await import('../server/db/queries.js');
    const socket = await import('../server/socket/SocketManager.js');
    const { handleJobCompletion } = await import('../server/orchestrator/AgentRunner.js');

    execAsyncDiffContent = 'diff --git a/foo.ts b/foo.ts\n+new line';

    const job = await insertTestJob({ id: 'deferred-store-job', status: 'running' });
    const agent = queries.insertAgent({ id: 'deferred-store-agent', job_id: job.id, status: 'running' });
    queries.updateAgent(agent.id, { base_sha: 'ghi789' });
    queries.updateJobStatus(job.id, 'running');

    vi.mocked(socket.emitAgentUpdate).mockClear();

    await handleJobCompletion(agent.id, job, 'done');

    // First emitAgentUpdate happens during the critical path (without diff)
    const callsBeforeDiff = vi.mocked(socket.emitAgentUpdate).mock.calls.length;
    expect(callsBeforeDiff).toBeGreaterThanOrEqual(1);

    // Wait for deferred diff to complete
    const { _lastDeferredDiffPromise } = await import('../server/orchestrator/AgentRunner.js');
    if (_lastDeferredDiffPromise) await _lastDeferredDiffPromise;

    // Agent diff should be stored
    const refreshedAgent = queries.getAgentById(agent.id);
    expect(refreshedAgent?.diff).toContain('diff --git a/foo.ts');

    // A second emitAgentUpdate was called after the diff was stored
    expect(vi.mocked(socket.emitAgentUpdate).mock.calls.length).toBeGreaterThan(callsBeforeDiff);
  });
});
