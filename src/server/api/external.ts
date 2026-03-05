import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { randomUUID, randomBytes } from 'crypto';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';

const router = Router();

const NOTE_KEY = 'setting:externalApiKey';

/** Get or auto-generate the API key */
export function getOrCreateApiKey(): string {
  const existing = queries.getNote(NOTE_KEY)?.value;
  if (existing) return existing;
  const key = `hurl_${randomBytes(24).toString('hex')}`;
  queries.upsertNote(NOTE_KEY, key, null);
  return key;
}

export function getApiKey(): string {
  return getOrCreateApiKey();
}

export function regenerateApiKey(): string {
  const key = `hurl_${randomBytes(24).toString('hex')}`;
  queries.upsertNote(NOTE_KEY, key, null);
  return key;
}

/** Middleware: validate X-API-Key header */
function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const provided = req.headers['x-api-key'];
  if (!provided || provided !== getApiKey()) {
    res.status(401).json({ error: 'Invalid or missing X-API-Key header' });
    return;
  }
  next();
}

router.use(apiKeyAuth);

// ─── POST /api/ext/jobs — create a job with simplified inputs ─────────────

router.post('/jobs', async (req, res) => {
  const { description, title, repo, branch, model, templateId, priority, interactive, readonly, context } = req.body;

  if (!description && !templateId) {
    res.status(400).json({ error: 'description is required (or provide templateId)' });
    return;
  }

  // Resolve working directory from repo/branch
  let workDir: string | undefined;

  if (branch && repo) {
    // Find the repo by name
    const repoObj = queries.getRepoByName(repo);
    if (!repoObj) {
      res.status(400).json({ error: `Repo "${repo}" not found` });
      return;
    }

    // Check for existing worktree with this branch
    const existingWt = queries.getWorktreeByBranch(branch);
    if (existingWt) {
      workDir = existingWt.path;
    } else {
      // Create a new worktree via the worktrees API logic
      try {
        const wtRes = await fetch(`http://localhost:${process.env.PORT ?? 3000}/api/worktrees`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ branch, repoId: repoObj.id }),
        });
        if (!wtRes.ok) {
          const err: any = await wtRes.json().catch(() => ({}));
          res.status(500).json({ error: err.error || 'Failed to create worktree' });
          return;
        }
        const wt: any = await wtRes.json();
        workDir = wt.path;
      } catch (err: any) {
        res.status(500).json({ error: err.message || 'Failed to create worktree' });
        return;
      }
    }
  } else if (repo) {
    // Just use the repo path directly
    const repoObj = queries.getRepoByName(repo);
    if (!repoObj) {
      res.status(400).json({ error: `Repo "${repo}" not found` });
      return;
    }
    workDir = repoObj.path;
  } else {
    // Use first repo's path as default
    const repos = queries.listRepos();
    if (repos.length > 0) {
      workDir = repos[0].path;
    }
  }

  if (!workDir) {
    res.status(400).json({ error: 'Could not resolve a working directory. Register a repo first or provide repo/branch.' });
    return;
  }

  // Resolve template
  const tpl = templateId ? queries.getTemplateById(templateId) : null;
  const jobTitle = title || (description ? description.trim().split('\n')[0].slice(0, 45) : 'Untitled');

  try {
    const job = queries.insertJob({
      id: randomUUID(),
      title: jobTitle,
      description: description ?? '',
      context: context ? JSON.stringify(context) : null,
      priority: priority ?? 0,
      work_dir: workDir,
      max_turns: 50,
      model: model ?? null,
      template_id: templateId ?? null,
      depends_on: null,
      is_interactive: interactive ? 1 : 0,
      is_readonly: (readonly || !!tpl?.is_readonly) ? 1 : 0,
      use_worktree: 1,
      project_id: null,
      scheduled_at: null,
      repeat_interval_ms: null,
      retry_policy: 'none',
      max_retries: 0,
      retry_count: 0,
      original_job_id: null,
      completion_checks: null,
    });

    socket.emitJobNew(job);
    res.status(201).json(job);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to create job' });
  }
});

// ─── GET /api/ext/jobs — list jobs ────────────────────────────────────────

router.get('/jobs', (_req, res) => {
  res.json(queries.listJobs());
});

// ─── GET /api/ext/jobs/:id — get a job ────────────────────────────────────

router.get('/jobs/:id', (req, res) => {
  const job = queries.getJobById(req.params.id);
  if (!job) { res.status(404).json({ error: 'not found' }); return; }
  res.json(job);
});

// ─── GET /api/ext/agents — list agents ────────────────────────────────────

router.get('/agents', (_req, res) => {
  res.json(queries.getAgentsWithJob());
});

// ─── GET /api/ext/repos — list repos ──────────────────────────────────────

router.get('/repos', (_req, res) => {
  res.json(queries.listRepos());
});

// ─── GET /api/ext/templates — list templates ──────────────────────────────

router.get('/templates', (_req, res) => {
  res.json(queries.listTemplates());
});

export default router;
