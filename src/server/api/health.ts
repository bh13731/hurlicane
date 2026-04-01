/**
 * Health check endpoint — reports system status for monitoring and alerting.
 *
 * GET /api/health returns:
 * - status: "ok" | "degraded" | "unhealthy"
 * - db: database connectivity check
 * - queue: active/queued job counts
 * - agents: running agent count
 * - disk: available disk space (MB)
 * - memory: orchestrator RSS (MB)
 * - uptime: process uptime in seconds
 */

import { Router } from 'express';
import { execFileSync } from 'child_process';
import * as path from 'path';
import { getDb } from '../db/database.js';
import * as queries from '../db/queries.js';

const router = Router();

router.get('/', (_req, res) => {
  const checks: Record<string, any> = {};
  let status: 'ok' | 'degraded' | 'unhealthy' = 'ok';

  // DB check
  try {
    const db = getDb();
    db.prepare('SELECT 1').get();
    checks.db = { status: 'ok' };
  } catch (err: any) {
    checks.db = { status: 'unhealthy', error: err.message };
    status = 'unhealthy';
  }

  // Queue stats
  try {
    const allJobs = queries.listJobs();
    const queued = allJobs.filter(j => j.status === 'queued').length;
    const assigned = allJobs.filter(j => j.status === 'assigned').length;
    const running = allJobs.filter(j => j.status === 'running').length;
    checks.queue = { queued, assigned, running };
  } catch (err: any) {
    checks.queue = { status: 'error', error: err.message };
  }

  // Active agents
  try {
    const agents = queries.listAllRunningAgents();
    checks.agents = { running: agents.length };
  } catch (err: any) {
    checks.agents = { status: 'error', error: err.message };
  }

  // Active file locks
  try {
    const locks = queries.getAllActiveLocks();
    checks.locks = { active: locks.length };
  } catch (err: any) {
    checks.locks = { status: 'error', error: err.message };
  }

  // Disk space
  try {
    const dataDir = path.join(process.cwd(), 'data');
    const output = execFileSync('df', ['-m', dataDir], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = output.trim().split('\n');
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/);
      const availMb = parseInt(parts[3], 10);
      if (!isNaN(availMb)) {
        checks.disk = { available_mb: availMb };
        if (availMb < 100) {
          status = 'unhealthy';
          checks.disk.warning = 'critically low disk space';
        } else if (availMb < 500) {
          if (status === 'ok') status = 'degraded';
          checks.disk.warning = 'low disk space';
        }
      }
    }
  } catch {
    checks.disk = { status: 'unavailable' };
  }

  // Memory
  const rssMb = Math.round(process.memoryUsage.rss() / (1024 * 1024));
  checks.memory = { rss_mb: rssMb };
  if (rssMb > 1024) {
    if (status === 'ok') status = 'degraded';
    checks.memory.warning = 'high memory usage';
  }

  // Uptime
  checks.uptime_seconds = Math.round(process.uptime());

  const httpStatus = status === 'unhealthy' ? 503 : 200;
  res.status(httpStatus).json({ status, checks });
});

export default router;
