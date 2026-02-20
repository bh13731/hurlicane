import { randomUUID } from 'crypto';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import type { FileLock } from '../../shared/types.js';

export interface AcquireResult {
  success: boolean;
  acquired: string[];
  blocked: Array<{ file: string; held_by: string; expires_at: number }>;
  timed_out?: boolean;
}

let _instance: FileLockRegistry | null = null;

export function getFileLockRegistry(): FileLockRegistry {
  if (!_instance) _instance = new FileLockRegistry();
  return _instance;
}

class FileLockRegistry {
  // Each entry is a callback that wakes a single waiter to re-check.
  private waiters = new Set<() => void>();

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
          blocked.push({ file, held_by: lock.agent_id, expires_at: lock.expires_at });
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
   * Blocking acquire. Waits until all requested files are free, then grabs
   * them all at once (all-or-nothing). If timeoutMs elapses before the locks
   * become available, returns { success: false, timed_out: true }.
   *
   * Deadlock scenario: Agent A holds file1 and waits for file2; Agent B holds
   * file2 and waits for file1. The timeout is the escape valve — after
   * timeoutMs one or both agents give up and release, unblocking the other.
   */
  async acquire(
    agentId: string,
    files: string[],
    reason: string | null,
    ttlMs: number,
    timeoutMs: number,
  ): Promise<AcquireResult> {
    const deadline = Date.now() + timeoutMs;

    while (true) {
      const result = this.tryAcquireOnce(agentId, files, reason, ttlMs);
      if (result) return result;

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        // Re-check one more time — a release may have just happened
        const last = this.tryAcquireOnce(agentId, files, reason, ttlMs);
        if (last) return last;

        const blocked: AcquireResult['blocked'] = [];
        for (const file of files) {
          for (const lock of queries.getActiveLocksForFile(file)) {
            if (lock.agent_id !== agentId) {
              blocked.push({ file, held_by: lock.agent_id, expires_at: lock.expires_at });
            }
          }
        }
        return { success: false, acquired: [], blocked, timed_out: true };
      }

      // Wait for any release event (or TTL expiry, whichever comes first)
      await this.waitForRelease(Math.min(remaining, ttlMs));
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
