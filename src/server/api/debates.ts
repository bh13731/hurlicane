import { Router } from 'express';
import { randomUUID } from 'crypto';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { spawnInitialRoundJobs } from '../orchestrator/DebateManager.js';
import type { CreateDebateRequest, Debate } from '../../shared/types.js';

const router = Router();

// GET /api/debates — list all debates
router.get('/', (_req, res) => {
  res.json(queries.listDebates());
});

// GET /api/debates/:id — get single debate
router.get('/:id', (req, res) => {
  const debate = queries.getDebateById(req.params.id);
  if (!debate) { res.status(404).json({ error: 'not found' }); return; }
  res.json(debate);
});

// POST /api/debates — create + start a new debate
router.post('/', (req, res) => {
  const body = req.body as CreateDebateRequest;
  if (!body.task?.trim()) {
    res.status(400).json({ error: 'task is required' });
    return;
  }
  if (!body.claudeModel?.trim()) {
    res.status(400).json({ error: 'claudeModel is required' });
    return;
  }
  if (!body.codexModel?.trim()) {
    res.status(400).json({ error: 'codexModel is required' });
    return;
  }

  const debateId = randomUUID();
  const now = Date.now();
  const maxRounds = Math.min(Math.max(body.maxRounds ?? 3, 1), 10);
  const loopCount = Math.min(Math.max(body.loopCount ?? 1, 1), 20);
  const title = body.title?.trim() || `Debate: ${body.task.trim().slice(0, 40)}`;

  // Create a project for this debate
  const project = queries.insertProject({
    id: randomUUID(),
    name: title,
    description: `Debate between ${body.claudeModel} and ${body.codexModel}`,
    created_at: now,
    updated_at: now,
  });

  // Create the debate record
  const debate: Debate = {
    id: debateId,
    title,
    task: body.task.trim(),
    claude_model: body.claudeModel.trim(),
    codex_model: body.codexModel.trim(),
    max_rounds: maxRounds,
    current_round: 0,
    status: 'running',
    consensus: null,
    project_id: project.id,
    work_dir: body.workDir?.trim() || null,
    max_turns: body.maxTurns ?? 50,
    template_id: body.templateId?.trim() || null,
    post_action_prompt: body.postActionPrompt?.trim() || null,
    post_action_role: body.postActionRole ?? null,
    post_action_job_id: null,
    post_action_verification: (body.postActionVerification && !!body.postActionPrompt?.trim()) ? 1 : 0,
    verification_review_job_id: null,
    verification_response_job_id: null,
    verification_round: 0,
    loop_count: loopCount,
    current_loop: 0,
    created_at: now,
    updated_at: now,
  };
  queries.insertDebate(debate);

  const [claudeJob, codexJob] = spawnInitialRoundJobs(debate);

  socket.emitDebateNew(debate);

  res.status(201).json({ debate, project, jobs: [claudeJob, codexJob] });
});

// POST /api/debates/:id/cancel — cancel a running debate
router.post('/:id/cancel', (req, res) => {
  const debate = queries.getDebateById(req.params.id);
  if (!debate) { res.status(404).json({ error: 'not found' }); return; }
  if (debate.status !== 'running') {
    res.status(400).json({ error: 'Debate is not running' });
    return;
  }

  const updated = queries.updateDebate(debate.id, { status: 'cancelled' });
  if (updated) socket.emitDebateUpdate(updated);
  res.json(updated);
});

export default router;
