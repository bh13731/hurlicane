import type { Job, JobStatus } from '../../shared/types.js';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';

const TERMINAL_JOB_STATUSES = new Set<JobStatus>(['done', 'failed', 'cancelled']);

export function isTerminalJobStatus(status: JobStatus | null | undefined): boolean {
  return status != null && TERMINAL_JOB_STATUSES.has(status);
}

export function getJobIfStatus(jobId: string, statuses: readonly JobStatus[]): Job | null {
  const current = queries.getJobById(jobId);
  if (!current) return null;
  return statuses.includes(current.status) ? current : null;
}

/**
 * Promote a claimed job into the live execution state once its agent is
 * actually running. Repeated calls are harmless.
 */
export function markJobRunning(jobId: string): Job | null {
  const current = queries.getJobById(jobId);
  if (!current) return null;
  if (current.status === 'running') return current;
  if (current.status !== 'assigned') return current;

  queries.updateJobStatus(jobId, 'running');
  const updated = queries.getJobById(jobId);
  if (updated) socket.emitJobUpdate(updated);
  return updated;
}
