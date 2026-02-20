import { useState, useCallback } from 'react';
import type { Job } from '@shared/types';

export function useJobs() {
  const [jobs, setJobs] = useState<Job[]>([]);

  const setInitial = useCallback((initial: Job[]) => {
    setJobs(initial);
  }, []);

  const addJob = useCallback((job: Job) => {
    setJobs(prev => [job, ...prev]);
  }, []);

  const updateJob = useCallback((job: Job) => {
    setJobs(prev => prev.map(j => j.id === job.id ? job : j));
  }, []);

  return { jobs, setInitial, addJob, updateJob };
}
