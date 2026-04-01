import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, createSocketMock, insertTestJob, insertTestProject } from '../helpers.js';
import { createTestApp } from '../api-helpers.js';
import type express from 'express';

vi.mock('../../server/socket/SocketManager.js', () => createSocketMock());
vi.mock('../../server/orchestrator/DebateManager.js', () => ({
  spawnInitialRoundJobs: vi.fn(() => []),
  resolvePreDebateTerminal: vi.fn(),
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Smart Title' }] }) };
  },
}));

let app: express.Express;

describe('POST /api/jobs', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('creates a job with description', async () => {
    const res = await request(app)
      .post('/api/jobs')
      .send({ description: 'Test job description' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.description).toBe('Test job description');
    expect(res.body.status).toBe('queued');
  });

  it('creates a job with explicit title', async () => {
    const res = await request(app)
      .post('/api/jobs')
      .send({ title: 'My Title', description: 'desc' });
    expect(res.status).toBe(201);
    expect(res.body.title).toBe('My Title');
  });

  it('auto-generates title from description', async () => {
    const res = await request(app)
      .post('/api/jobs')
      .send({ description: 'A short description' });
    expect(res.status).toBe(201);
    expect(res.body.title).toBe('A short description');
  });

  it('truncates long auto-titles', async () => {
    const longDesc = 'A'.repeat(100);
    const res = await request(app)
      .post('/api/jobs')
      .send({ description: longDesc });
    expect(res.status).toBe(201);
    expect(res.body.title.length).toBeLessThanOrEqual(45);
  });

  it('rejects missing description without template', async () => {
    const res = await request(app)
      .post('/api/jobs')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/description/i);
  });

  it('sets priority and model', async () => {
    const res = await request(app)
      .post('/api/jobs')
      .send({ description: 'test', priority: 5, model: 'claude-opus-4-6' });
    expect(res.status).toBe(201);
    expect(res.body.priority).toBe(5);
    expect(res.body.model).toBe('claude-opus-4-6');
  });

  it('creates a job linked to a project', async () => {
    // Create project via API to avoid import-order issues with Anthropic mock
    const projectRes = await request(app)
      .post('/api/projects')
      .send({ name: 'Link Target' });
    expect(projectRes.status).toBe(201);
    const res = await request(app)
      .post('/api/jobs')
      .send({ description: 'test', projectId: projectRes.body.id });
    expect(res.status).toBe(201);
    expect(res.body.project_id).toBe(projectRes.body.id);
  });

  it('emits socket event on creation', async () => {
    const socket = await import('../../server/socket/SocketManager.js');
    await request(app).post('/api/jobs').send({ description: 'test' });
    expect(socket.emitJobNew).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/jobs', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns an array of jobs', async () => {
    await insertTestJob({ title: 'Job A' });
    await insertTestJob({ title: 'Job B' });
    const res = await request(app).get('/api/jobs');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);
  });

  it('filters by status', async () => {
    await insertTestJob({ status: 'queued' });
    await insertTestJob({ status: 'done' });
    const res = await request(app).get('/api/jobs?status=done');
    expect(res.status).toBe(200);
    expect(res.body.every((j: any) => j.status === 'done')).toBe(true);
  });

  it('returns empty array when no jobs', async () => {
    const res = await request(app).get('/api/jobs');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(0);
  });

  // Regression: a module-level cache seeded on the first request would return
  // a stale empty list here even after a job was just created.
  it('immediately reflects a newly created job in a subsequent list response', async () => {
    const createRes = await request(app)
      .post('/api/jobs')
      .send({ title: 'Cache Probe Job', description: 'Verify no stale empty-list cache' });
    expect(createRes.status).toBe(201);
    const created = createRes.body;

    const listRes = await request(app).get('/api/jobs');
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].id).toBe(created.id);
    expect(listRes.body[0].title).toBe(created.title);
    expect(listRes.body[0].status).toBe('queued');
  });

  // Regression: a module-level cache populated in one test run would bleed
  // stale rows into a fresh DB opened in the next test run.
  it('returns empty list from a fresh DB even after a prior DB instance had rows', async () => {
    // Populate the current in-memory DB with a row
    await insertTestJob({ title: 'Leftover Row' });
    const before = await request(app).get('/api/jobs');
    expect(before.status).toBe(200);
    expect(before.body).toHaveLength(1);
    expect(before.body[0].title).toBe('Leftover Row');

    // Simulate a new test run: close the current DB and open a fresh empty one
    const { closeDb, initDb } = await import('../../server/db/database.js');
    closeDb();
    await initDb(':memory:');

    const freshApp = createTestApp();
    // A stale module-level cache would return the old row; a fresh DB read must return []
    const after = await request(freshApp).get('/api/jobs');
    expect(after.status).toBe(200);
    expect(after.body).toEqual([]);
  });
});

describe('GET /api/jobs/:id', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns a job by id', async () => {
    const job = await insertTestJob({ title: 'Find Me' });
    const res = await request(app).get(`/api/jobs/${job.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(job.id);
    expect(res.body.title).toBe('Find Me');
  });

  it('returns 404 for unknown id', async () => {
    const res = await request(app).get('/api/jobs/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not found');
  });
});

describe('POST /api/jobs/:id/flag', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('toggles flagged state', async () => {
    const job = await insertTestJob();
    const res1 = await request(app).post(`/api/jobs/${job.id}/flag`);
    expect(res1.status).toBe(200);
    expect(res1.body.flagged).toBe(1);

    const res2 = await request(app).post(`/api/jobs/${job.id}/flag`);
    expect(res2.body.flagged).toBe(0);
  });

  it('returns 404 for unknown job', async () => {
    const res = await request(app).post('/api/jobs/nonexistent/flag');
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/jobs/:id/title', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('updates the title', async () => {
    const job = await insertTestJob({ title: 'Old' });
    const res = await request(app)
      .patch(`/api/jobs/${job.id}/title`)
      .send({ title: 'New Title' });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('New Title');
  });

  it('rejects empty title', async () => {
    const job = await insertTestJob();
    const res = await request(app)
      .patch(`/api/jobs/${job.id}/title`)
      .send({ title: '   ' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown job', async () => {
    const res = await request(app)
      .patch('/api/jobs/nonexistent/title')
      .send({ title: 'X' });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/jobs/:id/run-now', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('clears scheduled_at for queued jobs', async () => {
    const job = await insertTestJob({ status: 'queued' });
    const res = await request(app).post(`/api/jobs/${job.id}/run-now`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(job.id);
  });

  it('rejects non-queued jobs', async () => {
    const job = await insertTestJob({ status: 'running' });
    const res = await request(app).post(`/api/jobs/${job.id}/run-now`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/queued/);
  });
});

describe('PATCH /api/jobs/:id/interactive', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('sets interactive flag', async () => {
    const job = await insertTestJob();
    const res = await request(app)
      .patch(`/api/jobs/${job.id}/interactive`)
      .send({ interactive: true });
    expect(res.status).toBe(200);
    expect(res.body.is_interactive).toBe(1);
  });

  it('clears interactive flag', async () => {
    const job = await insertTestJob();
    // Set it first
    await request(app).patch(`/api/jobs/${job.id}/interactive`).send({ interactive: true });
    const res = await request(app)
      .patch(`/api/jobs/${job.id}/interactive`)
      .send({ interactive: false });
    expect(res.body.is_interactive).toBe(0);
  });
});

describe('POST /api/jobs/:id/archive', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('archives a done job', async () => {
    const job = await insertTestJob({ status: 'done' });
    const res = await request(app).post(`/api/jobs/${job.id}/archive`);
    expect(res.status).toBe(200);
    expect(res.body.archived_at).toBeTruthy();
  });

  it('archives a failed job', async () => {
    const job = await insertTestJob({ status: 'failed' });
    const res = await request(app).post(`/api/jobs/${job.id}/archive`);
    expect(res.status).toBe(200);
  });

  it('rejects archiving running jobs', async () => {
    const job = await insertTestJob({ status: 'running' });
    const res = await request(app).post(`/api/jobs/${job.id}/archive`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/finished/i);
  });

  it('rejects archiving queued jobs', async () => {
    const job = await insertTestJob({ status: 'queued' });
    const res = await request(app).post(`/api/jobs/${job.id}/archive`);
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/jobs/:id', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('cancels a queued job', async () => {
    const job = await insertTestJob({ status: 'queued' });
    const res = await request(app).delete(`/api/jobs/${job.id}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
  });

  it('rejects cancelling non-queued jobs', async () => {
    const job = await insertTestJob({ status: 'running' });
    const res = await request(app).delete(`/api/jobs/${job.id}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/queued/);
  });

  it('returns 404 for unknown job', async () => {
    const res = await request(app).delete('/api/jobs/nonexistent');
    expect(res.status).toBe(404);
  });
});
