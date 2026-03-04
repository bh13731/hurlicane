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
    created_at: now,
    updated_at: now,
  });
  res.status(201).json(template);
});

router.put('/:id', (req, res) => {
  const existing = queries.getTemplateById(req.params.id);
  if (!existing) { res.status(404).json({ error: 'not found' }); return; }
  const body = req.body as UpdateTemplateRequest;
  const updated = queries.updateTemplate(req.params.id, {
    ...(body.name !== undefined ? { name: body.name.trim() } : {}),
    ...(body.content !== undefined ? { content: body.content.trim() } : {}),
    ...(body.model !== undefined ? { model: body.model?.trim() || null } : {}),
    ...(body.is_readonly !== undefined ? { is_readonly: body.is_readonly ? 1 : 0 } : {}),
  });
  res.json(updated);
});

router.delete('/:id', (req, res) => {
  const existing = queries.getTemplateById(req.params.id);
  if (!existing) { res.status(404).json({ error: 'not found' }); return; }
  queries.deleteTemplate(req.params.id);
  res.json({ ok: true });
});

export default router;
