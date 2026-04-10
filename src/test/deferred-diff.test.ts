/**
 * AgentRunner.handleJobCompletion: deferred git diff capture tests.
 *
 * Proves:
 * 1. Workflow/debate callbacks fire without waiting for async diff capture.
 * 2. The deferred diff is stored and the agent record is re-emitted.
 * 3. When completion_checks includes 'diff_not_empty', diff is captured
 *    synchronously before the check runs.
 * 4. Deferred diff uses snapshot refs (endSha) captured before callbacks,
 *    so a next-phase agent in the same worktree cannot contaminate the diff.
 * 5. Uncommitted changes are snapshot-captured before callbacks fire.
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
  _resetWarnedUnclassifiedForTest: vi.fn(),
}));

// Track which git commands go through sync vs async paths
const gitSyncCalls: string[] = [];
const gitAsyncCalls: string[] = [];
let execAsyncDiffContent = '';
// Configurable per-test: what sync git helpers return for snapshot commands
let execSyncRevParseResult = '';
let execSyncUncommittedResult = '';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(() => Buffer.from('')),
  execFileSync: vi.fn((file: string, args: string[]) => {
    const cmd = [file, ...args].join(' ');
    gitSyncCalls.push(cmd);
    if (cmd.includes('git rev-parse HEAD')) return execSyncRevParseResult || 'snapshot-sha\n';
    if (cmd.includes('git diff HEAD')) return execSyncUncommittedResult;
    return '';
  }),
  execFile: vi.fn((file: string, args: string[], _opts: any, cb: any) => {
    const cmd = [file, ...args].join(' ');
    gitAsyncCalls.push(cmd);
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
    gitSyncCalls.length = 0;
    gitAsyncCalls.length = 0;
    execAsyncDiffContent = '';
    execSyncRevParseResult = '';
    execSyncUncommittedResult = '';
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

    // execSync captures snapshot refs (rev-parse + uncommitted diff) but NOT the
    // expensive git log --patch which stays on the async deferred path
    const syncPatchCalls = gitSyncCalls.filter(c => c.includes('git log --patch'));
    expect(syncPatchCalls).toHaveLength(0);

    // Snapshot commands ran synchronously before callbacks
    const syncRevParse = gitSyncCalls.filter(c => c.includes('git rev-parse HEAD'));
    expect(syncRevParse).toHaveLength(1);
    const syncUncommitted = gitSyncCalls.filter(c => c.includes('git diff HEAD'));
    expect(syncUncommitted).toHaveLength(1);

    // Async exec WAS called for committed diff capture (deferred path)
    const asyncCommittedCalls = gitAsyncCalls.filter(c => c.includes('git log --patch'));
    expect(asyncCommittedCalls).toHaveLength(1);
    // No async uncommitted diff call — captured synchronously in snapshot
    const asyncUncommittedCalls = gitAsyncCalls.filter(c => c.includes('git diff HEAD'));
    expect(asyncUncommittedCalls).toHaveLength(0);

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

    // Sync git helper SHOULD have been called for diff (synchronous path for completion check)
    const syncDiffCalls = gitSyncCalls.filter(
      c => c.includes('git log --patch') || c.includes('git diff HEAD')
    );
    expect(syncDiffCalls).toHaveLength(2);

    // Async git helper should NOT have been called for diff (already captured sync)
    const asyncDiffCalls = gitAsyncCalls.filter(
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

  it('deferred diff uses endSha snapshot instead of live HEAD', async () => {
    const queries = await import('../server/db/queries.js');
    const { handleJobCompletion } = await import('../server/orchestrator/AgentRunner.js');

    // Simulate: finishing agent's HEAD is at end-sha-111
    execSyncRevParseResult = 'end-sha-111\n';
    execAsyncDiffContent = 'committed changes from finishing agent';

    const job = await insertTestJob({ id: 'snapshot-sha-job', status: 'running' });
    const agent = queries.insertAgent({ id: 'snapshot-sha-agent', job_id: job.id, status: 'running' });
    queries.updateAgent(agent.id, { base_sha: 'base-sha-000' });
    queries.updateJobStatus(job.id, 'running');

    await handleJobCompletion(agent.id, job, 'done');

    // Wait for deferred diff
    const { _lastDeferredDiffPromise } = await import('../server/orchestrator/AgentRunner.js');
    if (_lastDeferredDiffPromise) await _lastDeferredDiffPromise;

    // The async git log command should use the captured endSha, not HEAD
    const asyncCommittedCalls = gitAsyncCalls.filter(c => c.includes('git log --patch'));
    expect(asyncCommittedCalls).toHaveLength(1);
    expect(asyncCommittedCalls[0]).toContain('base-sha-000..end-sha-111');
    expect(asyncCommittedCalls[0]).not.toContain('..HEAD');

    // No async git diff HEAD call — uncommitted snapshot was captured synchronously
    const asyncUncommittedCalls = gitAsyncCalls.filter(c => c.includes('git diff HEAD'));
    expect(asyncUncommittedCalls).toHaveLength(0);
  });

  it('uncommitted snapshot is captured before workflow callbacks and included in stored diff', async () => {
    const queries = await import('../server/db/queries.js');
    const { handleJobCompletion } = await import('../server/orchestrator/AgentRunner.js');
    const { onJobCompleted: wfCallback } = await import('../server/orchestrator/WorkflowManager.js');

    // Simulate: finishing agent left uncommitted changes
    execSyncRevParseResult = 'end-sha-222\n';
    execSyncUncommittedResult = 'diff --git a/dirty.ts b/dirty.ts\n+uncommitted work';
    execAsyncDiffContent = '';  // no committed changes beyond base

    const job = await insertTestJob({ id: 'uncommitted-job', status: 'running' });
    const agent = queries.insertAgent({ id: 'uncommitted-agent', job_id: job.id, status: 'running' });
    queries.updateAgent(agent.id, { base_sha: 'base-sha-333' });
    queries.updateJobStatus(job.id, 'running');

    // Track ordering: was snapshot captured before workflow callback?
    let snapshotCapturedBeforeCallback = false;
    vi.mocked(wfCallback).mockImplementation(() => {
      // At this point, the snapshot should already have been captured
      const syncDiffCalls = gitSyncCalls.filter(c => c.includes('git diff HEAD'));
      snapshotCapturedBeforeCallback = syncDiffCalls.length > 0;
    });

    await handleJobCompletion(agent.id, job, 'done');

    // Wait for deferred diff
    const { _lastDeferredDiffPromise } = await import('../server/orchestrator/AgentRunner.js');
    if (_lastDeferredDiffPromise) await _lastDeferredDiffPromise;

    // Snapshot was captured before workflow callback fired
    expect(snapshotCapturedBeforeCallback).toBe(true);

    // Stored diff should include the uncommitted snapshot
    const refreshedAgent = queries.getAgentById(agent.id);
    expect(refreshedAgent?.diff).toContain('uncommitted work');
  });
});
