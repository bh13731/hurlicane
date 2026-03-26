import { Router } from 'express';
import { randomUUID } from 'crypto';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import type { CreateBatchTemplateRequest, UpdateBatchTemplateRequest, RunBatchTemplateRequest, Job } from '../../shared/types.js';

const router = Router();

// List all batch templates
router.get('/', (_req, res) => {
  res.json(queries.listBatchTemplates());
});

// Get one batch template
router.get('/:id', (req, res) => {
  const bt = queries.getBatchTemplateById(req.params.id);
  if (!bt) { res.status(404).json({ error: 'not found' }); return; }
  res.json(bt);
});

// Create a batch template
router.post('/', (req, res) => {
  const body = req.body as CreateBatchTemplateRequest;
  if (!body.name?.trim()) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  if (!Array.isArray(body.items) || body.items.filter(i => i.trim()).length === 0) {
    res.status(400).json({ error: 'at least one non-empty item is required' });
    return;
  }
  const now = Date.now();
  const bt = queries.insertBatchTemplate({
    id: randomUUID(),
    name: body.name.trim(),
    items: body.items.map(i => i.trim()).filter(Boolean),
    created_at: now,
    updated_at: now,
  });
  res.status(201).json(bt);
});

// Update a batch template
router.put('/:id', (req, res) => {
  const existing = queries.getBatchTemplateById(req.params.id);
  if (!existing) { res.status(404).json({ error: 'not found' }); return; }
  const body = req.body as UpdateBatchTemplateRequest;
  const fields: Parameters<typeof queries.updateBatchTemplate>[1] = {};
  if (body.name !== undefined) fields.name = body.name.trim();
  if (body.items !== undefined) {
    const cleaned = body.items.map(i => i.trim()).filter(Boolean);
    if (cleaned.length === 0) {
      res.status(400).json({ error: 'at least one non-empty item is required' });
      return;
    }
    fields.items = cleaned;
  }
  const updated = queries.updateBatchTemplate(req.params.id, fields);
  res.json(updated);
});

// Delete a batch template
router.delete('/:id', (req, res) => {
  const existing = queries.getBatchTemplateById(req.params.id);
  if (!existing) { res.status(404).json({ error: 'not found' }); return; }
  queries.deleteBatchTemplate(req.params.id);
  res.json({ ok: true });
});

// Run a batch template — creates project + N jobs
router.post('/:id/run', (req, res) => {
  const bt = queries.getBatchTemplateById(req.params.id);
  if (!bt) { res.status(404).json({ error: 'batch template not found' }); return; }

  const body = req.body as RunBatchTemplateRequest;
  const now = Date.now();

  // Create the project
  const project = queries.insertProject({
    id: randomUUID(),
    name: body.projectName?.trim() || bt.name,
    description: `Batch run of "${bt.name}" (${bt.items.length} items)`,
    created_at: now,
    updated_at: now,
  });

  // Check if the selected template enforces readonly
  const tpl = body.templateId ? queries.getTemplateById(body.templateId) : null;
  const isReadonly = tpl?.is_readonly ? 1 : 0;

  const jobs = bt.items.map(item => {
    const job = queries.insertJob({
      id: randomUUID(),
      title: item.length > 28 ? item.slice(0, 27) + '\u2026' : item,
      description: item,
      context: tpl?.context ?? null,
      priority: tpl?.priority ?? 0,
      model: body.model ?? tpl?.model ?? null,
      template_id: body.templateId ?? null,
      is_interactive: body.interactive !== undefined ? (body.interactive ? 1 : 0) : (tpl?.is_interactive ?? 0),
      is_readonly: isReadonly,
      repo_id: body.repoId ?? tpl?.repo_id ?? null,
      branch: body.branch ?? null,
      max_turns: body.maxTurns ?? 50,
      project_id: project.id,
      retry_policy: tpl?.retry_policy ?? 'none',
      max_retries: tpl?.max_retries ?? 0,
      completion_checks: tpl?.completion_checks ?? null,
    });
    socket.emitJobNew(job);
    return job;
  });

  res.status(201).json({ project, jobs });
});

export default router;
