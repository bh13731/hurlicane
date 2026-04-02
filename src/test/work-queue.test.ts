/**
 * WorkQueueManager tests — capacity-aware dispatch and nudgeQueue wakeups.
 *
 * Proves:
 * 1. Multiple ready jobs dispatch from a single tick() cycle
 * 2. nudgeQueue() triggers an immediate dispatch without waiting for the 2s poll
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb, createSocketMock, resetManagerState } from './helpers.js';

// Mock external dependencies so tick() doesn't spawn real processes
vi.mock('../server/socket/SocketManager.js', () => createSocketMock());
vi.mock('../server/orchestrator/AgentRunner.js', () => ({
  runAgent: vi.fn(),
  cancelledAgents: new Set(),
}));
vi.mock('../server/orchestrator/PtyManager.js', () => ({
  startInteractiveAgent: vi.fn(),
  disconnectAgent: vi.fn(),
  disconnectAll: vi.fn(),
  getPtyBuffer: vi.fn(() => ''),
  getSnapshot: vi.fn(() => ''),
  attachPty: vi.fn(),
  isTmuxSessionAlive: vi.fn(() => false),
  saveSnapshot: vi.fn(),
}));
vi.mock('../server/orchestrator/ModelClassifier.js', () => ({
  resolveModel: vi.fn(async (job: any) => job.model ?? 'claude-sonnet-4-6'),
  getFallbackModel: vi.fn((m: string) => m),
  getModelProvider: vi.fn(() => 'anthropic'),
  markModelRateLimited: vi.fn(),
  markProviderRateLimited: vi.fn(),
  _resetForTest: vi.fn(),
}));

describe('WorkQueueManager — capacity-aware dispatch', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('dispatches multiple ready jobs in a single tick', async () => {
    const queries = await import('../server/db/queries.js');
    const pty = await import('../server/orchestrator/PtyManager.js');
    const { _tickForTest } = await import('../server/orchestrator/WorkQueueManager.js');

    // Insert 3 queued jobs with explicit models (no classification needed)
    queries.insertJob({ id: 'q-1', title: 'Job 1', description: 'test', context: null, priority: 0, model: 'claude-sonnet-4-6', work_dir: '/tmp' });
    queries.insertJob({ id: 'q-2', title: 'Job 2', description: 'test', context: null, priority: 0, model: 'claude-sonnet-4-6', work_dir: '/tmp' });
    queries.insertJob({ id: 'q-3', title: 'Job 3', description: 'test', context: null, priority: 0, model: 'claude-sonnet-4-6', work_dir: '/tmp' });

    // Run one tick
    await _tickForTest();

    // All 3 should have been dispatched (startInteractiveAgent called 3 times)
    expect(vi.mocked(pty.startInteractiveAgent)).toHaveBeenCalledTimes(3);

    // All jobs should be assigned
    const j1 = queries.getJobById('q-1');
    const j2 = queries.getJobById('q-2');
    const j3 = queries.getJobById('q-3');
    expect(j1!.status).toBe('assigned');
    expect(j2!.status).toBe('assigned');
    expect(j3!.status).toBe('assigned');
  });

  it('respects concurrency limit within a single tick', async () => {
    const queries = await import('../server/db/queries.js');
    const pty = await import('../server/orchestrator/PtyManager.js');
    const { _tickForTest, setMaxConcurrent } = await import('../server/orchestrator/WorkQueueManager.js');

    setMaxConcurrent(2);

    queries.insertJob({ id: 'c-1', title: 'Job 1', description: 'test', context: null, priority: 0, model: 'claude-sonnet-4-6', work_dir: '/tmp' });
    queries.insertJob({ id: 'c-2', title: 'Job 2', description: 'test', context: null, priority: 0, model: 'claude-sonnet-4-6', work_dir: '/tmp' });
    queries.insertJob({ id: 'c-3', title: 'Job 3', description: 'test', context: null, priority: 0, model: 'claude-sonnet-4-6', work_dir: '/tmp' });

    await _tickForTest();

    // Only 2 dispatched due to concurrency limit
    expect(vi.mocked(pty.startInteractiveAgent)).toHaveBeenCalledTimes(2);

    // Third job still queued
    const j3 = queries.getJobById('c-3');
    expect(j3!.status).toBe('queued');

    // Reset for other tests
    setMaxConcurrent(20);
  });

  it('nudgeQueue triggers an immediate dispatch cycle', async () => {
    const queries = await import('../server/db/queries.js');
    const pty = await import('../server/orchestrator/PtyManager.js');
    const { nudgeQueue, startWorkQueue, stopWorkQueue } = await import('../server/orchestrator/WorkQueueManager.js');

    // Start queue so nudgeQueue is operational (it checks _running)
    startWorkQueue();

    // Clear any calls from the initial tick
    await new Promise(r => setTimeout(r, 50));
    vi.mocked(pty.startInteractiveAgent).mockClear();

    // Insert a job and nudge
    queries.insertJob({ id: 'n-1', title: 'Nudge Job', description: 'test', context: null, priority: 0, model: 'claude-sonnet-4-6', work_dir: '/tmp' });
    nudgeQueue();

    // Wait for the microtask-scheduled tick to fire
    await new Promise(r => setTimeout(r, 50));

    expect(vi.mocked(pty.startInteractiveAgent)).toHaveBeenCalledTimes(1);
    const j = queries.getJobById('n-1');
    expect(j!.status).toBe('assigned');

    stopWorkQueue();
  });

  it('nudgeQueue coalesces multiple calls into a single tick', async () => {
    const queries = await import('../server/db/queries.js');
    const pty = await import('../server/orchestrator/PtyManager.js');
    const { nudgeQueue, startWorkQueue, stopWorkQueue } = await import('../server/orchestrator/WorkQueueManager.js');

    startWorkQueue();
    await new Promise(r => setTimeout(r, 50));
    vi.mocked(pty.startInteractiveAgent).mockClear();

    queries.insertJob({ id: 'nc-1', title: 'Coalesce 1', description: 'test', context: null, priority: 0, model: 'claude-sonnet-4-6', work_dir: '/tmp' });
    queries.insertJob({ id: 'nc-2', title: 'Coalesce 2', description: 'test', context: null, priority: 0, model: 'claude-sonnet-4-6', work_dir: '/tmp' });

    // Call nudge multiple times — should coalesce
    nudgeQueue();
    nudgeQueue();
    nudgeQueue();

    await new Promise(r => setTimeout(r, 50));

    // Both jobs dispatched from the single coalesced tick
    expect(vi.mocked(pty.startInteractiveAgent)).toHaveBeenCalledTimes(2);

    stopWorkQueue();
  });
});
