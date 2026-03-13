import { Router } from 'express';
import * as queries from '../db/queries.js';

const router = Router();

router.get('/template-model', (_req, res) => {
  const stats = queries.getTemplateModelStats();
  res.json(stats);
});

export default router;
