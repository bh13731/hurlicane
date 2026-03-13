import { Router } from 'express';
import * as queries from '../db/queries.js';
import { getMaxConcurrent, setMaxConcurrent } from '../orchestrator/WorkQueueManager.js';

const router = Router();

function getEyeEnabled(): boolean {
  return queries.getNote('setting:eyeEnabled')?.value === 'true';
}

router.get('/', (_req, res) => {
  res.json({ maxConcurrentAgents: getMaxConcurrent(), eyeEnabled: getEyeEnabled() });
});

router.put('/', (req, res) => {
  const { maxConcurrentAgents, eyeEnabled } = req.body;
  if (maxConcurrentAgents !== undefined) {
    if (typeof maxConcurrentAgents !== 'number' || maxConcurrentAgents < 1 || maxConcurrentAgents > 100) {
      res.status(400).json({ error: 'maxConcurrentAgents must be a number between 1 and 100' });
      return;
    }
    const n = Math.floor(maxConcurrentAgents);
    setMaxConcurrent(n);
    queries.upsertNote('setting:maxConcurrentAgents', String(n), null);
  }
  if (eyeEnabled !== undefined) {
    queries.upsertNote('setting:eyeEnabled', String(!!eyeEnabled), null);
  }
  res.json({ maxConcurrentAgents: getMaxConcurrent(), eyeEnabled: getEyeEnabled() });
});

export default router;
