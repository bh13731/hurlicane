import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, createSocketMock } from '../helpers.js';
import { createTestApp } from '../api-helpers.js';
import type express from 'express';

vi.mock('../../server/socket/SocketManager.js', () => createSocketMock());
vi.mock('../../server/orchestrator/WorktreeCleanup.js', () => ({
  runCleanupNow: vi.fn(() => 0),
  startWorktreeCleanup: vi.fn(),
  stopWorktreeCleanup: vi.fn(),
}));

let app: express.Express;

describe('GET /api/worktrees/stats', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns worktree stats', async () => {
    const res = await request(app).get('/api/worktrees/stats');
    expect(res.status).toBe(200);
    expect(res.body).toBeTruthy();
  });
});

describe('POST /api/worktrees/cleanup', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('runs cleanup and returns count', async () => {
    const res = await request(app).post('/api/worktrees/cleanup');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('cleaned');
    expect(res.body.cleaned).toBe(0);
  });

  it('returns the number of cleaned worktrees', async () => {
    const { runCleanupNow } = await import('../../server/orchestrator/WorktreeCleanup.js');
    vi.mocked(runCleanupNow).mockReturnValueOnce(3);
    const res = await request(app).post('/api/worktrees/cleanup');
    expect(res.body.cleaned).toBe(3);
  });
});
