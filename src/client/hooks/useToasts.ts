import { useReducer, useEffect, useRef, useCallback } from 'react';
import socket from '../socket';
import type { AgentWithJob, Job } from '@shared/types';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  agentId?: string;
  timestamp: number;
}

const MAX_TOASTS = 5;
const AUTO_DISMISS_MS = 5000;

type Action =
  | { type: 'add'; toast: Toast }
  | { type: 'dismiss'; id: string }
  | { type: 'clear' };

function reducer(state: Toast[], action: Action): Toast[] {
  switch (action.type) {
    case 'add': {
      const next = [action.toast, ...state];
      return next.length > MAX_TOASTS ? next.slice(0, MAX_TOASTS) : next;
    }
    case 'dismiss':
      return state.filter(t => t.id !== action.id);
    case 'clear':
      return [];
    default:
      return state;
  }
}

let toastSeq = 0;

export function useToasts() {
  const [toasts, dispatch] = useReducer(reducer, []);
  const statusMapRef = useRef<Map<string, string>>(new Map());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    dispatch({ type: 'dismiss', id });
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const clearAll = useCallback(() => {
    dispatch({ type: 'clear' });
    for (const timer of timersRef.current.values()) clearTimeout(timer);
    timersRef.current.clear();
  }, []);

  const addToast = useCallback((type: ToastType, message: string, agentId?: string) => {
    const id = `toast-${++toastSeq}`;
    dispatch({ type: 'add', toast: { id, type, message, agentId, timestamp: Date.now() } });
    const timer = setTimeout(() => {
      dispatch({ type: 'dismiss', id });
      timersRef.current.delete(id);
    }, AUTO_DISMISS_MS);
    timersRef.current.set(id, timer);
  }, []);

  useEffect(() => {
    const handleAgentUpdate = ({ agent }: { agent: AgentWithJob }) => {
      const prev = statusMapRef.current.get(agent.id);
      statusMapRef.current.set(agent.id, agent.status);

      // Only fire on actual transition
      if (prev === agent.status) return;

      const title = agent.job?.title || agent.id.slice(0, 8);

      switch (agent.status) {
        case 'done': {
          const cost = agent.cost_usd != null ? ` ($${agent.cost_usd.toFixed(2)})` : '';
          addToast('success', `${title} finished${cost}`, agent.id);
          break;
        }
        case 'failed':
          addToast('error', `${title} failed`, agent.id);
          break;
        case 'waiting_user':
          addToast('warning', `${title} needs input`, agent.id);
          break;
        case 'cancelled':
          addToast('info', `${title} cancelled`, agent.id);
          break;
      }
    };

    const handleJobNew = ({ job }: { job: Job }) => {
      addToast('info', `Queued: ${job.title || job.id.slice(0, 8)}`);
    };

    socket.on('agent:update', handleAgentUpdate);
    socket.on('job:new', handleJobNew);

    return () => {
      socket.off('agent:update', handleAgentUpdate);
      socket.off('job:new', handleJobNew);
    };
  }, [addToast]);

  // Cleanup all timers on unmount
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  return { toasts, dismiss, clearAll };
}
