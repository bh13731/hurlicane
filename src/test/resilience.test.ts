/**
 * Tests for agent resilience improvements:
 * - Retry exponential backoff
 * - TTL-expired lock cleanup
 * - Resource monitor basics
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb, createSocketMock, resetManagerState } from './helpers.js';

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

describe('RetryManager - exponential backoff', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('computeBackoffDelay increases exponentially', async () => {
    const { computeBackoffDelay } = await import('../server/orchestrator/RetryManager.js');

    // Use a fixed seed by mocking Math.random to remove jitter
    const origRandom = Math.random;
    Math.random = () => 0.5; // jitter factor = 0

    try {
      const d0 = computeBackoffDelay(0); // ~30s
      const d1 = computeBackoffDelay(1); // ~60s
      const d2 = computeBackoffDelay(2); // ~120s
      const d3 = computeBackoffDelay(3); // ~240s

      expect(d0).toBeGreaterThanOrEqual(20_000);
      expect(d0).toBeLessThanOrEqual(50_000);
      expect(d1).toBeGreaterThan(d0);
      expect(d2).toBeGreaterThan(d1);
      expect(d3).toBeGreaterThan(d2);
      // Should cap at MAX_DELAY_MS (10 minutes)
      const d10 = computeBackoffDelay(10);
      expect(d10).toBeLessThanOrEqual(10 * 60_000 * 1.3 + 1000);
    } finally {
      Math.random = origRandom;
    }
  });

  it('retry jobs are scheduled with a future scheduled_at', async () => {
    const queries = await import('../server/db/queries.js');
    const { handleRetry } = await import('../server/orchestrator/RetryManager.js');

    const job = queries.insertJob({
      id: 'retry-backoff-test',
      title: 'Test Job',
      description: 'desc',
      context: null,
      priority: 0,
      status: 'failed',
      retry_policy: 'same',
      max_retries: 3,
      retry_count: 0,
    });

    const agent = queries.insertAgent({ id: 'agent-retry-1', job_id: job.id, status: 'failed' });
    const before = Date.now();

    const result = handleRetry(job, agent.id);
    expect(result).toBe(true);

    // Find the retry job
    const allJobs = queries.listJobs();
    const retryJob = allJobs.find(j => j.id !== job.id);
    expect(retryJob).toBeDefined();
    expect(retryJob!.scheduled_at).toBeDefined();
    expect(retryJob!.scheduled_at).toBeGreaterThan(before);
    // Should be at least a few seconds in the future
    expect(retryJob!.scheduled_at! - before).toBeGreaterThanOrEqual(1000);
  });
});

describe('TTL-expired lock cleanup', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('getExpiredUnreleasedLocks returns only expired unreleased locks', async () => {
    const queries = await import('../server/db/queries.js');

    // Insert a job + agent for the lock FK constraints
    queries.insertJob({ id: 'job-1', title: 'test', description: 'test', context: null, priority: 0 });
    queries.insertAgent({ id: 'agent-lock-1', job_id: 'job-1', status: 'running' });

    const now = Date.now();

    // Insert an expired lock (TTL already passed)
    queries.insertFileLock({
      id: 'expired-lock-1',
      agent_id: 'agent-lock-1',
      file_path: '/test/expired.ts',
      reason: 'test',
      acquired_at: now - 120_000,
      expires_at: now - 60_000, // expired 60s ago
      released_at: null,
    });

    // Insert an active lock (TTL not yet passed)
    queries.insertFileLock({
      id: 'active-lock-1',
      agent_id: 'agent-lock-1',
      file_path: '/test/active.ts',
      reason: 'test',
      acquired_at: now - 60_000,
      expires_at: now + 300_000, // expires in 5 min
      released_at: null,
    });

    // Insert an already-released lock
    queries.insertFileLock({
      id: 'released-lock-1',
      agent_id: 'agent-lock-1',
      file_path: '/test/released.ts',
      reason: 'test',
      acquired_at: now - 120_000,
      expires_at: now - 60_000,
      released_at: now - 30_000,
    });

    const expired = queries.getExpiredUnreleasedLocks();
    expect(expired).toHaveLength(1);
    expect(expired[0].id).toBe('expired-lock-1');
  });
});

describe('ResourceMonitor', () => {
  it('exports start/stop functions without crashing', async () => {
    const { startResourceMonitor, stopResourceMonitor, _getState } = await import('../server/orchestrator/ResourceMonitor.js');

    // Just verify it can start and stop without errors
    startResourceMonitor();
    const state = _getState();
    expect(typeof state.diskWarned).toBe('boolean');
    expect(typeof state.memoryWarned).toBe('boolean');
    stopResourceMonitor();
  });
});
