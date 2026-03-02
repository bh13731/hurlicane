import { Router } from 'express';
import { randomUUID } from 'crypto';
import * as queries from '../db/queries.js';
import { runConsolidation } from '../orchestrator/KBConsolidator.js';

const router = Router();

router.get('/', (req, res) => {
  const projectId = req.query.projectId as string | undefined;
  res.json(queries.listKBEntries(projectId));
});

router.get('/search', (req, res) => {
  const q = req.query.q as string;
  if (!q) { res.status(400).json({ error: 'q parameter required' }); return; }
  const projectId = req.query.projectId as string | undefined;
  res.json(queries.searchKB(q, projectId));
});

router.post('/', (req, res) => {
  const { title, content, tags, source, projectId } = req.body;
  if (!title || !content) { res.status(400).json({ error: 'title and content required' }); return; }
  const entry = queries.insertKBEntry({
    id: randomUUID(),
    title,
    content,
    tags: tags ?? null,
    source: source ?? null,
    project_id: projectId ?? null,
  });
  res.status(201).json(entry);
});

router.put('/:id', (req, res) => {
  const entry = queries.getKBEntryById(req.params.id);
  if (!entry) { res.status(404).json({ error: 'not found' }); return; }
  const updated = queries.updateKBEntry(req.params.id, req.body);
  res.json(updated);
});

router.delete('/:id', (req, res) => {
  const entry = queries.getKBEntryById(req.params.id);
  if (!entry) { res.status(404).json({ error: 'not found' }); return; }
  queries.deleteKBEntry(req.params.id);
  res.json({ deleted: true });
});

router.post('/consolidate', async (_req, res) => {
  try {
    const result = await runConsolidation();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'consolidation failed' });
  }
});

export default router;
