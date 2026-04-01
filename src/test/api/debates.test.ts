import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, createSocketMock, insertTestProject } from '../helpers.js';
import { createTestApp } from '../api-helpers.js';
import type express from 'express';

vi.mock('../../server/socket/SocketManager.js', () => createSocketMock());
vi.mock('../../server/orchestrator/DebateManager.js', () => ({
  spawnInitialRoundJobs: vi.fn(() => [
    { id: 'claude-job', title: 'Claude R1', status: 'queued', debate_role: 'claude' },
    { id: 'codex-job', title: 'Codex R1', status: 'queued', debate_role: 'codex' },
  ]),
  resolvePreDebateTerminal: vi.fn(),
  _resetForTest: vi.fn(),
}));

let app: express.Express;

async function insertDebateViaApi(overrides: Record<string, any> = {}) {
  const res = await request(app).post('/api/debates').send({
    task: 'Should we use React or Vue?',
    claudeModel: 'claude-sonnet-4-6',
    codexModel: 'codex',
    ...overrides,
  });
  return res.body;
}

describe('GET /api/debates', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns empty array initially', async () => {
    const res = await request(app).get('/api/debates');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns all debates', async () => {
    await insertDebateViaApi();
    await insertDebateViaApi({ task: 'Another debate' });
    const res = await request(app).get('/api/debates');
    expect(res.body.length).toBe(2);
  });
});

describe('GET /api/debates/:id', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns a debate by id', async () => {
    const { debate } = await insertDebateViaApi();
    const res = await request(app).get(`/api/debates/${debate.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(debate.id);
    expect(res.body.task).toBe('Should we use React or Vue?');
  });

  it('returns 404 for unknown debate', async () => {
    const res = await request(app).get('/api/debates/nonexistent');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/debates/:id/jobs', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns 404 for unknown debate', async () => {
    const res = await request(app).get('/api/debates/nonexistent/jobs');
    expect(res.status).toBe(404);
  });

  it('returns jobs for a debate', async () => {
    const { debate } = await insertDebateViaApi();
    const res = await request(app).get(`/api/debates/${debate.id}/jobs`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('POST /api/debates', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('creates a debate with all required fields', async () => {
    const res = await request(app)
      .post('/api/debates')
      .send({ task: 'Debate topic', claudeModel: 'claude-opus-4-6', codexModel: 'codex' });
    expect(res.status).toBe(201);
    expect(res.body.debate).toBeTruthy();
    expect(res.body.project).toBeTruthy();
    expect(res.body.jobs).toHaveLength(2);
    expect(res.body.debate.status).toBe('running');
    expect(res.body.debate.claude_model).toBe('claude-opus-4-6');
  });

  it('sets custom title and max rounds', async () => {
    const res = await request(app)
      .post('/api/debates')
      .send({ task: 'topic', claudeModel: 'c', codexModel: 'x', title: 'My Debate', maxRounds: 5 });
    expect(res.status).toBe(201);
    expect(res.body.debate.title).toBe('My Debate');
    expect(res.body.debate.max_rounds).toBe(5);
  });

  it('clamps maxRounds to valid range', async () => {
    const res = await request(app)
      .post('/api/debates')
      .send({ task: 'topic', claudeModel: 'c', codexModel: 'x', maxRounds: 100 });
    expect(res.status).toBe(201);
    expect(res.body.debate.max_rounds).toBeLessThanOrEqual(10);
  });

  it('rejects missing task', async () => {
    const res = await request(app)
      .post('/api/debates')
      .send({ claudeModel: 'c', codexModel: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/task/i);
  });

  it('rejects missing claudeModel', async () => {
    const res = await request(app)
      .post('/api/debates')
      .send({ task: 'topic', codexModel: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/claudeModel/i);
  });

  it('rejects missing codexModel', async () => {
    const res = await request(app)
      .post('/api/debates')
      .send({ task: 'topic', claudeModel: 'c' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/codexModel/i);
  });

  it('emits socket events', async () => {
    const socket = await import('../../server/socket/SocketManager.js');
    await insertDebateViaApi();
    expect(socket.emitDebateNew).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/debates/:id/cancel', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('cancels a running debate', async () => {
    const { debate } = await insertDebateViaApi();
    const res = await request(app).post(`/api/debates/${debate.id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
  });

  it('rejects cancelling a non-running debate', async () => {
    const { debate } = await insertDebateViaApi();
    // Cancel it first
    await request(app).post(`/api/debates/${debate.id}/cancel`);
    // Try to cancel again
    const res = await request(app).post(`/api/debates/${debate.id}/cancel`);
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown debate', async () => {
    const res = await request(app).post('/api/debates/nonexistent/cancel');
    expect(res.status).toBe(404);
  });
});
