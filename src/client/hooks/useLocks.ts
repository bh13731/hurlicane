import { useState, useCallback, useEffect } from 'react';
import type { FileLock } from '@shared/types';

export function useLocks() {
  const [locks, setLocks] = useState<FileLock[]>([]);

  const setInitial = useCallback((initial: FileLock[]) => {
    setLocks(initial);
  }, []);

  const addLock = useCallback((lock: FileLock) => {
    setLocks(prev => [...prev, lock]);
  }, []);

  const removeLock = useCallback((lockId: string) => {
    setLocks(prev => prev.filter(l => l.id !== lockId));
  }, []);

  // Poll the server every 3s so the lock list stays current even when socket
  // events are missed (e.g. during a brief Vite-proxy reconnect in dev).
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const res = await fetch('/api/locks');
        if (res.ok) setLocks(await res.json());
      } catch {
        // ignore — leave existing state intact on network error
      }
    }, 3_000);
    return () => clearInterval(id);
  }, []);

  // Safety net: purge any locks whose TTL has expired from local state.
  // This handles the case where a lock:released event was missed (e.g. the
  // agent held the lock past its TTL and releaseAll skipped it on an older
  // build, or the socket event was dropped during a reconnect).
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      setLocks(prev => prev.filter(l => l.expires_at > now));
    }, 10_000);
    return () => clearInterval(id);
  }, []);

  return { locks, setInitial, addLock, removeLock };
}
