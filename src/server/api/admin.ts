import { Router } from 'express';
import { spawn } from 'child_process';
import path from 'path';

const router = Router();

router.post('/restart', (_req, res) => {
  const script = path.resolve('scripts', 'restart-ec2.sh');

  // Respond immediately before the server dies
  res.json({ ok: true, message: 'Restart initiated' });

  // Spawn detached so it survives this process being killed
  const child = spawn('bash', [script], {
    detached: true,
    stdio: 'ignore',
    cwd: path.resolve('.'),
  });
  child.unref();
});

export default router;
