import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const router = Router();

const VALID_SINCE = /^[0-9]{8}$/;

// gpt-5.2-codex pricing, used as fallback for newer GPT models that LiteLLM hasn't priced yet
const GPT52_CODEX = { input: 1.75e-6, cacheRead: 1.75e-7, output: 1.40e-5 };

// Codex returns dates like "Feb 23, 2026"; normalize to "2026-02-23" to match Claude data
function normalizeDate(d: string): string {
  const parsed = new Date(d);
  if (isNaN(parsed.getTime())) return d;
  return parsed.toISOString().slice(0, 10);
}

function applyCodexFallbackPricing(codex: any): any {
  if (!Array.isArray(codex.daily)) return codex;
  const daily = codex.daily.map((entry: any) => {
    entry = { ...entry, date: normalizeDate(entry.date) };
    if (entry.costUSD !== 0 || !entry.totalTokens) return entry;
    const models = Object.keys(entry.models ?? {});
    if (!models.some((m: string) => /gpt/i.test(m))) return entry;
    const uncached = (entry.inputTokens ?? 0) - (entry.cachedInputTokens ?? 0);
    const costUSD =
      uncached * GPT52_CODEX.input +
      (entry.cachedInputTokens ?? 0) * GPT52_CODEX.cacheRead +
      (entry.outputTokens ?? 0) * GPT52_CODEX.output;
    return { ...entry, costUSD };
  });
  const totalCostUSD = daily.reduce((s: number, e: any) => s + (e.costUSD ?? 0), 0);
  const totals = codex.totals ? { ...codex.totals, costUSD: totalCostUSD } : { costUSD: totalCostUSD };
  return { ...codex, daily, totals };
}

async function runCcusage(args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync('npx', ['--yes', ...args], { timeout: 60_000 });
  } catch (err: any) {
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

// ── Cache to avoid spawning expensive ccusage processes on every request ─────
// ccusage shells out to parse log files and can take 10-30s+ under load.
// The client polls every 60s and on every agent completion, so without caching
// multiple overlapping ccusage processes easily saturate the CPU.
const CACHE_TTL_MS = 120_000; // 2 minutes
const _cache = new Map<string, { data: any; timestamp: number }>();
let _inFlight: Promise<any> | null = null;

async function fetchUsageCached(since: string): Promise<any> {
  const cached = _cache.get(since);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  // If another request is already fetching, wait for it instead of spawning more processes
  if (_inFlight) return _inFlight;

  _inFlight = (async () => {
    try {
      const [claudeResult, codexResult] = await Promise.all([
        runCcusage(['ccusage@17', 'daily', '--since', since, '--json']),
        runCcusage(['@ccusage/codex@17', 'daily', '--since', since, '--json']),
      ]);

      if (!claudeResult.stdout.trim()) {
        throw new Error(`ccusage failed: ${claudeResult.stderr}`);
      }

      let parsed: any;
      try {
        parsed = JSON.parse(claudeResult.stdout);
      } catch (parseErr: any) {
        throw new Error(`Failed to parse ccusage output: ${parseErr.message}`);
      }

      if (Array.isArray(parsed)) {
        parsed = { daily: [], totals: null };
      }

      let codex: unknown = null;
      if (codexResult.stdout.trim()) {
        try {
          const codexParsed = JSON.parse(codexResult.stdout);
          const normalized = Array.isArray(codexParsed) ? { daily: [], totals: null } : codexParsed;
          codex = applyCodexFallbackPricing(normalized);
        } catch { /* codex stays null */ }
      }

      const result = { ...parsed, codex };
      _cache.set(since, { data: result, timestamp: Date.now() });
      return result;
    } finally {
      _inFlight = null;
    }
  })();

  return _inFlight;
}

router.get('/', async (req, res) => {
  const since = (req.query.since as string) || '7d';

  if (!VALID_SINCE.test(since)) {
    res.status(400).json({ error: 'Invalid since parameter' });
    return;
  }

  try {
    const result = await fetchUsageCached(since);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
