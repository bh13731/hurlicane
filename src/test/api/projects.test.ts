import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, createSocketMock, insertTestProject } from '../helpers.js';
import { createTestApp } from '../api-helpers.js';
import type express from 'express';

vi.mock('../../server/socket/SocketManager.js', () => createSocketMock());

let app: express.Express;

describe('GET /api/projects', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns empty array when no projects', async () => {
    const res = await request(app).get('/api/projects');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns all projects', async () => {
    await insertTestProject({ name: 'P1' });
    await insertTestProject({ name: 'P2' });
    const res = await request(app).get('/api/projects');
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
  });
});

describe('GET /api/projects/:id', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns a project by id', async () => {
    const project = await insertTestProject({ name: 'Test' });
    const res = await request(app).get(`/api/projects/${project.id}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Test');
  });

  it('returns 404 for unknown id', async () => {
    const res = await request(app).get('/api/projects/nonexistent');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/projects', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('creates a project', async () => {
    const res = await request(app)
      .post('/api/projects')
      .send({ name: 'New Project', description: 'desc' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('New Project');
    expect(res.body.description).toBe('desc');
    expect(res.body.id).toBeTruthy();
  });

  it('creates a project without description', async () => {
    const res = await request(app)
      .post('/api/projects')
      .send({ name: 'Minimal' });
    expect(res.status).toBe(201);
    expect(res.body.description).toBeNull();
  });

  it('rejects empty name', async () => {
    const res = await request(app)
      .post('/api/projects')
      .send({ name: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
  });

  it('rejects missing name', async () => {
    const res = await request(app)
      .post('/api/projects')
      .send({});
    expect(res.status).toBe(400);
  });

  it('trims whitespace from name', async () => {
    const res = await request(app)
      .post('/api/projects')
      .send({ name: '  Trimmed  ' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Trimmed');
  });
});

describe('PUT /api/projects/:id', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('updates project name', async () => {
    const project = await insertTestProject({ name: 'Old' });
    const res = await request(app)
      .put(`/api/projects/${project.id}`)
      .send({ name: 'Updated' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated');
  });

  it('updates project description', async () => {
    const project = await insertTestProject();
    const res = await request(app)
      .put(`/api/projects/${project.id}`)
      .send({ description: 'New desc' });
    expect(res.status).toBe(200);
    expect(res.body.description).toBe('New desc');
  });

  it('returns 404 for unknown project', async () => {
    const res = await request(app)
      .put('/api/projects/nonexistent')
      .send({ name: 'X' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/projects/:id', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('deletes a project', async () => {
    const project = await insertTestProject();
    const res = await request(app).delete(`/api/projects/${project.id}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const check = await request(app).get(`/api/projects/${project.id}`);
    expect(check.status).toBe(404);
  });

  it('returns 404 for unknown project', async () => {
    const res = await request(app).delete('/api/projects/nonexistent');
    expect(res.status).toBe(404);
  });
});
