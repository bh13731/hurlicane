import { Router } from 'express';
import { randomUUID } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import type { CreateJobRequest } from '../../shared/types.js';

const router = Router();
const anthropic = new Anthropic();

const TITLE_MAX = 45;

function autoTitle(description: string): string {
  const firstLine = description.trim().split('\n')[0].trim();
  return firstLine.length > TITLE_MAX ? firstLine.slice(0, TITLE_MAX - 1) + '…' : firstLine;
}

async function generateSmartTitle(description: string): Promise<string> {
  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 30,
      messages: [{
        role: 'user',
        content: `Write a title for this task in ${TITLE_MAX} characters or fewer. Be semantic and descriptive — capture the essence, not just the first few words. Use title case. No quotes, no punctuation at the end, no explanation.\n\nTask:\n${description.slice(0, 1000)}`,
      }],
    });
    const text = message.content[0].type === 'text' ? message.content[0].text.trim() : null;
    if (text && text.length > 0) {
      return text.length > TITLE_MAX ? text.slice(0, TITLE_MAX - 1) + '…' : text;
    }
  } catch (e) {
    console.warn('[jobs] smart title generation failed, using fallback:', e);
  }
  return autoTitle(description);
}

router.post('/', async (req, res) => {
  const body = req.body as CreateJobRequest;
  if (!body.description) {
    res.status(400).json({ error: 'description is required' });
    return;
  }

  const explicitTitle = body.title?.trim();
  const title = explicitTitle || await generateSmartTitle(body.description);

  const job = queries.insertJob({
    id: randomUUID(),
    title,
    description: body.description,
    context: body.context ? JSON.stringify(body.context) : null,
    priority: body.priority ?? 0,
    work_dir: body.workDir ?? null,
    max_turns: body.maxTurns ?? 50,
    model: body.model ?? null,
    template_id: body.templateId ?? null,
    depends_on: body.dependsOn?.length ? JSON.stringify(body.dependsOn) : null,
    is_interactive: body.interactive ? 1 : 0,
    use_worktree: body.useWorktree ? 1 : 0,
    project_id: body.projectId ?? null,
  });

  socket.emitJobNew(job);
  res.status(201).json(job);
});

router.get('/', (req, res) => {
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
