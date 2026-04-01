import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, createSocketMock, insertTestJob } from '../helpers.js';
import { createTestApp } from '../api-helpers.js';
import type express from 'express';

vi.mock('../../server/socket/SocketManager.js', () => createSocketMock());
vi.mock('../../server/orchestrator/AgentRunner.js', () => ({
  runAgent: vi.fn(),
  cancelledAgents: new Set(),
}));
vi.mock('../../server/orchestrator/PtyManager.js', () => ({
  disconnectAgent: vi.fn(),
  disconnectAll: vi.fn(() => []),
  getPtyBuffer: vi.fn(() => []),
  getSnapshot: vi.fn(() => null),
  attachPty: vi.fn(),
  isTmuxSessionAlive: vi.fn(() => false),
  startInteractiveAgent: vi.fn(),
}));
vi.mock('../../server/orchestrator/FileLockRegistry.js', () => ({
  CHECKOUT_PREFIX: 'checkout::',
  getFileLockRegistry: vi.fn(() => ({
    releaseAll: vi.fn(),
  })),
}));

let app: express.Express;

async function insertAgent(jobId: string, overrides: Record<string, any> = {}) {
  const { insertAgent: dbInsert, getAgentWithJob } = await import('../../server/db/queries.js');
  const { randomUUID } = await import('crypto');
  const id = overrides.id ?? randomUUID();
  dbInsert({ id, job_id: jobId, status: overrides.status ?? 'running', ...overrides });
  return getAgentWithJob(id)!;
}

describe('GET /api/agents', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns agents array', async () => {
    const res = await request(app).get('/api/agents');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('returns an agent with its job via /:id', async () => {
    const job = await insertTestJob({ title: 'Agent Job', status: 'running' });
    const agent = await insertAgent(job.id, { status: 'running' });
    // Use the uncached /:id endpoint to verify agent+job data
    const res = await request(app).get(`/api/agents/${agent.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(agent.id);
    expect(res.body.job).toBeTruthy();
    expect(res.body.job.title).toBe('Agent Job');
  });
});

describe('GET /api/agents/:id', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns agent by id', async () => {
    const job = await insertTestJob();
    const agent = await insertAgent(job.id);
    const res = await request(app).get(`/api/agents/${agent.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(agent.id);
    expect(res.body.job).toBeTruthy();
  });

  it('returns 404 for unknown agent', async () => {
    const res = await request(app).get('/api/agents/nonexistent');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/agents/:id/output', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns output for existing agent', async () => {
    const job = await insertTestJob();
    const agent = await insertAgent(job.id);
    const res = await request(app).get(`/api/agents/${agent.id}/output`);
    expect(res.status).toBe(200);
  });

  it('returns 404 for unknown agent', async () => {
    const res = await request(app).get('/api/agents/nonexistent/output');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/agents/:id/result-text', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns result text', async () => {
    const job = await insertTestJob();
    const agent = await insertAgent(job.id);
    const res = await request(app).get(`/api/agents/${agent.id}/result-text`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('text');
  });

  it('returns 404 for unknown agent', async () => {
    const res = await request(app).get('/api/agents/nonexistent/result-text');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/agents/:id/diff', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns diff info', async () => {
    const job = await insertTestJob();
    const agent = await insertAgent(job.id);
    const res = await request(app).get(`/api/agents/${agent.id}/diff`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('diff');
    expect(res.body).toHaveProperty('base_sha');
  });
});

describe('POST /api/agents/:id/read', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('marks agent output as read', async () => {
    const job = await insertTestJob();
    const agent = await insertAgent(job.id);
    const res = await request(app).post(`/api/agents/${agent.id}/read`);
    expect(res.status).toBe(200);
    expect(res.body.output_read).toBe(1);
  });

  it('returns 404 for unknown agent', async () => {
    const res = await request(app).post('/api/agents/nonexistent/read');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/agents/read-all', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('marks multiple agents as read', async () => {
    const job1 = await insertTestJob({ status: 'done' });
    const job2 = await insertTestJob({ status: 'done' });
    const a1 = await insertAgent(job1.id, { status: 'done' });
    const a2 = await insertAgent(job2.id, { status: 'done' });
    const res = await request(app)
      .post('/api/agents/read-all')
      .send({ ids: [a1.id, a2.id] });
    expect(res.status).toBe(200);
    expect(res.body.marked).toBe(2);
  });

  it('handles empty request body', async () => {
    const res = await request(app).post('/api/agents/read-all').send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('marked');
  });
});

describe('POST /api/agents/:id/retry', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('retries a failed agent', async () => {
    const job = await insertTestJob({ status: 'failed' });
    const agent = await insertAgent(job.id, { status: 'failed' });
    const res = await request(app).post(`/api/agents/${agent.id}/retry`);
    expect(res.status).toBe(201);
    expect(res.body.job.title).toContain('↺');
  });

  it('rejects retrying non-failed agent', async () => {
    const job = await insertTestJob({ status: 'running' });
    const agent = await insertAgent(job.id, { status: 'running' });
    const res = await request(app).post(`/api/agents/${agent.id}/retry`);
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown agent', async () => {
    const res = await request(app).post('/api/agents/nonexistent/retry');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/agents/:id/continue', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('creates a continuation job', async () => {
    const job = await insertTestJob({ status: 'done' });
    const agent = await insertAgent(job.id, { status: 'done' });
    const res = await request(app)
      .post(`/api/agents/${agent.id}/continue`)
      .send({ message: 'Continue with this' });
    expect(res.status).toBe(201);
    expect(res.body.job.title).toContain('↩');
  });

  it('rejects missing message', async () => {
    const job = await insertTestJob();
    const agent = await insertAgent(job.id);
    const res = await request(app)
      .post(`/api/agents/${agent.id}/continue`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/message/i);
  });

  it('rejects empty message', async () => {
    const job = await insertTestJob();
    const agent = await insertAgent(job.id);
    const res = await request(app)
      .post(`/api/agents/${agent.id}/continue`)
      .send({ message: '  ' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/agents/:id/dismiss-warnings', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('dismisses warnings', async () => {
    const job = await insertTestJob();
    const agent = await insertAgent(job.id);
    const res = await request(app).post(`/api/agents/${agent.id}/dismiss-warnings`);
    expect(res.status).toBe(200);
    expect(res.body.dismissed).toBe(true);
  });

  it('returns 404 for unknown agent', async () => {
    const res = await request(app).post('/api/agents/nonexistent/dismiss-warnings');
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/agents/disconnect-all', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('disconnects all agents', async () => {
    const res = await request(app).delete('/api/agents/disconnect-all');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('disconnected');
  });
});
