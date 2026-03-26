import { Router } from 'express';
import { execSync } from 'child_process';
import * as queries from '../db/queries.js';
import { getMaxConcurrent, setMaxConcurrent } from '../orchestrator/WorkQueueManager.js';

const router = Router();

let _commitHash: string | null = null;
try {
  _commitHash = execSync('git rev-parse HEAD', { timeout: 5000, stdio: 'pipe' }).toString().trim();
} catch { /* not in a git repo */ }

function maskKey(key: string): string {
  if (!key || key.length < 12) return key ? '••••' : '';
  return key.slice(0, 7) + '•'.repeat(8) + key.slice(-4);
}

router.get('/', (_req, res) => {
  const apiKey = queries.getNote('setting:anthropicApiKey')?.value ?? '';
  res.json({
    maxConcurrentAgents: getMaxConcurrent(),
    systemPromptAppendix: queries.getNote('setting:systemPromptAppendix')?.value ?? '',
    botName: queries.getNote('setting:botName')?.value ?? '',
    defaultModel: queries.getNote('setting:defaultModel')?.value ?? '',
    anthropicApiKey: maskKey(apiKey),
    anthropicApiKeySet: !!apiKey,
    gitAuthorName: queries.getNote('setting:gitAuthorName')?.value ?? '',
    gitAuthorEmail: queries.getNote('setting:gitAuthorEmail')?.value ?? '',
    version: _commitHash,
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
  if (req.body.defaultModel !== undefined) {
    queries.upsertNote('setting:defaultModel', String(req.body.defaultModel), null);
  }
  if (req.body.gitAuthorName !== undefined) {
    queries.upsertNote('setting:gitAuthorName', String(req.body.gitAuthorName), null);
  }
  if (req.body.gitAuthorEmail !== undefined) {
    queries.upsertNote('setting:gitAuthorEmail', String(req.body.gitAuthorEmail), null);
  }
  if (req.body.anthropicApiKey !== undefined) {
    const key = String(req.body.anthropicApiKey);
    // Only update if it's a real key (not the masked placeholder)
    if (!key.includes('••')) {
      queries.upsertNote('setting:anthropicApiKey', key, null);
      // Set on process.env so LLMHelper and title generation pick it up immediately
      if (key) {
        process.env.ANTHROPIC_API_KEY = key;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
  }
  const savedKey = queries.getNote('setting:anthropicApiKey')?.value ?? '';
  res.json({
    maxConcurrentAgents: n,
    systemPromptAppendix: queries.getNote('setting:systemPromptAppendix')?.value ?? '',
    botName: queries.getNote('setting:botName')?.value ?? '',
    defaultModel: queries.getNote('setting:defaultModel')?.value ?? '',
    anthropicApiKey: maskKey(savedKey),
    anthropicApiKeySet: !!savedKey,
    gitAuthorName: queries.getNote('setting:gitAuthorName')?.value ?? '',
    gitAuthorEmail: queries.getNote('setting:gitAuthorEmail')?.value ?? '',
  });
});

export default router;
