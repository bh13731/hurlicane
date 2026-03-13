import { Router } from 'express';
import * as queries from '../db/queries.js';
import { runCleanupNow } from '../orchestrator/WorktreeCleanup.js';

const router = Router();

router.get('/stats', (_req, res) => {
  const stats = queries.getWorktreeStats();
  res.json(stats);
});

router.post('/cleanup', (_req, res) => {
  const cleaned = runCleanupNow();
  res.json({ cleaned });
});

export default router;
