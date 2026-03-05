import { Router } from 'express';
import * as queries from '../db/queries.js';
import { getMaxConcurrent, setMaxConcurrent } from '../orchestrator/WorkQueueManager.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json({
    maxConcurrentAgents: getMaxConcurrent(),
    systemPromptAppendix: queries.getNote('setting:systemPromptAppendix')?.value ?? '',
    botName: queries.getNote('setting:botName')?.value ?? '',
  });
});

router.put('/', (req, res) => {
  const { maxConcurrentAgents, systemPromptAppendix } = req.body;
  if (typeof maxConcurrentAgents !== 'number' || maxConcurrentAgents < 1 || maxConcurrentAgents > 100) {
    res.status(400).json({ error: 'maxConcurrentAgents must be a number between 1 and 100' });
    return;
  }
  const n = Math.floor(maxConcurrentAgents);
  setMaxConcurrent(n);
  queries.upsertNote('setting:maxConcurrentAgents', String(n), null);
  if (typeof systemPromptAppendix === 'string') {
    queries.upsertNote('setting:systemPromptAppendix', systemPromptAppendix, null);
  }
  if (req.body.botName !== undefined) {
    queries.upsertNote('setting:botName', String(req.body.botName), null);
  }
  res.json({
    maxConcurrentAgents: n,
    systemPromptAppendix: queries.getNote('setting:systemPromptAppendix')?.value ?? '',
    botName: queries.getNote('setting:botName')?.value ?? '',
  });
});

export default router;
