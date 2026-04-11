/**
 * Sentry instrumentation — must be imported before all other modules.
 * Loaded via --import flag in the dev/start scripts so it runs before
 * Express, Socket.io, etc. are required.
 *
 * Set SENTRY_DSN in your .env to enable. When unset, Sentry is a no-op.
 */
import * as Sentry from '@sentry/node';

// Swallow EPIPE on stdout/stderr — prevents the server crashing and Sentry
// noise (HURLICANE-Q4) when the downstream log pipe is severed (terminal
// closed, parent process gone, log-collector restart). Without these
// listeners, the async 'error' event from the underlying socket becomes an
// uncaughtException that Sentry captures via captureConsoleIntegration as
// a `write EPIPE` issue originating from whatever console.log fired last.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code !== 'EPIPE') throw err;
});
process.stderr.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code !== 'EPIPE') throw err;
});

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
      // Drop noisy operational log messages that the captureConsoleIntegration
      // would otherwise surface as issues. These are informational — they
      // indicate the system is working as designed, not that something is
      // broken. Each entry should note the Sentry issue(s) it suppresses so
      // we can re-enable if the underlying behaviour changes.
      const msg = event.message ?? event.exception?.values?.[0]?.value ?? '';

      // Hot-reload MCP session closures — expected during dev.
      if (msg.includes('[mcp] session closed')) return null;

      // Resource RSS threshold warnings — tracked separately via the
      // HealthMonitor. Suppresses HURLICANE-NH, -P8, -NY, -NS, -NM, -NG,
      // -NW, -NR, -NN, -NF, -NE, -NX, -NT, -M7, -PR, -PC, -P2, -NQ, -NJ,
      // -ND, -Q2, -PS, -P6, -P3, -P0, -NZ and similar variants. If we
      // genuinely start leaking memory we'll still see it via
      // captureWithContext from the health monitor, not console.warn.
      if (msg.includes('[resource] WARNING: orchestrator RSS')) return null;

      // Watchdog inconsistency reports — the watchdog itself recovers,
      // so the console.warn is informational. Suppresses HURLICANE-18
      // and future variants (agent/job status drift detected + cleaned).
      if (msg.includes('[watchdog] inconsistency:') && msg.includes('cleaning up')) {
        return null;
      }

      // Orphaned lock release log — the watchdog is recovering, not
      // reporting a bug. Suppresses HURLICANE-1A.
      if (msg.includes('[watchdog] releasing') && msg.includes('orphaned lock')) {
        return null;
      }

      // File-claim conflict warnings — the lock registry is doing its
      // job, the workflow will retry. Suppresses HURLICANE-9K, -GW,
      // -K7, -68, -HT and variants.
      if (msg.includes('file claim conflicts')) return null;

      return event;
    },
  });

  console.log('[sentry] Initialized');
} else {
  console.log('[sentry] SENTRY_DSN not set — Sentry disabled');
}

/**
 * Capture an exception with structured context tags (agent_id, job_id, workflow_id, component).
 * Falls back to bare captureException if Sentry is disabled — safe to call unconditionally.
 */
export function captureWithContext(
  err: unknown,
  context?: { agent_id?: string; job_id?: string; workflow_id?: string; component?: string },
): void {
  Sentry.captureException(err, context ? { tags: { ...context } } : undefined);
}

export { Sentry };
