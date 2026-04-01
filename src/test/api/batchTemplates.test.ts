import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, createSocketMock } from '../helpers.js';
import { createTestApp } from '../api-helpers.js';
import type express from 'express';

vi.mock('../../server/socket/SocketManager.js', () => createSocketMock());
vi.mock('../../server/orchestrator/DebateManager.js', () => ({
  spawnInitialRoundJobs: vi.fn(() => [
    { id: 'claude-job', title: 'Claude', status: 'queued', debate_role: 'claude' },
    { id: 'codex-job', title: 'Codex', status: 'queued', debate_role: 'codex' },
  ]),
  resolvePreDebateTerminal: vi.fn(),
}));

let app: express.Express;

async function createBatchTemplate(overrides: Record<string, any> = {}) {
  const res = await request(app).post('/api/batch-templates').send({
    name: 'My Batch',
    items: ['task 1', 'task 2', 'task 3'],
    ...overrides,
  });
  return res.body;
}

describe('GET /api/batch-templates', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns empty array initially', async () => {
    const res = await request(app).get('/api/batch-templates');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns all batch templates', async () => {
    await createBatchTemplate({ name: 'A' });
    await createBatchTemplate({ name: 'B' });
    const res = await request(app).get('/api/batch-templates');
    expect(res.body.length).toBe(2);
  });
});

describe('GET /api/batch-templates/:id', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns a batch template by id', async () => {
    const bt = await createBatchTemplate();
    const res = await request(app).get(`/api/batch-templates/${bt.id}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('My Batch');
    expect(res.body.items).toEqual(['task 1', 'task 2', 'task 3']);
  });

  it('returns 404 for unknown id', async () => {
    const res = await request(app).get('/api/batch-templates/nonexistent');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/batch-templates', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('creates a batch template', async () => {
    const res = await request(app)
      .post('/api/batch-templates')
      .send({ name: 'Test', items: ['a', 'b'] });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Test');
    expect(res.body.items).toEqual(['a', 'b']);
  });

  it('rejects missing name', async () => {
    const res = await request(app)
      .post('/api/batch-templates')
      .send({ items: ['a'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
  });

  it('rejects missing items', async () => {
    const res = await request(app)
      .post('/api/batch-templates')
      .send({ name: 'X' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/item/i);
  });

  it('rejects empty items array', async () => {
    const res = await request(app)
      .post('/api/batch-templates')
      .send({ name: 'X', items: [] });
    expect(res.status).toBe(400);
  });

  it('rejects items with only whitespace', async () => {
    const res = await request(app)
      .post('/api/batch-templates')
      .send({ name: 'X', items: ['  ', ''] });
    expect(res.status).toBe(400);
  });

  it('trims item whitespace', async () => {
    const res = await request(app)
      .post('/api/batch-templates')
      .send({ name: 'X', items: ['  hello  ', '  world  '] });
    expect(res.status).toBe(201);
    expect(res.body.items).toEqual(['hello', 'world']);
  });
});

describe('PUT /api/batch-templates/:id', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('updates name', async () => {
    const bt = await createBatchTemplate();
    const res = await request(app)
      .put(`/api/batch-templates/${bt.id}`)
      .send({ name: 'Updated' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated');
  });

  it('updates items', async () => {
    const bt = await createBatchTemplate();
    const res = await request(app)
      .put(`/api/batch-templates/${bt.id}`)
      .send({ items: ['new item'] });
    expect(res.body.items).toEqual(['new item']);
  });

  it('rejects empty items update', async () => {
    const bt = await createBatchTemplate();
    const res = await request(app)
      .put(`/api/batch-templates/${bt.id}`)
      .send({ items: ['', ' '] });
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown id', async () => {
    const res = await request(app)
      .put('/api/batch-templates/nonexistent')
      .send({ name: 'X' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/batch-templates/:id', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('deletes a batch template', async () => {
    const bt = await createBatchTemplate();
    const res = await request(app).delete(`/api/batch-templates/${bt.id}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 404 for unknown id', async () => {
    const res = await request(app).delete('/api/batch-templates/nonexistent');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/batch-templates/:id/run', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('runs a batch template creating jobs', async () => {
    const bt = await createBatchTemplate();
    const res = await request(app)
      .post(`/api/batch-templates/${bt.id}/run`)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.project).toBeTruthy();
    expect(res.body.jobs.length).toBe(3); // one per item
  });

  it('runs in debate mode', async () => {
    const bt = await createBatchTemplate();
    const res = await request(app)
      .post(`/api/batch-templates/${bt.id}/run`)
      .send({ debate: true, claudeModel: 'claude-opus-4-6', codexModel: 'codex' });
    expect(res.status).toBe(201);
    expect(res.body.debates).toBeTruthy();
    expect(res.body.debates.length).toBe(3);
  });

  it('rejects debate mode without models', async () => {
    const bt = await createBatchTemplate();
    const res = await request(app)
      .post(`/api/batch-templates/${bt.id}/run`)
      .send({ debate: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Model/i);
  });

  it('returns 404 for unknown batch template', async () => {
    const res = await request(app)
      .post('/api/batch-templates/nonexistent/run')
      .send({});
    expect(res.status).toBe(404);
  });

  it('uses custom project name', async () => {
    const bt = await createBatchTemplate();
    const res = await request(app)
      .post(`/api/batch-templates/${bt.id}/run`)
      .send({ projectName: 'Custom Project' });
    expect(res.status).toBe(201);
    expect(res.body.project.name).toBe('Custom Project');
  });
});
