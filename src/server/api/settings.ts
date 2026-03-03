import { Router } from 'express';
import * as queries from '../db/queries.js';
import { getMaxConcurrent, setMaxConcurrent } from '../orchestrator/WorkQueueManager.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json({
    maxConcurrentAgents: getMaxConcurrent(),
  });
});

router.put('/', (req, res) => {
  const { maxConcurrentAgents } = req.body;
  if (maxConcurrentAgents !== undefined) {
    if (typeof maxConcurrentAgents !== 'number' || maxConcurrentAgents < 1 || maxConcurrentAgents > 100) {
      res.status(400).json({ error: 'maxConcurrentAgents must be a number between 1 and 100' });
      return;
    }
    const n = Math.floor(maxConcurrentAgents);
    setMaxConcurrent(n);
    queries.upsertNote('setting:maxConcurrentAgents', String(n), null);
  }
  res.json({
    maxConcurrentAgents: getMaxConcurrent(),
  });
});

export default router;
