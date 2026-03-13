import { Router } from 'express';
import * as queries from '../db/queries.js';

const router = Router();

router.get('/', (req, res) => {
  const q = (req.query.q as string ?? '').trim();
  if (!q) {
    res.json({ results: [] });
    return;
  }
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const results = queries.searchOutputs(q, limit);
  res.json({ results });
});

export default router;
