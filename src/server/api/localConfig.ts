import { Router } from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';

const router = Router();

function readLocalConfig(): Record<string, unknown> {
  try {
    const raw = readFileSync(join(process.cwd(), '.local.config.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

router.get('/', (_req, res) => {
  const config = readLocalConfig();
  res.json({
    eyeEnabled: config.eyeEnabled === true,
  });
});

export default router;
