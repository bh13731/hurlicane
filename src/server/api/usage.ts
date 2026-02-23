import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const router = Router();

const VALID_SINCE = /^[0-9]{8}$/;

async function runCcusage(args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync('npx', args, { timeout: 30_000 });
  } catch (err: any) {
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

router.get('/', async (req, res) => {
  const since = (req.query.since as string) || '7d';

  if (!VALID_SINCE.test(since)) {
    res.status(400).json({ error: 'Invalid since parameter' });
    return;
  }

  const [claudeResult, codexResult] = await Promise.all([
    runCcusage(['ccusage', 'daily', '--since', since, '--json']),
    runCcusage(['@ccusage/codex', 'daily', '--since', since, '--json']),
  ]);

  if (!claudeResult.stdout.trim()) {
    res.status(500).json({ error: `ccusage failed: ${claudeResult.stderr}` });
    return;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(claudeResult.stdout);
  } catch (parseErr: any) {
    res.status(500).json({ error: `Failed to parse ccusage output: ${parseErr.message}` });
    return;
  }

  // ccusage returns [] when there is no data for the period;
  // normalize to the object shape the client expects.
  if (Array.isArray(parsed)) {
    parsed = { daily: [], totals: null };
  }

  // Attach Codex data (best-effort; null if unavailable)
  let codex: unknown = null;
  if (codexResult.stdout.trim()) {
    try {
      const codexParsed = JSON.parse(codexResult.stdout);
      codex = Array.isArray(codexParsed) ? { daily: [], totals: null } : codexParsed;
    } catch {
      // ignore parse error — codex stays null
    }
  }

  res.json({ ...parsed, codex });
});

export default router;
