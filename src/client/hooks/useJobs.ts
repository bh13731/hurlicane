import { useState, useCallback } from 'react';
import type { Job } from '@shared/types';

export function useJobs() {
  const [jobs, setJobs] = useState<Job[]>([]);

  const setInitial = useCallback((initial: Job[]) => {
    setJobs(initial);
  }, []);

  const addJob = useCallback((job: Job) => {
    setJobs(prev => {
      if (prev.some(j => j.id === job.id)) return prev;
      return [job, ...prev];
    });
  }, []);

  // Upsert: update if exists, insert if not (handles out-of-order events)
  const updateJob = useCallback((job: Job) => {
    setJobs(prev => {
      const idx = prev.findIndex(j => j.id === job.id);
      if (idx >= 0) {
        const updated = [...prev];
        updated[idx] = job;
        return updated;
      }
      return [job, ...prev];
    });
  }, []);

  return { jobs, setInitial, addJob, updateJob };
}
