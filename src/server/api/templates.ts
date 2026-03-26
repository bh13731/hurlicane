import { Router } from 'express';
import { randomUUID } from 'crypto';
import * as queries from '../db/queries.js';
import type { CreateTemplateRequest, UpdateTemplateRequest } from '../../shared/types.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json(queries.listTemplates());
});

router.post('/', (req, res) => {
  const body = req.body as CreateTemplateRequest;
  if (!body.name?.trim() || !body.content?.trim()) {
    res.status(400).json({ error: 'name and content are required' });
    return;
  }
  const now = Date.now();
  const template = queries.insertTemplate({
    id: randomUUID(),
    name: body.name.trim(),
    content: body.content.trim(),
    model: body.model?.trim() || null,
    is_readonly: body.is_readonly ? 1 : 0,
    repo_id: body.repo_id ?? null,
    project_id: body.project_id ?? null,
    context: body.context ? JSON.stringify(body.context) : null,
    priority: body.priority ?? 0,
    is_interactive: body.is_interactive ? 1 : 0,
    retry_policy: body.retry_policy ?? 'none',
    max_retries: body.max_retries ?? 0,
    completion_checks: body.completion_checks?.length ? JSON.stringify(body.completion_checks) : null,
    created_at: now,
    updated_at: now,
  });
  res.status(201).json(template);
});

router.put('/:id', (req, res) => {
  const existing = queries.getTemplateById(req.params.id);
  if (!existing) { res.status(404).json({ error: 'not found' }); return; }
  const body = req.body as UpdateTemplateRequest;
  const fields: Parameters<typeof queries.updateTemplate>[1] = {};
  if (body.name !== undefined) fields.name = body.name.trim();
  if (body.content !== undefined) fields.content = body.content.trim();
  if (body.model !== undefined) fields.model = body.model?.trim() || null;
  if (body.is_readonly !== undefined) fields.is_readonly = body.is_readonly ? 1 : 0;
  if (body.repo_id !== undefined) fields.repo_id = body.repo_id || null;
  if (body.project_id !== undefined) fields.project_id = body.project_id || null;
  if (body.context !== undefined) fields.context = body.context ? JSON.stringify(body.context) : null;
  if (body.priority !== undefined) fields.priority = body.priority;
  if (body.is_interactive !== undefined) fields.is_interactive = body.is_interactive ? 1 : 0;
  if (body.retry_policy !== undefined) fields.retry_policy = body.retry_policy;
  if (body.max_retries !== undefined) fields.max_retries = body.max_retries;
  if (body.completion_checks !== undefined) fields.completion_checks = body.completion_checks?.length ? JSON.stringify(body.completion_checks) : null;
  const updated = queries.updateTemplate(req.params.id, fields);
  res.json(updated);
});

router.delete('/:id', (req, res) => {
  const existing = queries.getTemplateById(req.params.id);
  if (!existing) { res.status(404).json({ error: 'not found' }); return; }
  queries.deleteTemplate(req.params.id);
  res.json({ ok: true });
});

export default router;
