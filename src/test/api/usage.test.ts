import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, createSocketMock } from '../helpers.js';
import { createTestApp } from '../api-helpers.js';
import type express from 'express';

vi.mock('../../server/socket/SocketManager.js', () => createSocketMock());
// Mock child_process to avoid real ccusage calls
vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: any, cb: any) => {
    if (typeof cb === 'function') {
      cb(null, JSON.stringify({ daily: [], totals: null }), '');
    }
    return { kill: vi.fn() };
  }),
  execSync: vi.fn(() => '[]'),
}));
vi.mock('util', async (importOriginal) => {
  const original = await importOriginal() as any;
  return {
    ...original,
    promisify: vi.fn(() =>
      vi.fn().mockResolvedValue({ stdout: JSON.stringify({ daily: [], totals: null }), stderr: '' })
    ),
  };
});

let app: express.Express;

describe('GET /api/usage', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns usage data for valid since parameter', async () => {
    const res = await request(app).get('/api/usage?since=20260301');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('daily');
  });

  it('rejects invalid since parameter', async () => {
    const res = await request(app).get('/api/usage?since=invalid');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid since/i);
  });

  it('rejects since parameter with letters', async () => {
    const res = await request(app).get('/api/usage?since=7d');
    expect(res.status).toBe(400);
  });

  it('rejects since with wrong length', async () => {
    const res = await request(app).get('/api/usage?since=2026');
    expect(res.status).toBe(400);
  });
});
