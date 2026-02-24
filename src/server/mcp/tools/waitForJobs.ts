import { z } from 'zod';
import * as queries from '../../db/queries.js';
import * as socket from '../../socket/SocketManager.js';
import type { JobStatus } from '../../../shared/types.js';

export const waitForJobsSchema = z.object({
  job_ids: z.array(z.string()).describe('Job IDs to wait for'),
  timeout_ms: z.number().optional().describe('Max wait time in ms (default: 1800000 = 30 min)'),
});

const TERMINAL: JobStatus[] = ['done', 'failed', 'cancelled'];
const POLL_MS = 2000;

// Called periodically to keep the MCP SSE stream alive during long waits.
// Without this, Node.js's keepAliveTimeout (5s default) closes the idle SSE
// connection before the tool returns, silently dropping the result.
type Keepalive = () => Promise<void>;

const KEEPALIVE_INTERVAL_MS = 5_000;

export async function waitForJobsHandler(
  agentId: string,
  input: z.infer<typeof waitForJobsSchema>,
  keepalive?: Keepalive,
): Promise<string> {
  const { job_ids, timeout_ms = 1800000 } = input;

  if (job_ids.length === 0) {
    return JSON.stringify({ error: 'job_ids must not be empty' });
  }

  const deadline = Date.now() + timeout_ms;

  // Update status message while waiting
  const updateStatus = (pending: number) => {
    const msg = `Waiting for ${pending} sub-job${pending !== 1 ? 's' : ''} to complete…`;
    queries.updateAgent(agentId, { status_message: msg });
    const agentWithJob = queries.getAgentWithJob(agentId);
    if (agentWithJob) socket.emitAgentUpdate(agentWithJob);
  };

  updateStatus(job_ids.length);
  let lastReportedPending = job_ids.length;
  let lastKeepalive = Date.now();

  while (Date.now() < deadline) {
    const jobs = job_ids.map(id => queries.getJobById(id));
    const missing = job_ids.filter((_, i) => !jobs[i]);
    if (missing.length > 0) {
      return JSON.stringify({ error: `Unknown job IDs: ${missing.join(', ')}` });
    }

    const pending = jobs.filter(j => !TERMINAL.includes(j!.status));
    if (pending.length === 0) {
      // All done — clear status and build results
      queries.updateAgent(agentId, { status_message: null });
      const agentWithJob = queries.getAgentWithJob(agentId);
      if (agentWithJob) socket.emitAgentUpdate(agentWithJob);

      const results = jobs.map(j => {
        const job = j!;
        // Get the most recent agent for this job
        const agents = queries.getAgentsWithJobByJobId(job.id);
        const latestAgent = agents[0] ?? null;
        return {
          job_id: job.id,
          title: job.title,
          status: job.status,
          result_text: latestAgent ? queries.getAgentResultText(latestAgent.id) : null,
          // Omit diff — it can be hundreds of KB per job, and a multi-job
          // wait can produce a multi-MB SSE event that causes delivery failures.
          // Agents that need the diff can query the job directly.
        };
      });

      return JSON.stringify(results);
    }

    // Only emit a status update when the pending count changes — avoids hammering
    // SQLite + Socket.IO on every 2-second tick when nothing has changed.
    if (pending.length !== lastReportedPending) {
      updateStatus(pending.length);
      lastReportedPending = pending.length;
    }

    // Periodically send a keepalive notification to prevent Node.js's
    // keepAliveTimeout from closing the idle SSE connection before we return.
    const now = Date.now();
    if (keepalive && now - lastKeepalive >= KEEPALIVE_INTERVAL_MS) {
      await keepalive().catch(() => {/* ignore — connection may have closed */});
      lastKeepalive = now;
    }

    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }

  // Timed out
  queries.updateAgent(agentId, { status_message: null });
  const agentWithJob = queries.getAgentWithJob(agentId);
  if (agentWithJob) socket.emitAgentUpdate(agentWithJob);

  const jobs = job_ids.map(id => queries.getJobById(id));
  const timedOut = jobs
    .filter(j => j && !TERMINAL.includes(j.status))
    .map(j => j!.id);

  return JSON.stringify({
    error: `Timed out after ${timeout_ms}ms`,
    still_pending: timedOut,
  });
}
