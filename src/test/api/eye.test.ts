import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, createSocketMock, insertTestProject } from '../helpers.js';
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
vi.mock('../../server/orchestrator/EyeConfig.js', () => ({
  buildEyePrompt: vi.fn(() => 'mock eye prompt'),
  getEyeTargets: vi.fn(() => []),
  EYE_PROMPT: 'default eye prompt',
}));
vi.mock('../../server/integrations/GitHubPoller.js', () => ({
  getGitHubPollerStatus: vi.fn(() => ({ running: false, lastPollAt: null })),
  startGitHubPoller: vi.fn(),
  stopGitHubPoller: vi.fn(),
}));
vi.mock('child_process', () => ({
  execSync: vi.fn(() => '[]'),
  execFile: vi.fn(),
}));

let app: express.Express;

describe('GET /api/eye/status', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns eye status', async () => {
    const res = await request(app).get('/api/eye/status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('running');
    expect(res.body).toHaveProperty('active');
    expect(res.body).toHaveProperty('jobId');
  });
});

describe('GET /api/eye/github-status', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns github poller status', async () => {
    const res = await request(app).get('/api/eye/github-status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('running');
  });
});

describe('POST /api/eye/start', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('starts the eye agent', async () => {
    const res = await request(app).post('/api/eye/start').send({});
    expect(res.status).toBe(201);
    expect(res.body.jobId).toBeTruthy();
    expect(res.body.status).toBe('queued');
  });

  it('returns 409 if already running', async () => {
    await request(app).post('/api/eye/start').send({});
    const res = await request(app).post('/api/eye/start').send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already running/i);
  });
});

describe('POST /api/eye/stop', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns 404 if eye is not running', async () => {
    const res = await request(app).post('/api/eye/stop');
    expect(res.status).toBe(404);
  });

  it('stops a running eye', async () => {
    await request(app).post('/api/eye/start').send({});
    const res = await request(app).post('/api/eye/stop');
    expect(res.status).toBe(200);
    expect(res.body.stopped).toBe(true);
  });
});

describe('GET /api/eye/config', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns eye config', async () => {
    const res = await request(app).get('/api/eye/config');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('targets');
    expect(res.body).toHaveProperty('prompt');
    expect(res.body).toHaveProperty('defaultPrompt');
  });
});

describe('PUT /api/eye/config', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('updates eye config targets', async () => {
    const res = await request(app)
      .put('/api/eye/config')
      .send({ targets: [{ path: '/repo', context: 'main repo' }] });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('targets');
  });

  it('rejects non-array targets', async () => {
    const res = await request(app)
      .put('/api/eye/config')
      .send({ targets: 'invalid' });
    expect(res.status).toBe(400);
  });

  it('updates linearApiKey', async () => {
    const res = await request(app)
      .put('/api/eye/config')
      .send({ linearApiKey: 'secret-key' });
    expect(res.status).toBe(200);
    expect(res.body.linearApiKey).toBe('***configured***');
  });
});

describe('GET /api/eye/jobs', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns eye jobs list', async () => {
    const res = await request(app).get('/api/eye/jobs');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('GET /api/eye/summaries', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns summaries list', async () => {
    const res = await request(app).get('/api/eye/summaries');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('GET /api/eye/prs', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns PRs list', async () => {
    const res = await request(app).get('/api/eye/prs');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('Eye Discussions', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('GET /api/eye/discussions returns empty array', async () => {
    const res = await request(app).get('/api/eye/discussions');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('POST /api/eye/discussions creates a discussion', async () => {
    const res = await request(app)
      .post('/api/eye/discussions')
      .send({ content: 'What about the auth module?' });
    expect(res.status).toBe(201);
    expect(res.body.discussion).toBeTruthy();
    expect(res.body.message).toBeTruthy();
    expect(res.body.discussion.topic).toContain('auth module');
  });

  it('POST /api/eye/discussions rejects empty content', async () => {
    const res = await request(app)
      .post('/api/eye/discussions')
      .send({ content: '  ' });
    expect(res.status).toBe(400);
  });

  it('GET /api/eye/discussions/:id returns discussion with messages', async () => {
    const create = await request(app)
      .post('/api/eye/discussions')
      .send({ content: 'Question here' });
    const res = await request(app).get(`/api/eye/discussions/${create.body.discussion.id}`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toBeTruthy();
    expect(res.body.messages.length).toBe(1);
  });

  it('GET /api/eye/discussions/:id returns 404 for unknown', async () => {
    const res = await request(app).get('/api/eye/discussions/nonexistent');
    expect(res.status).toBe(404);
  });

  it('POST /api/eye/discussions/:id/messages adds a message', async () => {
    const create = await request(app)
      .post('/api/eye/discussions')
      .send({ content: 'Initial' });
    const res = await request(app)
      .post(`/api/eye/discussions/${create.body.discussion.id}/messages`)
      .send({ content: 'Follow up' });
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('Follow up');
    expect(res.body.role).toBe('user');
  });

  it('POST /api/eye/discussions/:id/messages rejects empty content', async () => {
    const create = await request(app)
      .post('/api/eye/discussions')
      .send({ content: 'Initial' });
    const res = await request(app)
      .post(`/api/eye/discussions/${create.body.discussion.id}/messages`)
      .send({ content: '' });
    expect(res.status).toBe(400);
  });

  it('POST /api/eye/discussions/:id/resolve resolves a discussion', async () => {
    const create = await request(app)
      .post('/api/eye/discussions')
      .send({ content: 'Question' });
    const res = await request(app)
      .post(`/api/eye/discussions/${create.body.discussion.id}/resolve`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('resolved');
  });

  it('POST /api/eye/discussions/:id/reopen reopens a discussion', async () => {
    const create = await request(app)
      .post('/api/eye/discussions')
      .send({ content: 'Question' });
    await request(app).post(`/api/eye/discussions/${create.body.discussion.id}/resolve`);
    const res = await request(app)
      .post(`/api/eye/discussions/${create.body.discussion.id}/reopen`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('open');
  });
});

describe('Eye Proposals', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('GET /api/eye/proposals returns empty array', async () => {
    const res = await request(app).get('/api/eye/proposals');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('GET /api/eye/proposals/:id returns 404 for unknown', async () => {
    const res = await request(app).get('/api/eye/proposals/nonexistent');
    expect(res.status).toBe(404);
  });
});

describe('Eye PR Reviews', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('GET /api/eye/pr-reviews returns empty array', async () => {
    const res = await request(app).get('/api/eye/pr-reviews');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /api/eye/pr-reviews/:id returns 404 for unknown', async () => {
    const res = await request(app).get('/api/eye/pr-reviews/nonexistent');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/eye/agents', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns eye agents list', async () => {
    const res = await request(app).get('/api/eye/agents');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
