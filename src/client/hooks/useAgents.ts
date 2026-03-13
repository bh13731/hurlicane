import { useState, useCallback } from 'react';
import type { AgentWithJob } from '@shared/types';

export function useAgents() {
  const [agents, setAgents] = useState<AgentWithJob[]>([]);

  const setInitial = useCallback((initial: AgentWithJob[]) => {
    setAgents(initial);
  }, []);

  const addAgent = useCallback((agent: AgentWithJob) => {
    setAgents(prev => {
      if (prev.some(a => a.id === agent.id)) return prev;
      return [agent, ...prev];
    });
  }, []);

  // Upsert: update if exists, insert if not (handles out-of-order events)
  const updateAgent = useCallback((agent: AgentWithJob) => {
    setAgents(prev => {
      const idx = prev.findIndex(a => a.id === agent.id);
      if (idx >= 0) {
        const updated = [...prev];
        updated[idx] = agent;
        return updated;
      }
      return [agent, ...prev];
    });
  }, []);

  return { agents, setInitial, addAgent, updateAgent };
}
