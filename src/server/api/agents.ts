import { Router } from 'express';
import { randomUUID } from 'crypto';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { runAgent, cancelledAgents } from '../orchestrator/AgentRunner.js';
import { disconnectAgent, disconnectAll, getPtyBuffer } from '../orchestrator/PtyManager.js';
import { getFileLockRegistry } from '../orchestrator/FileLockRegistry.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json(queries.getAgentsWithJob());
});

// Must be registered before /:id to avoid param capture
router.delete('/disconnect-all', (_req, res) => {
  const agentIds = disconnectAll();
  let count = 0;
  for (const agentId of agentIds) {
    const agent = queries.getAgentById(agentId);
    if (!agent) continue;
    queries.updateAgent(agentId, { status: 'done', finished_at: Date.now() });
    queries.updateJobStatus(agent.job_id, 'done');
    const updated = queries.getAgentWithJob(agentId);
    if (updated) socket.emitAgentUpdate(updated);
    count++;
  }
  res.json({ disconnected: count });
});

router.get('/:id', (req, res) => {
  const agent = queries.getAgentWithJob(req.params.id);
  if (!agent) { res.status(404).json({ error: 'not found' }); return; }
  res.json(agent);
});

router.get('/:id/output', (req, res) => {
  const agent = queries.getAgentById(req.params.id);
  if (!agent) { res.status(404).json({ error: 'not found' }); return; }
  res.json(queries.getAgentOutput(req.params.id));
});

router.get('/:id/full-output', (req, res) => {
  const agent = queries.getAgentById(req.params.id);
  if (!agent) { res.status(404).json({ error: 'not found' }); return; }
  res.json(queries.getAgentFullOutput(req.params.id));
});

router.get('/:id/pty-history', (req, res) => {
  const agent = queries.getAgentById(req.params.id);
  if (!agent) { res.status(404).json({ error: 'not found' }); return; }
  res.json({ chunks: getPtyBuffer(req.params.id) });
});

router.get('/:id/diff', (req, res) => {
  const agent = queries.getAgentById(req.params.id);
  if (!agent) { res.status(404).json({ error: 'not found' }); return; }
  res.json({
    diff: (agent as any).diff ?? null,
    base_sha: (agent as any).base_sha ?? null,
  });
});

router.post('/:id/read', (req, res) => {
  const agent = queries.getAgentById(req.params.id);
  if (!agent) { res.status(404).json({ error: 'not found' }); return; }
  queries.updateAgent(req.params.id, { output_read: 1 });
  const updated = queries.getAgentWithJob(req.params.id)!;
  socket.emitAgentUpdate(updated);
  res.json(updated);
});

router.post('/:id/retry', (req, res) => {
  const agent = queries.getAgentById(req.params.id);
  if (!agent) { res.status(404).json({ error: 'not found' }); return; }
  if (agent.status !== 'failed') { res.status(400).json({ error: 'Only failed agents can be retried' }); return; }

  const original = queries.getAgentWithJob(req.params.id)!;
  const originalJob = original.job as any;

  const retryJob = queries.insertJob({
    id: randomUUID(),
    title: `↺ ${original.job.title}`,
    description: originalJob.description,
    context: originalJob.context ?? null,
    priority: original.job.priority,
    status: 'running',
    work_dir: originalJob.work_dir ?? null,
    max_turns: originalJob.max_turns ?? 50,
    model: original.job.model,
    template_id: originalJob.template_id ?? null,
  });
  socket.emitJobNew(retryJob);

  const agentId = randomUUID();
  queries.insertAgent({ id: agentId, job_id: retryJob.id, status: 'starting' });
  const newAgent = queries.getAgentWithJob(agentId)!;
  socket.emitAgentNew(newAgent);

  runAgent({ agentId, job: retryJob });

  res.status(201).json(queries.getAgentWithJob(agentId));
});

router.post('/:id/continue', (req, res) => {
  const agent = queries.getAgentById(req.params.id);
  if (!agent) { res.status(404).json({ error: 'not found' }); return; }
  if (!agent.session_id) { res.status(400).json({ error: 'Agent has no session to resume' }); return; }

  const { message } = req.body as { message?: string };
  if (!message?.trim()) { res.status(400).json({ error: 'message is required' }); return; }

  const original = queries.getAgentWithJob(req.params.id)!;
  const originalJob = original.job as any;

  // Create a continuation job, marked running immediately to bypass the work queue
  const contJob = queries.insertJob({
    id: randomUUID(),
    title: `↩ ${original.job.title}`,
    description: message.trim(),
    context: originalJob.context ?? null,
    priority: original.job.priority,
    status: 'running',
    work_dir: originalJob.work_dir ?? null,
    max_turns: originalJob.max_turns ?? 50,
    model: original.job.model,
    template_id: originalJob.template_id ?? null,
  });
  socket.emitJobNew(contJob);

  const agentId = randomUUID();
  queries.insertAgent({ id: agentId, job_id: contJob.id, status: 'starting', parent_agent_id: req.params.id });
  const newAgent = queries.getAgentWithJob(agentId)!;
  socket.emitAgentNew(newAgent);

  runAgent({ agentId, job: contJob, resumeSessionId: agent.session_id });

  res.status(201).json(queries.getAgentWithJob(agentId));
});

router.post('/:id/cancel', (req, res) => {
  const agent = queries.getAgentById(req.params.id);
  if (!agent) { res.status(404).json({ error: 'not found' }); return; }

  const cancellable: string[] = ['starting', 'running', 'waiting_user'];
  if (!cancellable.includes(agent.status)) {
    res.status(400).json({ error: 'Agent is not running' }); return;
  }

  // Mark cancelled before killing so handleAgentExit won't overwrite the status
  cancelledAgents.add(agent.id);

  if (agent.pid) {
    try {
      process.kill(-agent.pid, 'SIGTERM');
    } catch (err: any) {
      if (err.code !== 'ESRCH') {
        cancelledAgents.delete(agent.id);
        res.status(500).json({ error: 'Failed to kill process' }); return;
      }
      // ESRCH = process already gone — still mark as cancelled
    }
  }

  // Update DB immediately so the UI reflects the change right away
  queries.updateAgent(agent.id, { status: 'cancelled', finished_at: Date.now() });
  queries.updateJobStatus(agent.job_id, 'cancelled');
  getFileLockRegistry().releaseAll(agent.id);

  const updated = queries.getAgentWithJob(agent.id)!;
  socket.emitAgentUpdate(updated);
  const updatedJob = queries.getJobById(agent.job_id);
  if (updatedJob) socket.emitJobUpdate(updatedJob);

  res.json(updated);
});

router.delete('/:id/disconnect', (req, res) => {
  const agent = queries.getAgentById(req.params.id);
  if (!agent) { res.status(404).json({ error: 'not found' }); return; }

  disconnectAgent(req.params.id);
  queries.updateAgent(req.params.id, { status: 'done', finished_at: Date.now() });
  queries.updateJobStatus(agent.job_id, 'done');

  const updated = queries.getAgentWithJob(req.params.id)!;
  socket.emitAgentUpdate(updated);
  const updatedJob = queries.getJobById(agent.job_id);
  if (updatedJob) socket.emitJobUpdate(updatedJob);
  res.json(updated);
});

export default router;
