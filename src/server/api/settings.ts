import { Router } from 'express';
import * as queries from '../db/queries.js';
import { getMaxConcurrent, setMaxConcurrent } from '../orchestrator/WorkQueueManager.js';

const router = Router();

/** Restore ANTHROPIC_API_KEY from DB on server start. Called from initDb consumers. */
export function restoreApiKey(): void {
  const note = queries.getNote('setting:anthropicApiKey');
  if (note?.value) {
    process.env.ANTHROPIC_API_KEY = note.value;
  }
}

router.get('/', (_req, res) => {
  const key = process.env.ANTHROPIC_API_KEY ?? '';
  res.json({
    maxConcurrentAgents: getMaxConcurrent(),
    anthropicApiKey: key ? `${key.slice(0, 10)}...${key.slice(-4)}` : '',
    hasAnthropicApiKey: !!key,
  });
});

router.put('/', (req, res) => {
  const { maxConcurrentAgents, anthropicApiKey } = req.body;
  if (maxConcurrentAgents !== undefined) {
    if (typeof maxConcurrentAgents !== 'number' || maxConcurrentAgents < 1 || maxConcurrentAgents > 100) {
      res.status(400).json({ error: 'maxConcurrentAgents must be a number between 1 and 100' });
      return;
    }
    const n = Math.floor(maxConcurrentAgents);
    setMaxConcurrent(n);
    queries.upsertNote('setting:maxConcurrentAgents', String(n), null);
  }
  if (anthropicApiKey !== undefined) {
    const trimmed = (anthropicApiKey as string).trim();
    if (trimmed) {
      process.env.ANTHROPIC_API_KEY = trimmed;
      queries.upsertNote('setting:anthropicApiKey', trimmed, null);
    } else {
      delete process.env.ANTHROPIC_API_KEY;
      queries.upsertNote('setting:anthropicApiKey', '', null);
    }
  }
  const key = process.env.ANTHROPIC_API_KEY ?? '';
  res.json({
    maxConcurrentAgents: getMaxConcurrent(),
    anthropicApiKey: key ? `${key.slice(0, 10)}...${key.slice(-4)}` : '',
    hasAnthropicApiKey: !!key,
  });
});

export default router;
