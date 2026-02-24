import { randomUUID } from 'crypto';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import type { FileLock } from '../../shared/types.js';

export interface AcquireResult {
  success: boolean;
  acquired: string[];
  blocked: Array<{ file: string; held_by: string; expires_at: number; held_by_status: string | null; lock_reason: string | null }>;
  timed_out?: boolean;
  deadlock_detected?: boolean;
}

// Max sleep per waitForRelease cycle — short so missed notifications don't
// cause multi-minute stalls. We rely on the deadline check in acquire() to
// honour the caller's timeout_ms accurately.
const MAX_WAIT_CYCLE_MS = 5_000;

let _instance: FileLockRegistry | null = null;

export function getFileLockRegistry(): FileLockRegistry {
  if (!_instance) _instance = new FileLockRegistry();
  return _instance;
}

class FileLockRegistry {
  // Each entry is a callback that wakes a single waiter to re-check.
  private waiters = new Set<() => void>();

  // Tracks which files each agent is currently blocked waiting to acquire.
  // Used for deadlock (cycle) detection in the wait-for graph.
  private waitingFor = new Map<string, string[]>();

  constructor() {
    // Heartbeat: periodically wake all waiters so a missed release notification
    // doesn't cause indefinite stalls. The cycle cap (MAX_WAIT_CYCLE_MS) is the
    // real guard, but this catches any edge cases where notifyWaiters() was never
    // called (e.g. lock expired via TTL rather than explicit release).
    setInterval(() => this.notifyWaiters(), 2_000).unref();
  }

  // Attempt a single non-blocking acquire. Returns null if any file is blocked.
  private tryAcquireOnce(
    agentId: string,
    files: string[],
    reason: string | null,
    ttlMs: number,
  ): AcquireResult | null {
    const blocked: AcquireResult['blocked'] = [];
    for (const file of files) {
      for (const lock of queries.getActiveLocksForFile(file)) {
        if (lock.agent_id !== agentId) {
          const holder = queries.getAgentById(lock.agent_id);
          blocked.push({
            file,
            held_by: lock.agent_id,
            expires_at: lock.expires_at,
            held_by_status: holder?.status_message ?? null,
            lock_reason: lock.reason ?? null,
          });
        }
      }
    }

    if (blocked.length > 0) return null;

    // All clear — insert all locks atomically
    const now = Date.now();
    const acquired: string[] = [];
    for (const file of files) {
      const lock: FileLock = {
        id: randomUUID(),
        agent_id: agentId,
        file_path: file,
        reason,
        acquired_at: now,
        expires_at: now + ttlMs,
        released_at: null,
      };
      queries.insertFileLock(lock);
      socket.emitLockAcquired(lock);
      acquired.push(file);
    }

    return { success: true, acquired, blocked: [] };
  }

  /**
   * Build the blocked-by list for the given agent and files (used in failure results).
   */
  private buildBlockedList(agentId: string, files: string[]): AcquireResult['blocked'] {
    const blocked: AcquireResult['blocked'] = [];
    for (const file of files) {
      for (const lock of queries.getActiveLocksForFile(file)) {
        if (lock.agent_id !== agentId) {
          const holder = queries.getAgentById(lock.agent_id);
          blocked.push({
            file,
            held_by: lock.agent_id,
            expires_at: lock.expires_at,
            held_by_status: holder?.status_message ?? null,
            lock_reason: lock.reason ?? null,
          });
        }
      }
    }
    return blocked;
  }

  /**
   * Detect whether registering agentId as waiting for its files (already set in
   * this.waitingFor) would create a cycle in the wait-for graph.
   *
   * Wait-for graph: edge A → B means "A is blocked waiting for a file held by B".
   * A deadlock exists when there is a cycle: A → B → ... → A.
   *
   * Algorithm: DFS from each current holder of the files agentId wants.
   * If any DFS path reaches agentId, we have a cycle.
   */
  private detectDeadlock(agentId: string): boolean {
    const myFiles = this.waitingFor.get(agentId);
    if (!myFiles || myFiles.length === 0) return false;

    const visited = new Set<string>();

    // Returns true if we can reach agentId by following wait-for edges from `current`.
    const canReachSelf = (current: string): boolean => {
      if (current === agentId) return true;
      if (visited.has(current)) return false;
      visited.add(current);

      const waiting = this.waitingFor.get(current);
      if (!waiting) return false;

      for (const file of waiting) {
        for (const lock of queries.getActiveLocksForFile(file)) {
          if (lock.agent_id !== current && canReachSelf(lock.agent_id)) {
            return true;
          }
        }
      }
      return false;
    };

    // Start DFS from each holder of the files agentId is blocked on.
    for (const file of myFiles) {
      for (const lock of queries.getActiveLocksForFile(file)) {
        if (lock.agent_id !== agentId && canReachSelf(lock.agent_id)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Blocking acquire. Waits until all requested files are free, then grabs
   * them all at once (all-or-nothing). If timeoutMs elapses before the locks
   * become available, returns { success: false, timed_out: true }.
   *
   * Deadlock detection: before each sleep cycle the registry checks for a cycle
   * in the wait-for graph. If Agent A holds file1 and waits for file2 while
   * Agent B holds file2 and waits for file1, the cycle is detected immediately
   * and the waiting agent receives { success: false, deadlock_detected: true }
   * so it can release its current locks and retry rather than hanging for the
   * full timeout duration.
   */
  async acquire(
    agentId: string,
    files: string[],
    reason: string | null,
    ttlMs: number,
    timeoutMs: number,
  ): Promise<AcquireResult> {
    const deadline = Date.now() + timeoutMs;

    try {
      while (true) {
        const result = this.tryAcquireOnce(agentId, files, reason, ttlMs);
        if (result) return result;

        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          // Re-check one more time — a release may have just happened
          const last = this.tryAcquireOnce(agentId, files, reason, ttlMs);
          if (last) return last;

          return { success: false, acquired: [], blocked: this.buildBlockedList(agentId, files), timed_out: true };
        }

        // Register this agent as waiting for these files so other agents'
        // deadlock checks can traverse through us.
        this.waitingFor.set(agentId, files);

        // Check for a cycle in the wait-for graph. If detected, fail immediately
        // so this agent can release its held locks and retry, avoiding a multi-
        // minute hang.
        if (this.detectDeadlock(agentId)) {
          return {
            success: false,
            acquired: [],
            blocked: this.buildBlockedList(agentId, files),
            deadlock_detected: true,
          };
        }

        // Wait for any release event (or at most MAX_WAIT_CYCLE_MS, whichever comes
        // first). The short cap means a missed notifyWaiters() causes at most a
        // 5-second delay rather than a multi-minute stall.
        await this.waitForRelease(Math.min(remaining, MAX_WAIT_CYCLE_MS));
      }
    } finally {
      // Always clean up our wait-for registration, whether we succeeded,
      // timed out, or detected a deadlock.
      this.waitingFor.delete(agentId);
    }
  }

  private waitForRelease(maxWaitMs: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          this.waiters.delete(wake);
          resolve();
        }
      }, maxWaitMs);

      const wake = () => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        }
      };

      this.waiters.add(wake);
    });
  }

  private notifyWaiters(): void {
    // Wake all waiters so each re-checks; they will re-sleep if still blocked.
    for (const wake of this.waiters) wake();
  }

  release(agentId: string, files: string[]): string[] {
    const released: string[] = [];
    for (const file of files) {
      for (const lock of queries.getActiveLocksForFile(file)) {
        if (lock.agent_id === agentId) {
          queries.releaseLock(lock.id);
          socket.emitLockReleased(lock.id, lock.file_path);
          released.push(file);
        }
      }
    }
    if (released.length > 0) this.notifyWaiters();
    return released;
  }

  releaseAll(agentId: string): void {
    // Use getAllUnreleasedLocksForAgent (no TTL filter) so that locks whose TTL
    // has already expired still get released and emit lock:released events.
    // Without this, expired locks accumulate in the UI forever.
    const locks = queries.getAllUnreleasedLocksForAgent(agentId);
    for (const lock of locks) {
      queries.releaseLock(lock.id);
      socket.emitLockReleased(lock.id, lock.file_path);
    }
    if (locks.length > 0) this.notifyWaiters();
  }
}
