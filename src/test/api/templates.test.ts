import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, createSocketMock } from '../helpers.js';
import { createTestApp } from '../api-helpers.js';
import type express from 'express';

vi.mock('../../server/socket/SocketManager.js', () => createSocketMock());

let app: express.Express;

async function insertTemplate(name = 'Tpl', content = 'Do the thing') {
  const res = await request(app).post('/api/templates').send({ name, content });
  return res.body;
}

describe('GET /api/templates', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns empty array initially', async () => {
    const res = await request(app).get('/api/templates');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns all templates', async () => {
    await insertTemplate('A', 'content A');
    await insertTemplate('B', 'content B');
    const res = await request(app).get('/api/templates');
    expect(res.body.length).toBe(2);
  });
});

describe('POST /api/templates', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('creates a template', async () => {
    const res = await request(app)
      .post('/api/templates')
      .send({ name: 'Deploy', content: 'Deploy to prod', workDir: '/app', model: 'claude-opus-4-6' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Deploy');
    expect(res.body.content).toBe('Deploy to prod');
    expect(res.body.work_dir).toBe('/app');
    expect(res.body.model).toBe('claude-opus-4-6');
  });

  it('creates a template with minimal fields', async () => {
    const res = await request(app)
      .post('/api/templates')
      .send({ name: 'Min', content: 'content' });
    expect(res.status).toBe(201);
    expect(res.body.work_dir).toBeNull();
    expect(res.body.model).toBeNull();
  });

  it('rejects missing name', async () => {
    const res = await request(app)
      .post('/api/templates')
      .send({ content: 'x' });
    expect(res.status).toBe(400);
  });

  it('rejects missing content', async () => {
    const res = await request(app)
      .post('/api/templates')
      .send({ name: 'x' });
    expect(res.status).toBe(400);
  });

  it('rejects empty name', async () => {
    const res = await request(app)
      .post('/api/templates')
      .send({ name: '  ', content: 'x' });
    expect(res.status).toBe(400);
  });

  it('trims whitespace', async () => {
    const res = await request(app)
      .post('/api/templates')
      .send({ name: '  Trimmed  ', content: '  trimmed content  ' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Trimmed');
    expect(res.body.content).toBe('trimmed content');
  });
});

describe('PUT /api/templates/:id', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('updates template name', async () => {
    const tpl = await insertTemplate();
    const res = await request(app)
      .put(`/api/templates/${tpl.id}`)
      .send({ name: 'Updated' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated');
  });

  it('updates template content', async () => {
    const tpl = await insertTemplate();
    const res = await request(app)
      .put(`/api/templates/${tpl.id}`)
      .send({ content: 'New content' });
    expect(res.body.content).toBe('New content');
  });

  it('updates workDir and model', async () => {
    const tpl = await insertTemplate();
    const res = await request(app)
      .put(`/api/templates/${tpl.id}`)
      .send({ workDir: '/new', model: 'claude-haiku-4-5-20251001' });
    expect(res.body.work_dir).toBe('/new');
    expect(res.body.model).toBe('claude-haiku-4-5-20251001');
  });

  it('returns 404 for unknown template', async () => {
    const res = await request(app)
      .put('/api/templates/nonexistent')
      .send({ name: 'X' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/templates/:id', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('deletes a template', async () => {
    const tpl = await insertTemplate();
    const res = await request(app).delete(`/api/templates/${tpl.id}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 404 for unknown template', async () => {
    const res = await request(app).delete('/api/templates/nonexistent');
    expect(res.status).toBe(404);
  });
});
