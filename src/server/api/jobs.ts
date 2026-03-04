import { Router } from 'express';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import type { CreateJobRequest } from '../../shared/types.js';

const execFileAsync = promisify(execFile);

const router = Router();

const TITLE_MAX = 45;

function autoTitle(description: string): string {
  const firstLine = description.trim().split('\n')[0].trim();
  return firstLine.length > TITLE_MAX ? firstLine.slice(0, TITLE_MAX - 1) + '…' : firstLine;
}

async function generateSmartTitle(description: string): Promise<string> {
  try {
    const prompt = `Write a title for this task in ${TITLE_MAX} characters or fewer. Be semantic and descriptive — capture the essence, not just the first few words. Use title case. No quotes, no punctuation at the end, no explanation.\n\nTask:\n${description.slice(0, 1000)}`;
    const { stdout } = await execFileAsync('claude', ['-p', prompt, '--model', 'claude-haiku-4-5-20251001', '--max-turns', '1'], {
      timeout: 15_000,
    });
    const text = stdout.trim();
    if (text.length > 0) {
      return text.length > TITLE_MAX ? text.slice(0, TITLE_MAX - 1) + '…' : text;
    }
  } catch (e) {
    console.warn('[jobs] smart title generation failed, using fallback:', e);
  }
  return autoTitle(description);
}

router.post('/', async (req, res) => {
  const body = req.body as CreateJobRequest;
  if (!body.description && !body.templateId) {
    res.status(400).json({ error: 'description is required (or select a template)' });
    return;
  }
  if (!body.workDir) {
    res.status(400).json({ error: 'A working directory (workDir) is required for all jobs' });
    return;
  }

  const explicitTitle = body.title?.trim();
  let titleSource = body.description;
  const tpl = body.templateId ? queries.getTemplateById(body.templateId) : null;
  if (!titleSource && tpl) {
    titleSource = tpl.content ?? '';
  }
  const title = explicitTitle || (titleSource ? await generateSmartTitle(titleSource) : 'Untitled');

  // If template is marked readonly, force the job to be readonly regardless of request
  const isReadonly = (body.readonly || !!tpl?.is_readonly) ? 1 : 0;

  // Validate FK references exist before inserting
  const templateId = body.templateId ?? null;
  if (templateId && !queries.getTemplateById(templateId)) {
    res.status(400).json({ error: `Template '${templateId}' not found` });
    return;
  }
  const projectId = body.projectId ?? null;
  if (projectId && !queries.getProjectById(projectId)) {
    res.status(400).json({ error: `Project '${projectId}' not found` });
    return;
  }

  let job;
  try {
    job = queries.insertJob({
      id: randomUUID(),
      title,
      description: body.description ?? '',
      context: body.context ? JSON.stringify(body.context) : null,
      priority: body.priority ?? 0,
      work_dir: body.workDir ?? null,
      max_turns: body.maxTurns ?? 50,
      model: body.model ?? null,
      template_id: templateId,
      depends_on: body.dependsOn?.length ? JSON.stringify(body.dependsOn) : null,
      is_interactive: body.interactive ? 1 : 0,
      is_readonly: isReadonly,
      use_worktree: isReadonly ? 0 : (body.useWorktree ? 1 : 0),
      project_id: projectId,
      scheduled_at: body.scheduledAt ?? null,
      repeat_interval_ms: body.repeatIntervalMs ?? null,
      retry_policy: body.retryPolicy ?? 'none',
      max_retries: body.maxRetries ?? 0,
      retry_count: 0,
      original_job_id: null,
      completion_checks: body.completionChecks?.length ? JSON.stringify(body.completionChecks) : null,
    });
  } catch (err: any) {
    console.error('[jobs] insert failed:', err);
    res.status(500).json({ error: err.message ?? 'Failed to create job' });
    return;
  }

  socket.emitJobNew(job);
  res.status(201).json(job);
});

router.get('/', (req, res) => {
  if (req.query.archived === '1' || req.query.archived === 'true') {
    res.json(queries.listArchivedJobs());
    return;
  }
  const status = req.query.status as string | undefined;
  const jobs = queries.listJobs(status as any);
  res.json(jobs);
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
