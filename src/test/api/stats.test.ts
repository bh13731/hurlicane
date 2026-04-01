import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, createSocketMock } from '../helpers.js';
import { createTestApp } from '../api-helpers.js';
import type express from 'express';

vi.mock('../../server/socket/SocketManager.js', () => createSocketMock());

let app: express.Express;

describe('GET /api/stats/template-model', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns template-model stats', async () => {
    const res = await request(app).get('/api/stats/template-model');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('returns empty array when no data', async () => {
    const res = await request(app).get('/api/stats/template-model');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
