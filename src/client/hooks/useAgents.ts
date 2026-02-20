import { useState, useCallback } from 'react';
import type { AgentWithJob, AgentOutput } from '@shared/types';

export function useAgents() {
  const [agents, setAgents] = useState<AgentWithJob[]>([]);

  const setInitial = useCallback((initial: AgentWithJob[]) => {
    setAgents(initial);
  }, []);

  const addAgent = useCallback((agent: AgentWithJob) => {
    setAgents(prev => [agent, ...prev]);
  }, []);

  const updateAgent = useCallback((agent: AgentWithJob) => {
    setAgents(prev => prev.map(a => a.id === agent.id ? agent : a));
  }, []);

  return { agents, setInitial, addAgent, updateAgent };
}
