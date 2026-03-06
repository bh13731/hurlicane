import { Router } from 'express';
import * as queries from '../db/queries.js';
import { loadSlackSettings, sendTestMessage, notifyAllChecksPassed } from '../services/SlackNotifier.js';
import { loadSlackAppToken, startSlackBot, stopSlackBot } from '../slack/bot.js';

const router = Router();

// GET /api/slack — return saved settings (token masked)
router.get('/', (_req, res) => {
  const settings = loadSlackSettings();
  const appToken = loadSlackAppToken();
  const templateId = queries.getNote('setting:slack:templateId')?.value ?? '';
  res.json({
    botToken: settings.botToken ? '••••' + settings.botToken.slice(-4) : '',
    appToken: appToken ? '••••' + appToken.slice(-4) : '',
    userId: settings.userId,
    templateId,
    enabled: !!(settings.botToken && settings.userId),
    botEnabled: !!(settings.botToken && appToken),
  });
});

// PUT /api/slack — save settings
router.put('/', (req, res) => {
  const { botToken, userId, appToken, templateId } = req.body;
  if (botToken !== undefined) {
    queries.upsertNote('setting:slack:botToken', String(botToken), null);
  }
  if (userId !== undefined) {
    queries.upsertNote('setting:slack:userId', String(userId), null);
  }
  if (appToken !== undefined) {
    queries.upsertNote('setting:slack:appToken', String(appToken), null);
  }
  if (templateId !== undefined) {
    queries.upsertNote('setting:slack:templateId', String(templateId), null);
  }
  const settings = loadSlackSettings();
  const savedAppToken = loadSlackAppToken();
  const savedTemplateId = queries.getNote('setting:slack:templateId')?.value ?? '';
  res.json({
    botToken: settings.botToken ? '••••' + settings.botToken.slice(-4) : '',
    appToken: savedAppToken ? '••••' + savedAppToken.slice(-4) : '',
    userId: settings.userId,
    templateId: savedTemplateId,
    enabled: !!(settings.botToken && settings.userId),
    botEnabled: !!(settings.botToken && savedAppToken),
  });
});

// POST /api/slack/bot/start — start the Socket Mode bot
router.post('/bot/start', async (_req, res) => {
  try {
    await startSlackBot();
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to start Slack bot' });
  }
});

// POST /api/slack/bot/stop — stop the Socket Mode bot
router.post('/bot/stop', async (_req, res) => {
  try {
    await stopSlackBot();
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to stop Slack bot' });
  }
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

// POST /api/slack/notify — internal endpoint for Eye to send typed notifications
router.post('/notify', async (req, res) => {
  const { type } = req.body;

  if (type === 'all_checks_passed') {
    const { repo, pr, branch, sha } = req.body;
    await notifyAllChecksPassed(repo, pr, branch, sha);
    res.json({ ok: true });
    return;
  }

  res.status(400).json({ error: `Unknown notification type: ${type}` });
});

export default router;
