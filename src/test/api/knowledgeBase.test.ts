import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, createSocketMock } from '../helpers.js';
import { createTestApp } from '../api-helpers.js';
import type express from 'express';

vi.mock('../../server/socket/SocketManager.js', () => createSocketMock());
vi.mock('../../server/orchestrator/KBConsolidator.js', () => ({
  runConsolidation: vi.fn().mockResolvedValue({ merged: 0, removed: 0 }),
  startKBConsolidator: vi.fn(),
  stopKBConsolidator: vi.fn(),
}));

let app: express.Express;

describe('GET /api/knowledge-base', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns empty array initially', async () => {
    const res = await request(app).get('/api/knowledge-base');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns all KB entries', async () => {
    await request(app).post('/api/knowledge-base').send({ title: 'Entry 1', content: 'Content 1' });
    await request(app).post('/api/knowledge-base').send({ title: 'Entry 2', content: 'Content 2' });
    const res = await request(app).get('/api/knowledge-base');
    expect(res.body.length).toBe(2);
  });

  it('filters by projectId', async () => {
    await request(app).post('/api/knowledge-base').send({ title: 'A', content: 'c', projectId: 'proj1' });
    await request(app).post('/api/knowledge-base').send({ title: 'B', content: 'c', projectId: 'proj2' });
    const res = await request(app).get('/api/knowledge-base?projectId=proj1');
    expect(res.body.length).toBe(1);
    expect(res.body[0].title).toBe('A');
  });
});

describe('GET /api/knowledge-base/search', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('searches entries by query', async () => {
    await request(app).post('/api/knowledge-base').send({ title: 'Testing patterns', content: 'Use vitest for testing' });
    await request(app).post('/api/knowledge-base').send({ title: 'Build guide', content: 'Use npm run build' });
    const res = await request(app).get('/api/knowledge-base/search?q=testing');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('returns 400 when q is missing', async () => {
    const res = await request(app).get('/api/knowledge-base/search');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/q/);
  });
});

describe('POST /api/knowledge-base', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('creates a KB entry', async () => {
    const res = await request(app)
      .post('/api/knowledge-base')
      .send({ title: 'New Entry', content: 'Content here', tags: 'testing,build' });
    expect(res.status).toBe(201);
    expect(res.body.title).toBe('New Entry');
    expect(res.body.content).toBe('Content here');
    expect(res.body.tags).toBe('testing,build');
    expect(res.body.id).toBeTruthy();
  });

  it('creates minimal entry', async () => {
    const res = await request(app)
      .post('/api/knowledge-base')
      .send({ title: 'Min', content: 'c' });
    expect(res.status).toBe(201);
    expect(res.body.tags).toBeNull();
    expect(res.body.source).toBeNull();
  });

  it('rejects missing title', async () => {
    const res = await request(app)
      .post('/api/knowledge-base')
      .send({ content: 'c' });
    expect(res.status).toBe(400);
  });

  it('rejects missing content', async () => {
    const res = await request(app)
      .post('/api/knowledge-base')
      .send({ title: 't' });
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/knowledge-base/:id', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('updates a KB entry', async () => {
    const create = await request(app)
      .post('/api/knowledge-base')
      .send({ title: 'Old', content: 'old content' });
    const res = await request(app)
      .put(`/api/knowledge-base/${create.body.id}`)
      .send({ title: 'Updated', content: 'new content' });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Updated');
    expect(res.body.content).toBe('new content');
  });

  it('returns 404 for unknown entry', async () => {
    const res = await request(app)
      .put('/api/knowledge-base/nonexistent')
      .send({ title: 'X' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/knowledge-base/:id', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('deletes a KB entry', async () => {
    const create = await request(app)
      .post('/api/knowledge-base')
      .send({ title: 'ToDelete', content: 'c' });
    const res = await request(app).delete(`/api/knowledge-base/${create.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });

  it('returns 404 for unknown entry', async () => {
    const res = await request(app).delete('/api/knowledge-base/nonexistent');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/knowledge-base/consolidate', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('runs consolidation', async () => {
    const res = await request(app).post('/api/knowledge-base/consolidate');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('merged');
  });

  it('returns 500 on consolidation failure', async () => {
    const { runConsolidation } = await import('../../server/orchestrator/KBConsolidator.js');
    vi.mocked(runConsolidation).mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).post('/api/knowledge-base/consolidate');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/boom/);
  });
});
