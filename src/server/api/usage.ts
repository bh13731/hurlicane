import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const router = Router();

const VALID_SINCE = /^[0-9]{8}$/;

router.get('/', async (req, res) => {
  const since = (req.query.since as string) || '7d';

  if (!VALID_SINCE.test(since)) {
    res.status(400).json({ error: 'Invalid since parameter' });
    return;
  }

  let stdout = '';
  let stderr = '';

  try {
    ({ stdout, stderr } = await execFileAsync(
      'npx',
      ['ccusage', 'daily', '--since', since, '--json'],
      { timeout: 30_000 }
    ));
  } catch (err: any) {
    // execFile rejects on non-zero exit but may still have usable output
    stdout = err.stdout ?? '';
    stderr = err.stderr ?? '';
    if (!stdout.trim()) {
      res.status(500).json({ error: `ccusage failed: ${err.message ?? stderr}` });
      return;
    }
  }

  if (!stdout.trim()) {
    res.status(500).json({ error: 'ccusage returned no output' });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (parseErr: any) {
    res.status(500).json({ error: `Failed to parse ccusage output: ${parseErr.message}` });
    return;
  }

  // ccusage returns [] when there is no data for the period;
  // normalize to the object shape the client expects.
  if (Array.isArray(parsed)) {
    res.json({ daily: [], totals: null });
    return;
  }

  res.json(parsed);
});

export default router;
