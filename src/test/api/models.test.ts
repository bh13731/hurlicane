import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, createSocketMock } from '../helpers.js';
import { createTestApp } from '../api-helpers.js';
import type express from 'express';

vi.mock('../../server/socket/SocketManager.js', () => createSocketMock());
// Mock fs.readFileSync to avoid reading real codex auth
vi.mock('fs', async (importOriginal) => {
  const original = await importOriginal() as any;
  return {
    ...original,
    readFileSync: vi.fn((path: string, ...args: any[]) => {
      if (typeof path === 'string' && path.includes('.codex/auth.json')) {
        throw new Error('File not found');
      }
      return original.readFileSync(path, ...args);
    }),
  };
});

let app: express.Express;

describe('GET /api/models', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns model options', async () => {
    const res = await request(app).get('/api/models');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('claude');
    expect(res.body).toHaveProperty('codex');
    expect(Array.isArray(res.body.claude)).toBe(true);
    expect(Array.isArray(res.body.codex)).toBe(true);
  });

  it('returns claude model options with value and label', async () => {
    const res = await request(app).get('/api/models');
    for (const model of res.body.claude) {
      expect(model).toHaveProperty('value');
      expect(model).toHaveProperty('label');
    }
  });

  it('includes lastFetchedAt field', async () => {
    const res = await request(app).get('/api/models');
    expect(res.body).toHaveProperty('lastFetchedAt');
  });
});
