import express from 'express';
import type { EyeConfig } from './config.js';
import type { OrchestratorClient } from './orchestrator.js';
import { verifySignature } from './signature.js';
import { dispatch, getDedupStats, getRecentEvents } from './handlers.js';

export function createApp(config: EyeConfig, client: OrchestratorClient): express.Express {
  const app = express();

  let eventsReceived = 0;
  let jobsCreated = 0;
  const startedAt = Date.now();

  // ─── Health check ───────────────────────────────────────────────────────

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // ─── Status ─────────────────────────────────────────────────────────────

  app.get('/status', (_req, res) => {
    res.json({
      uptime_ms: Date.now() - startedAt,
      events_received: eventsReceived,
      jobs_created: jobsCreated,
      dedup: getDedupStats(),
      recent_events: getRecentEvents(),
      config: {
        author: config.author,
        orchestratorUrl: config.orchestratorUrl,
      },
    });
  });

  // ─── Webhook ────────────────────────────────────────────────────────────

  app.post(['/webhook', '/github-webhook'], express.raw({ type: 'application/json' }), (req, res) => {
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    const rawBody = req.body as Buffer;

    if (!verifySignature(config.webhookSecret, rawBody, signature)) {
      console.warn('[eye] invalid signature, rejecting');
      res.status(401).json({ error: 'invalid signature' });
      return;
    }

    const eventType = req.headers['x-github-event'] as string | undefined;
    if (!eventType) {
      res.status(400).json({ error: 'missing X-GitHub-Event header' });
      return;
    }

    let payload: any;
    try {
      payload = JSON.parse(rawBody.toString('utf-8'));
    } catch {
      res.status(400).json({ error: 'invalid JSON body' });
      return;
    }

    eventsReceived++;

    // Fire-and-forget: ack immediately, process async
    res.status(200).json({ ok: true, event: eventType });

    dispatch(eventType, payload, config, client).then(result => {
      if (result) {
        jobsCreated += result.count;
        console.log(`[eye] ${eventType}: ${result.title} (${result.count} job${result.count > 1 ? 's' : ''})`);
      }
    }).catch(err => {
      console.error(`[eye] error processing ${eventType}:`, err);
    });
  });

  return app;
}
