import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, createSocketMock, insertTestJob } from '../helpers.js';
import { createTestApp } from '../api-helpers.js';
import type express from 'express';

vi.mock('../../server/socket/SocketManager.js', () => createSocketMock());
vi.mock('../../server/orchestrator/MessageRouter.js', () => ({
  getMessageRouter: vi.fn(() => ({
    resolveReply: vi.fn((questionId: string, answer: string) => true),
  })),
}));

let app: express.Express;

async function insertQuestion(agentId: string, status = 'pending') {
  const { randomUUID } = await import('crypto');
  const { getDb } = await import('../../server/db/database.js');
  const db = getDb();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO questions (id, agent_id, question, answer, status, asked_at, answered_at, timeout_ms)
     VALUES (?, ?, ?, NULL, ?, ?, NULL, 60000)`
  ).run(id, agentId, 'What do you think?', status, Date.now());
  return id;
}

async function insertAgent(jobId: string) {
  const { insertAgent: dbInsert } = await import('../../server/db/queries.js');
  const { randomUUID } = await import('crypto');
  const id = randomUUID();
  dbInsert({ id, job_id: jobId, status: 'waiting_user' });
  return id;
}

describe('POST /api/replies/:questionId', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('submits a reply to a pending question', async () => {
    const job = await insertTestJob({ status: 'running' });
    const agentId = await insertAgent(job.id);
    const questionId = await insertQuestion(agentId, 'pending');
    const res = await request(app)
      .post(`/api/replies/${questionId}`)
      .send({ answer: 'Yes, do it' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('rejects missing answer', async () => {
    const job = await insertTestJob({ status: 'running' });
    const agentId = await insertAgent(job.id);
    const questionId = await insertQuestion(agentId);
    const res = await request(app)
      .post(`/api/replies/${questionId}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/answer/i);
  });

  it('returns 404 for unknown question', async () => {
    const res = await request(app)
      .post('/api/replies/nonexistent')
      .send({ answer: 'test' });
    expect(res.status).toBe(404);
  });

  it('returns 409 for already answered question', async () => {
    const job = await insertTestJob({ status: 'running' });
    const agentId = await insertAgent(job.id);
    const questionId = await insertQuestion(agentId, 'answered');
    const res = await request(app)
      .post(`/api/replies/${questionId}`)
      .send({ answer: 'test' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already answered/i);
  });
});
