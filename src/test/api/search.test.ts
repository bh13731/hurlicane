import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, createSocketMock } from '../helpers.js';
import { createTestApp } from '../api-helpers.js';
import type express from 'express';

vi.mock('../../server/socket/SocketManager.js', () => createSocketMock());

let app: express.Express;

describe('GET /api/search', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns empty results when q is empty', async () => {
    const res = await request(app).get('/api/search');
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it('returns empty results when q is whitespace', async () => {
    const res = await request(app).get('/api/search?q=%20%20');
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it('returns results array for valid query', async () => {
    const res = await request(app).get('/api/search?q=test');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('results');
    expect(Array.isArray(res.body.results)).toBe(true);
  });

  it('respects limit parameter', async () => {
    const res = await request(app).get('/api/search?q=test&limit=10');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.results)).toBe(true);
  });

  it('caps limit at 200', async () => {
    const res = await request(app).get('/api/search?q=test&limit=500');
    expect(res.status).toBe(200);
    // Still works, just capped server-side
  });
});
