import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, createSocketMock } from '../helpers.js';
import { createTestApp } from '../api-helpers.js';
import type express from 'express';

vi.mock('../../server/socket/SocketManager.js', () => createSocketMock());
vi.mock('../../server/orchestrator/WorkQueueManager.js', () => {
  let maxConcurrent = 5;
  return {
    getMaxConcurrent: vi.fn(() => maxConcurrent),
    setMaxConcurrent: vi.fn((n: number) => { maxConcurrent = n; }),
    startWorkQueue: vi.fn(),
    stopWorkQueue: vi.fn(),
  };
});

let app: express.Express;

describe('GET /api/settings', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns settings', async () => {
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('maxConcurrentAgents');
    expect(res.body).toHaveProperty('eyeEnabled');
  });
});

describe('PUT /api/settings', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('updates maxConcurrentAgents', async () => {
    const res = await request(app)
      .put('/api/settings')
      .send({ maxConcurrentAgents: 10 });
    expect(res.status).toBe(200);
    expect(res.body.maxConcurrentAgents).toBe(10);
  });

  it('rejects maxConcurrentAgents < 1', async () => {
    const res = await request(app)
      .put('/api/settings')
      .send({ maxConcurrentAgents: 0 });
    expect(res.status).toBe(400);
  });

  it('rejects maxConcurrentAgents > 100', async () => {
    const res = await request(app)
      .put('/api/settings')
      .send({ maxConcurrentAgents: 200 });
    expect(res.status).toBe(400);
  });

  it('rejects non-number maxConcurrentAgents', async () => {
    const res = await request(app)
      .put('/api/settings')
      .send({ maxConcurrentAgents: 'five' });
    expect(res.status).toBe(400);
  });

  it('updates eyeEnabled', async () => {
    const res = await request(app)
      .put('/api/settings')
      .send({ eyeEnabled: true });
    expect(res.status).toBe(200);
    expect(res.body.eyeEnabled).toBe(true);
  });

  it('updates multiple settings at once', async () => {
    const res = await request(app)
      .put('/api/settings')
      .send({ maxConcurrentAgents: 8, eyeEnabled: false });
    expect(res.status).toBe(200);
    expect(res.body.maxConcurrentAgents).toBe(8);
    expect(res.body.eyeEnabled).toBe(false);
  });
});
