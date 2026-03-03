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

interface EyeSettings {
  webhookSecret: string;
  author: string;
  port: number;
  skipPrompt: string;
  discussionPrompt: string;
  disabledEvents: string[];
}

const DEFAULT_SKIP_PROMPT = 'Skip events from repos not registered in the orchestrator.';
const DEFAULT_DISCUSSION_PROMPT = `Escalate to debate when:
- CI suite has 3+ failing checks
- Review requests changes with body longer than 500 characters
Otherwise create a simple job.`;

function loadSettings(): EyeSettings {
  let disabledEvents: string[] = [];
  try {
    const raw = queries.getNote('setting:eye:disabledEvents')?.value;
    if (raw) disabledEvents = JSON.parse(raw);
  } catch { /* ignore bad JSON */ }

  return {
    webhookSecret: queries.getNote('setting:eye:webhookSecret')?.value ?? '',
    author: queries.getNote('setting:eye:author')?.value ?? '',
    port: Number(queries.getNote('setting:eye:port')?.value ?? '4567'),
    skipPrompt: queries.getNote('setting:eye:skipPrompt')?.value ?? '',
    discussionPrompt: queries.getNote('setting:eye:discussionPrompt')?.value ?? '',
    disabledEvents,
  };
}

function saveSettings(settings: EyeSettings): void {
  queries.upsertNote('setting:eye:webhookSecret', settings.webhookSecret, null);
  queries.upsertNote('setting:eye:author', settings.author, null);
  queries.upsertNote('setting:eye:port', String(settings.port), null);
  queries.upsertNote('setting:eye:skipPrompt', settings.skipPrompt, null);
  queries.upsertNote('setting:eye:discussionPrompt', settings.discussionPrompt, null);
  queries.upsertNote('setting:eye:disabledEvents', JSON.stringify(settings.disabledEvents), null);
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// GET /api/eye — return saved config + process status
router.get('/', (_req, res) => {
  const settings = loadSettings();
  res.json({
    settings,
    running: isEyeRunning(),
    pid: eyeProcess?.pid ?? null,
  });
});

// PUT /api/eye — save config
router.put('/', (req, res) => {
  const { webhookSecret, author, port, skipPrompt, discussionPrompt, disabledEvents } = req.body;
  const settings: EyeSettings = {
    webhookSecret: String(webhookSecret ?? ''),
    author: String(author ?? ''),
    port: Number(port ?? 4567),
    skipPrompt: String(skipPrompt ?? ''),
    discussionPrompt: String(discussionPrompt ?? ''),
    disabledEvents: Array.isArray(disabledEvents) ? disabledEvents : [],
  };
  saveSettings(settings);
  res.json({ settings });
});

// GET /api/eye/prompts — return skip + discussion prompts (with defaults filled in)
router.get('/prompts', (_req, res) => {
  const settings = loadSettings();
  res.json({
    skipPrompt: settings.skipPrompt || DEFAULT_SKIP_PROMPT,
    discussionPrompt: settings.discussionPrompt || DEFAULT_DISCUSSION_PROMPT,
    disabledEvents: settings.disabledEvents,
  });
});

// POST /api/eye/start — spawn the eye process
router.post('/start', (_req, res) => {
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
router.post('/stop', (_req, res) => {
  if (!isEyeRunning()) {
    res.json({ ok: true, message: 'Eye was not running' });
    return;
  }

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
