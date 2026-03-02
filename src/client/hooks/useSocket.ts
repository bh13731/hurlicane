import { useEffect, useRef } from 'react';
import socket from '../socket';
import type { AgentWithJob, Job, Question, FileLock, AgentOutput, QueueSnapshot, Debate } from '@shared/types';

interface SocketHandlers {
  onSnapshot: (snapshot: QueueSnapshot) => void;
  onAgentNew: (agent: AgentWithJob) => void;
  onAgentUpdate: (agent: AgentWithJob) => void;
  onAgentOutput: (agentId: string, line: AgentOutput) => void;
  onQuestionNew: (question: Question) => void;
  onQuestionAnswered: (question: Question) => void;
  onLockAcquired: (lock: FileLock) => void;
  onLockReleased: (lockId: string, filePath: string) => void;
  onJobNew: (job: Job) => void;
  onJobUpdate: (job: Job) => void;
  onDebateNew?: (debate: Debate) => void;
  onDebateUpdate?: (debate: Debate) => void;
}

export function useSocket(handlers: SocketHandlers): void {
  // Store handlers in a ref so the socket listeners always call the latest version.
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const h = (ev: string, fn: (...args: any[]) => void) => {
      socket.on(ev as any, fn);
      return () => { socket.off(ev as any, fn); };
    };

    const offs = [
      h('queue:snapshot', (snapshot: QueueSnapshot) => ref.current.onSnapshot(snapshot)),
      h('agent:new', ({ agent }: { agent: AgentWithJob }) => ref.current.onAgentNew(agent)),
      h('agent:update', ({ agent }: { agent: AgentWithJob }) => ref.current.onAgentUpdate(agent)),
      h('agent:output', ({ agent_id, line }: { agent_id: string; line: AgentOutput }) => ref.current.onAgentOutput(agent_id, line)),
      h('question:new', ({ question }: { question: Question }) => ref.current.onQuestionNew(question)),
      h('question:answered', ({ question }: { question: Question }) => ref.current.onQuestionAnswered(question)),
      h('lock:acquired', ({ lock }: { lock: FileLock }) => ref.current.onLockAcquired(lock)),
      h('lock:released', ({ lock_id, file_path }: { lock_id: string; file_path: string }) => ref.current.onLockReleased(lock_id, file_path)),
      h('job:new', ({ job }: { job: Job }) => ref.current.onJobNew(job)),
      h('job:update', ({ job }: { job: Job }) => ref.current.onJobUpdate(job)),
      h('debate:new', ({ debate }: { debate: Debate }) => ref.current.onDebateNew?.(debate)),
      h('debate:update', ({ debate }: { debate: Debate }) => ref.current.onDebateUpdate?.(debate)),
      h('warning:new', (payload: any) => (ref.current as any).onWarningNew?.(payload)),
    ];

    // The server already pushes a snapshot on every new connection (io.on('connection')),
    // so we do NOT request one on the 'connect' event — that would cause a duplicate
    // snapshot that races with individual events and overwrites newer state with stale data.
    //
    // The only case we need to manually request is if the socket was already connected
    // before this effect ran (React StrictMode double-mount, Vite HMR), because the
    // server's connection handler already fired and won't fire again.
    if (socket.connected) {
      socket.emit('request:snapshot');
    }

    return () => {
      for (const off of offs) off();
    };
  }, []);
}
