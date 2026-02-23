import { useState, useCallback } from 'react';
import type { Debate } from '@shared/types';

export function useDebates() {
  const [debates, setDebates] = useState<Debate[]>([]);

  const setInitial = useCallback((initial: Debate[]) => {
    setDebates(initial);
  }, []);

  const addDebate = useCallback((debate: Debate) => {
    setDebates(prev => [debate, ...prev]);
  }, []);

  const updateDebate = useCallback((debate: Debate) => {
    setDebates(prev => prev.map(d => d.id === debate.id ? debate : d));
  }, []);

  return { debates, setInitial, addDebate, updateDebate };
}
