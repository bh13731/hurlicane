import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, createSocketMock } from '../helpers.js';
import { createTestApp } from '../api-helpers.js';
import type express from 'express';

vi.mock('../../server/socket/SocketManager.js', () => createSocketMock());
// Mock fs.readFileSync to return test config
vi.mock('fs', async (importOriginal) => {
  const original = await importOriginal() as any;
  return {
    ...original,
    readFileSync: vi.fn((path: string, ...args: any[]) => {
      if (typeof path === 'string' && path.includes('.local.config.json')) {
        return JSON.stringify({ eyeEnabled: true });
      }
      return original.readFileSync(path, ...args);
    }),
  };
});

let app: express.Express;

describe('GET /api/local-config', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns local config', async () => {
    const res = await request(app).get('/api/local-config');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('eyeEnabled');
  });

  it('returns eyeEnabled field', async () => {
    const res = await request(app).get('/api/local-config');
    expect(res.status).toBe(200);
    expect(typeof res.body.eyeEnabled).toBe('boolean');
  });
});
