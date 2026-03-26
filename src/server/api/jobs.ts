import { Router } from 'express';
import { randomUUID } from 'crypto';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import type { CreateJobRequest } from '../../shared/types.js';

const router = Router();

const TITLE_MAX = 45;

function autoTitle(description: string): string {
  const firstLine = description.trim().split('\n')[0].trim();
  return firstLine.length > TITLE_MAX ? firstLine.slice(0, TITLE_MAX - 1) + '…' : firstLine;
}

async function generateSmartTitle(description: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return autoTitle(description);

  try {
    const prompt = `Write a title for this task in ${TITLE_MAX} characters or fewer. Be semantic and descriptive — capture the essence, not just the first few words. Use title case. No quotes, no punctuation at the end, no explanation.\n\nTask:\n${description.slice(0, 1000)}`;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 60,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json() as any;
    const text = (data.content?.[0]?.text ?? '').trim();
    if (text.length > 0) {
      return text.length > TITLE_MAX ? text.slice(0, TITLE_MAX - 1) + '…' : text;
    }
  } catch (e) {
    console.warn('[jobs] smart title generation failed, using fallback:', (e as Error).message ?? e);
  }
  return autoTitle(description);
}

router.post('/', async (req, res) => {
  const body = req.body as CreateJobRequest;
  if (!body.description && !body.templateId) {
    res.status(400).json({ error: 'description is required (or select a template)' });
    return;
  }
  const tpl = body.templateId ? queries.getTemplateById(body.templateId) : null;
  const isReadonly = (body.readonly || !!tpl?.is_readonly) ? 1 : 0;
  const repoId = body.repoId ?? tpl?.repo_id ?? null;
  if (!repoId && !isReadonly) {
    res.status(400).json({ error: 'A repository (repoId) is required for non-readonly jobs' });
    return;
  }

  const explicitTitle = body.title?.trim();
  let titleSource = body.description;
  if (!titleSource && tpl) {
    titleSource = tpl.content ?? '';
  }
  const title = explicitTitle || (titleSource ? await generateSmartTitle(titleSource) : 'Untitled');

  // Validate FK references exist before inserting
  const templateId = body.templateId ?? null;
  if (templateId && !queries.getTemplateById(templateId)) {
    res.status(400).json({ error: `Template '${templateId}' not found` });
    return;
  }
  const projectId = body.projectId ?? tpl?.project_id ?? null;
  if (projectId && !queries.getProjectById(projectId)) {
    res.status(400).json({ error: `Project '${projectId}' not found` });
    return;
  }

  // Merge context: template context as base, request context overrides
  let mergedContext: string | null = null;
  if (tpl?.context || body.context) {
    const tplCtx = tpl?.context ? JSON.parse(tpl.context) : {};
    const merged = { ...tplCtx, ...body.context };
    if (Object.keys(merged).length > 0) mergedContext = JSON.stringify(merged);
  }

  let job;
  try {
    job = queries.insertJob({
      id: randomUUID(),
      title,
      description: body.description ?? '',
      context: mergedContext,
      priority: body.priority ?? tpl?.priority ?? 0,
      repo_id: repoId,
      branch: body.branch ?? null,
      max_turns: body.maxTurns ?? 50,
      model: body.model ?? tpl?.model ?? null,
      template_id: templateId,
      depends_on: body.dependsOn?.length ? JSON.stringify(body.dependsOn) : null,
      is_interactive: body.interactive !== undefined ? (body.interactive ? 1 : 0) : (tpl?.is_interactive ?? 0),
      is_readonly: isReadonly,
      project_id: projectId,
      scheduled_at: body.scheduledAt ?? null,
      repeat_interval_ms: body.repeatIntervalMs ?? null,
      retry_policy: body.retryPolicy ?? tpl?.retry_policy ?? 'none',
      max_retries: body.maxRetries ?? tpl?.max_retries ?? 0,
      retry_count: 0,
      original_job_id: null,
      completion_checks: body.completionChecks?.length
        ? JSON.stringify(body.completionChecks)
        : tpl?.completion_checks ?? null,
    });
  } catch (err: any) {
    console.error('[jobs] insert failed:', err);
    res.status(500).json({ error: err.message ?? 'Failed to create job' });
    return;
  }

  socket.emitJobNew(job);
  res.status(201).json(job);
});

// Short-TTL cache for jobs listing
let jobsCache: { data: any; expires: number } | null = null;
const JOBS_CACHE_TTL = 1500; // 1.5s

router.get('/', (req, res) => {
  if (req.query.archived === '1' || req.query.archived === 'true') {
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const offset = req.query.offset ? Number(req.query.offset) : undefined;
    res.json(queries.listArchivedJobsSlim(limit, offset));
    return;
  }
  const status = req.query.status as string | undefined;
  if (!status) {
    const now = Date.now();
    if (jobsCache && now < jobsCache.expires) {
      res.json(jobsCache.data);
      return;
    }
    const data = queries.listJobsSlim();
    jobsCache = { data, expires: now + JOBS_CACHE_TTL };
    res.json(data);
  } else {
    res.json(queries.listJobs(status as any));
  }
});

router.get('/:id', (req, res) => {
  const job = queries.getJobById(req.params.id);
  if (!job) { res.status(404).json({ error: 'not found' }); return; }
  res.json(job);
});

router.post('/:id/flag', (req, res) => {
  const job = queries.getJobById(req.params.id);
  if (!job) { res.status(404).json({ error: 'not found' }); return; }
  queries.updateJobFlagged(job.id, job.flagged ? 0 : 1);
  const updated = queries.getJobById(job.id)!;
  socket.emitJobUpdate(updated);
  // Update all agents for this job so their embedded job reflects the new flag state
  const agents = queries.getAgentsWithJobByJobId(job.id);
  for (const agent of agents) {
    socket.emitAgentUpdate(agent);
  }
  res.json(updated);
});

router.patch('/:id/title', (req, res) => {
  const job = queries.getJobById(req.params.id);
  if (!job) { res.status(404).json({ error: 'not found' }); return; }
  const title = req.body?.title?.trim();
  if (!title) { res.status(400).json({ error: 'title required' }); return; }
  queries.updateJobTitle(job.id, title);
  const updated = queries.getJobById(job.id)!;
  socket.emitJobUpdate(updated);
  const agents = queries.getAgentsWithJobByJobId(job.id);
  for (const agent of agents) {
    socket.emitAgentUpdate(agent);
  }
  res.json(updated);
});

router.post('/:id/run-now', (req, res) => {
  const job = queries.getJobById(req.params.id);
  if (!job) { res.status(404).json({ error: 'not found' }); return; }
  if (job.status !== 'queued') {
    res.status(400).json({ error: 'Can only run-now queued jobs' });
    return;
  }
  queries.updateJobScheduledAt(job.id, null);
  const updated = queries.getJobById(job.id)!;
  socket.emitJobUpdate(updated);
  res.json(updated);
});

router.patch('/:id/interactive', (req, res) => {
  const job = queries.getJobById(req.params.id);
  if (!job) { res.status(404).json({ error: 'not found' }); return; }
  const interactive = req.body?.interactive ? 1 : 0;
  queries.updateJobInteractive(job.id, interactive);
  const updated = queries.getJobById(job.id)!;
  socket.emitJobUpdate(updated);
  const agents = queries.getAgentsWithJobByJobId(job.id);
  for (const agent of agents) {
    socket.emitAgentUpdate(agent);
  }
  res.json(updated);
});

router.post('/:id/archive', (req, res) => {
  const job = queries.getJobById(req.params.id);
  if (!job) { res.status(404).json({ error: 'not found' }); return; }
  if (!['done', 'failed', 'cancelled'].includes(job.status)) {
    res.status(400).json({ error: 'Can only archive finished jobs (done, failed, cancelled)' });
    return;
  }
  queries.archiveJob(job.id);
  const updated = queries.getJobById(job.id)!;
  socket.emitJobUpdate(updated);
  res.json(updated);
});

router.delete('/:id', (req, res) => {
  const job = queries.getJobById(req.params.id);
  if (!job) { res.status(404).json({ error: 'not found' }); return; }
  if (job.status !== 'queued') {
    res.status(400).json({ error: 'Can only cancel queued jobs' });
    return;
  }
  queries.updateJobStatus(job.id, 'cancelled');
  const updated = queries.getJobById(job.id)!;
  socket.emitJobUpdate(updated);
  res.json(updated);
});

export default router;
