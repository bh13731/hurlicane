/**
 * Sentry instrumentation — must be imported before all other modules.
 * Loaded via --import flag in the dev/start scripts so it runs before
 * Express, Socket.io, etc. are required.
 *
 * Set SENTRY_DSN in your .env to enable. When unset, Sentry is a no-op.
 */
import * as Sentry from '@sentry/node';

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    tracesSampleRate: 1.0,
    // Capture 100% of errors in dev; tune down in production
    sampleRate: 1.0,
    // Attach server name so you can filter by machine in Sentry
    serverName: process.env.HOSTNAME ?? 'local',
    // Don't send PII like IP addresses
    sendDefaultPii: false,
    integrations: [
      // Capture console.warn and console.error as Sentry events
      // (so they appear as issues, not just breadcrumbs)
      Sentry.captureConsoleIntegration({ levels: ['warn', 'error'] }),
    ],
    beforeSend(event) {
      // Drop noisy "session closed" warnings — these are expected during
      // hot-reload and don't indicate bugs.
      const msg = event.message ?? event.exception?.values?.[0]?.value ?? '';
      if (msg.includes('[mcp] session closed')) return null;
      return event;
    },
  });

  console.log('[sentry] Initialized');
} else {
  console.log('[sentry] SENTRY_DSN not set — Sentry disabled');
}

export { Sentry };
