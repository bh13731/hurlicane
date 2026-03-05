import { Router } from 'express';
import * as queries from '../db/queries.js';
import { loadSlackSettings, sendTestMessage } from '../services/SlackNotifier.js';

const router = Router();

// GET /api/slack — return saved settings (token masked)
router.get('/', (_req, res) => {
  const settings = loadSlackSettings();
  res.json({
    botToken: settings.botToken ? '••••' + settings.botToken.slice(-4) : '',
    userId: settings.userId,
    enabled: !!(settings.botToken && settings.userId),
  });
});

// PUT /api/slack — save settings
router.put('/', (req, res) => {
  const { botToken, userId } = req.body;
  if (botToken !== undefined) {
    queries.upsertNote('setting:slack:botToken', String(botToken), null);
  }
  if (userId !== undefined) {
    queries.upsertNote('setting:slack:userId', String(userId), null);
  }
  const settings = loadSlackSettings();
  res.json({
    botToken: settings.botToken ? '••••' + settings.botToken.slice(-4) : '',
    userId: settings.userId,
    enabled: !!(settings.botToken && settings.userId),
  });
});

// POST /api/slack/test — send a test message
router.post('/test', async (req, res) => {
  const { botToken, userId } = req.body;
  const token = botToken || loadSlackSettings().botToken;
  const user = userId || loadSlackSettings().userId;

  if (!token || !user) {
    res.status(400).json({ error: 'Bot token and user ID are required' });
    return;
  }

  try {
    const result = await sendTestMessage(token, user);
    if (!result.ok) {
      res.status(400).json({ error: result.error ?? 'Slack API error' });
      return;
    }
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to send test message' });
  }
});

export default router;
