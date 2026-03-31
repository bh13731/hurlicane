import { useState, useCallback } from 'react';
import type { Workflow } from '@shared/types';

export function useWorkflows() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);

  const setInitial = useCallback((initial: Workflow[]) => {
    setWorkflows(initial);
  }, []);

  const addWorkflow = useCallback((workflow: Workflow) => {
    setWorkflows(prev => [workflow, ...prev]);
  }, []);

  const updateWorkflow = useCallback((workflow: Workflow) => {
    setWorkflows(prev => prev.map(w => w.id === workflow.id ? workflow : w));
  }, []);

  return { workflows, setInitial, addWorkflow, updateWorkflow };
}
