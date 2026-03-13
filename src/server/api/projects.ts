import { Router } from 'express';
import { randomUUID } from 'crypto';
import * as queries from '../db/queries.js';
import type { CreateProjectRequest } from '../../shared/types.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json(queries.listProjects());
});

router.get('/:id', (req, res) => {
  const project = queries.getProjectById(req.params.id);
  if (!project) { res.status(404).json({ error: 'not found' }); return; }
  res.json(project);
});

router.post('/', (req, res) => {
  const body = req.body as CreateProjectRequest;
  if (!body.name?.trim()) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  const now = Date.now();
  const project = queries.insertProject({
    id: randomUUID(),
    name: body.name.trim(),
    description: body.description?.trim() || null,
    created_at: now,
    updated_at: now,
  });
  res.status(201).json(project);
});

router.put('/:id', (req, res) => {
  const existing = queries.getProjectById(req.params.id);
  if (!existing) { res.status(404).json({ error: 'not found' }); return; }
  const body = req.body as Partial<CreateProjectRequest>;
  const updated = queries.updateProject(req.params.id, {
    ...(body.name !== undefined ? { name: body.name.trim() } : {}),
    ...(body.description !== undefined ? { description: body.description?.trim() || null } : {}),
  });
  res.json(updated);
});

router.delete('/:id', (req, res) => {
  const existing = queries.getProjectById(req.params.id);
  if (!existing) { res.status(404).json({ error: 'not found' }); return; }
  queries.deleteProject(req.params.id);
  res.json({ ok: true });
});

export default router;
