import type { Job } from '../../shared/types.js';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';

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
