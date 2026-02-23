import { useEffect } from 'react';
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
  useEffect(() => {
    const { onSnapshot, onAgentNew, onAgentUpdate, onAgentOutput, onQuestionNew, onQuestionAnswered, onLockAcquired, onLockReleased, onJobNew, onJobUpdate, onDebateNew, onDebateUpdate } = handlers;

    // Keep named references so we can remove the exact listener on cleanup
    const handleAgentNew = ({ agent }: { agent: AgentWithJob }) => onAgentNew(agent);
    const handleAgentUpdate = ({ agent }: { agent: AgentWithJob }) => onAgentUpdate(agent);
    const handleAgentOutput = ({ agent_id, line }: { agent_id: string; line: AgentOutput }) => onAgentOutput(agent_id, line);
    const handleQuestionNew = ({ question }: { question: Question }) => onQuestionNew(question);
    const handleQuestionAnswered = ({ question }: { question: Question }) => onQuestionAnswered(question);
    const handleLockAcquired = ({ lock }: { lock: FileLock }) => onLockAcquired(lock);
    const handleLockReleased = ({ lock_id, file_path }: { lock_id: string; file_path: string }) => onLockReleased(lock_id, file_path);
    const handleJobNew = ({ job }: { job: Job }) => onJobNew(job);
    const handleJobUpdate = ({ job }: { job: Job }) => onJobUpdate(job);
    const handleDebateNew = onDebateNew ? ({ debate }: { debate: Debate }) => onDebateNew(debate) : undefined;
    const handleDebateUpdate = onDebateUpdate ? ({ debate }: { debate: Debate }) => onDebateUpdate(debate) : undefined;

    socket.on('queue:snapshot', onSnapshot);
    socket.on('agent:new', handleAgentNew);
    socket.on('agent:update', handleAgentUpdate);
    socket.on('agent:output', handleAgentOutput);
    socket.on('question:new', handleQuestionNew);
    socket.on('question:answered', handleQuestionAnswered);
    socket.on('lock:acquired', handleLockAcquired);
    socket.on('lock:released', handleLockReleased);
    socket.on('job:new', handleJobNew);
    socket.on('job:update', handleJobUpdate);
    if (handleDebateNew) (socket as any).on('debate:new', handleDebateNew);
    if (handleDebateUpdate) (socket as any).on('debate:update', handleDebateUpdate);

    // If the socket is already connected (e.g. React StrictMode double-mount or Vite HMR),
    // the server's connection event already fired and won't fire again. Request a fresh snapshot.
    if (socket.connected) {
      socket.emit('request:snapshot');
    }

    return () => {
      socket.off('queue:snapshot', onSnapshot);
      socket.off('agent:new', handleAgentNew);
      socket.off('agent:update', handleAgentUpdate);
      socket.off('agent:output', handleAgentOutput);
      socket.off('question:new', handleQuestionNew);
      socket.off('question:answered', handleQuestionAnswered);
      socket.off('lock:acquired', handleLockAcquired);
      socket.off('lock:released', handleLockReleased);
      socket.off('job:new', handleJobNew);
      socket.off('job:update', handleJobUpdate);
      if (handleDebateNew) (socket as any).off('debate:new', handleDebateNew);
      if (handleDebateUpdate) (socket as any).off('debate:update', handleDebateUpdate);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
