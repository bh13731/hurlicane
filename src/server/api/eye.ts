import { Router } from 'express';
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import * as queries from '../db/queries.js';

const router = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../../..');

// ─── Eye process management ────────────────────────────────────────────────

let eyeProcess: ChildProcess | null = null;
let eyeLogs: string[] = [];
const MAX_LOG_LINES = 200;

function appendLog(line: string): void {
  eyeLogs.push(line);
  if (eyeLogs.length > MAX_LOG_LINES) eyeLogs.splice(0, eyeLogs.length - MAX_LOG_LINES);
}

function isEyeRunning(): boolean {
  if (!eyeProcess || eyeProcess.exitCode !== null || eyeProcess.killed) {
    eyeProcess = null;
    return false;
  }
  return true;
}

// ─── Config persistence ────────────────────────────────────────────────────

interface TemplateFilter {
  field: string;
  op: 'eq' | 'neq';
  value: string;
}

interface TemplateBinding {
  templateId: string;
  filters: TemplateFilter[];
}

interface EyeSettings {
  webhookSecret: string;
  author: string;
  port: number;
  eventTemplates: Record<string, TemplateBinding[]>;
  disabledEvents: string[];
}

function loadSettings(): EyeSettings {
  let disabledEvents: string[] = [];
  try {
    const raw = queries.getNote('setting:eye:disabledEvents')?.value;
    if (raw) disabledEvents = JSON.parse(raw);
  } catch { /* ignore bad JSON */ }

  let eventTemplates: Record<string, TemplateBinding[]> = {};
  try {
    const raw = queries.getNote('setting:eye:eventTemplates')?.value;
    if (raw) {
      const parsed = JSON.parse(raw);
      for (const [key, val] of Object.entries(parsed)) {
        if (Array.isArray(val)) {
          // Migrate from string[] to TemplateBinding[]
          eventTemplates[key] = (val as any[]).map(item => {
            if (typeof item === 'string') {
              return { templateId: item, filters: [] };
            }
            return item as TemplateBinding;
          });
        } else if (typeof val === 'string' && val) {
          eventTemplates[key] = [{ templateId: val, filters: [] }];
        }
      }
    }
  } catch { /* ignore bad JSON */ }

  // Migrate legacy single templateId
  if (Object.keys(eventTemplates).length === 0) {
    const legacyTemplateId = queries.getNote('setting:eye:templateId')?.value;
    if (legacyTemplateId) {
      const binding: TemplateBinding = { templateId: legacyTemplateId, filters: [] };
      eventTemplates = {
        check_suite: [binding],
        check_run: [binding],
        pull_request_review: [binding],
        issue_comment: [binding],
      };
    }
  }

  return {
    webhookSecret: queries.getNote('setting:eye:webhookSecret')?.value ?? '',
    author: queries.getNote('setting:eye:author')?.value ?? '',
    port: Number(queries.getNote('setting:eye:port')?.value ?? '4567'),
    eventTemplates,
    disabledEvents,
  };
}

function saveSettings(settings: EyeSettings): void {
  queries.upsertNote('setting:eye:webhookSecret', settings.webhookSecret, null);
  queries.upsertNote('setting:eye:author', settings.author, null);
  queries.upsertNote('setting:eye:port', String(settings.port), null);
  queries.upsertNote('setting:eye:eventTemplates', JSON.stringify(settings.eventTemplates), null);
  queries.upsertNote('setting:eye:disabledEvents', JSON.stringify(settings.disabledEvents), null);
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// GET /api/eye — return saved config + process status
router.get('/', async (_req, res) => {
  const settings = loadSettings();
  let running = isEyeRunning();

  // Detect orphaned Eye process (e.g. server restarted but child survived)
  if (!running) {
    const eyePort = settings.port || 4567;
    try {
      const probe = await fetch(`http://localhost:${eyePort}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (probe.ok) running = true;
    } catch { /* not reachable */ }
  }

  res.json({
    settings,
    running,
    pid: eyeProcess?.pid ?? null,
  });
});

// PUT /api/eye — save config
router.put('/', (req, res) => {
  const { webhookSecret, author, port, eventTemplates, disabledEvents } = req.body;
  const settings: EyeSettings = {
    webhookSecret: String(webhookSecret ?? ''),
    author: String(author ?? ''),
    port: Number(port ?? 4567),
    eventTemplates: (eventTemplates && typeof eventTemplates === 'object') ? eventTemplates : {},
    disabledEvents: Array.isArray(disabledEvents) ? disabledEvents : [],
  };
  saveSettings(settings);
  res.json({ settings });
});

// GET /api/eye/prompts — return templateId + disabled events
router.get('/prompts', (_req, res) => {
  const settings = loadSettings();
  res.json({
    eventTemplates: settings.eventTemplates,
    disabledEvents: settings.disabledEvents,
    botName: queries.getNote('setting:botName')?.value ?? '',
  });
});

// POST /api/eye/start — spawn the eye process
router.post('/start', async (_req, res) => {
  if (isEyeRunning()) {
    res.status(409).json({ error: 'Eye is already running', pid: eyeProcess!.pid });
    return;
  }

  const settings = loadSettings();
  if (!settings.webhookSecret) {
    res.status(400).json({ error: 'Webhook secret is required. Configure it first.' });
    return;
  }
  if (!settings.author) {
    res.status(400).json({ error: 'Author is required. Configure it first.' });
    return;
  }

  // Check if an orphaned Eye process is still listening on the port
  // (e.g. server restarted via HMR but child process survived)
  const eyePort = settings.port || 4567;
  try {
    const probe = await fetch(`http://localhost:${eyePort}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (probe.ok) {
      // Eye is actually running — adopt it by updating our state
      res.status(409).json({ error: 'Eye is already running on port ' + eyePort + ' (orphaned process)' });
      return;
    }
  } catch { /* port not in use — safe to start */ }

  const args = [
    'eye/index.ts',
    '--webhook-secret', settings.webhookSecret,
    '--author', settings.author,
    '--port', String(settings.port || 4567),
    '--orchestrator-url', `http://localhost:${process.env.PORT ?? 3000}`,
  ];

  eyeLogs = [];
  appendLog(`[eye] Starting: npx tsx ${args.join(' ')}`);

  try {
    const child = spawn('npx', ['tsx', ...args], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    eyeProcess = child;

    child.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        appendLog(line);
        console.log(`[eye:stdout] ${line}`);
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        appendLog(`[stderr] ${line}`);
        console.error(`[eye:stderr] ${line}`);
      }
    });

    child.on('close', (code) => {
      appendLog(`[eye] Process exited with code ${code}`);
      console.log(`[eye] Process exited with code ${code}`);
      eyeProcess = null;
    });

    child.on('error', (err) => {
      appendLog(`[eye] Spawn error: ${err.message}`);
      console.error(`[eye] Spawn error:`, err);
      eyeProcess = null;
    });

    res.json({ ok: true, pid: child.pid });
  } catch (err: any) {
    res.status(500).json({ error: `Failed to spawn: ${err.message}` });
  }
});

// POST /api/eye/stop — kill the eye process
router.post('/stop', async (_req, res) => {
  if (isEyeRunning()) {
    appendLog('[eye] Stopping...');
    eyeProcess!.kill('SIGTERM');

    // Force kill after 5s
    const forceTimer = setTimeout(() => {
      if (isEyeRunning()) {
        eyeProcess!.kill('SIGKILL');
        appendLog('[eye] Force killed');
      }
    }, 5000);
    forceTimer.unref();

    res.json({ ok: true });
    return;
  }

  // Handle orphaned process: find and kill whatever is on the Eye port
  const settings = loadSettings();
  const eyePort = settings.port || 4567;
  try {
    const probe = await fetch(`http://localhost:${eyePort}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (probe.ok) {
      // Find the PID listening on the port and kill it
      const { execSync } = await import('child_process');
      try {
        const pid = execSync(`lsof -ti tcp:${eyePort}`, { timeout: 5000 }).toString().trim().split('\n')[0];
        if (pid) {
          process.kill(Number(pid), 'SIGTERM');
          appendLog(`[eye] Killed orphaned process (pid ${pid}) on port ${eyePort}`);
          res.json({ ok: true, message: `Killed orphaned process (pid ${pid})` });
          return;
        }
      } catch { /* lsof failed or process already gone */ }
    }
  } catch { /* not reachable — nothing to stop */ }

  res.json({ ok: true, message: 'Eye was not running' });
});

// GET /api/eye/logs — return recent logs
router.get('/logs', (_req, res) => {
  res.json({ logs: eyeLogs });
});

// GET /api/eye/status — proxy to the eye service's /status endpoint
// This avoids the client hitting the eye port directly (which causes
// ECONNREFUSED proxy errors in Vite when eye is down).
router.get('/status', async (_req, res) => {
  const settings = loadSettings();
  const eyePort = settings.port || 4567;
  try {
    const upstream = await fetch(`http://localhost:${eyePort}/status`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!upstream.ok) {
      res.status(502).json({ error: `Eye returned ${upstream.status}` });
      return;
    }
    const data = await upstream.json();
    res.json(data);
  } catch {
    res.status(502).json({ error: 'Eye is not reachable' });
  }
});

// ─── Exported for shutdown ──────────────────────────────────────────────────

export function stopEyeProcess(): void {
  if (isEyeRunning() && eyeProcess) {
    eyeProcess.kill('SIGTERM');
  }
}

export default router;
