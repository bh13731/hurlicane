import { Server as HttpServer } from 'http';
import { Server as SocketIoServer } from 'socket.io';
import type { ServerToClientEvents, ClientToServerEvents, AgentWithJob, Job, Question, FileLock, AgentOutput, QueueSnapshot, AgentWarning } from '../../shared/types.js';
import { notifyFailure } from '../services/SlackNotifier.js';

let _io: SocketIoServer<ClientToServerEvents, ServerToClientEvents> | null = null;

export function initSocketManager(httpServer: HttpServer): SocketIoServer<ClientToServerEvents, ServerToClientEvents> {
  const io = new SocketIoServer<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: { origin: '*' },
  });

  io.on('connection', (socket) => {
    console.log(`[socket] client connected: ${socket.id}`);
    socket.on('disconnect', () => {
      console.log(`[socket] client disconnected: ${socket.id}`);
    });
  });

  _io = io;
  return io;
}

export function getIo(): SocketIoServer<ClientToServerEvents, ServerToClientEvents> {
  if (!_io) throw new Error('SocketManager not initialized');
  return _io;
}

export function emitSnapshot(snapshot: QueueSnapshot): void {
  getIo().emit('queue:snapshot', snapshot);
}

export function emitAgentNew(agent: AgentWithJob): void {
  getIo().emit('agent:new', { agent });
}

export function emitAgentUpdate(agent: AgentWithJob): void {
  getIo().emit('agent:update', { agent });
  if (agent.status === 'failed') {
    notifyFailure(`Agent failed`, agent.error_message ?? 'Unknown error', `Agent: ${agent.id}\nJob: ${agent.job?.title ?? agent.job_id}`);
  }
}

export function emitAgentOutput(agentId: string, line: AgentOutput): void {
  getIo().emit('agent:output', { agent_id: agentId, line });
}

export function emitQuestionNew(question: Question): void {
  getIo().emit('question:new', { question });
}

export function emitQuestionAnswered(question: Question): void {
  getIo().emit('question:answered', { question });
}

export function emitLockAcquired(lock: FileLock): void {
  getIo().emit('lock:acquired', { lock });
}

export function emitLockReleased(lockId: string, filePath: string): void {
  getIo().emit('lock:released', { lock_id: lockId, file_path: filePath });
}

export function emitJobNew(job: Job): void {
  getIo().emit('job:new', { job });
}

export function emitJobUpdate(job: Job): void {
  getIo().emit('job:update', { job });
}

export function emitPtyData(agentId: string, data: string): void {
  getIo().emit('pty:data', { agent_id: agentId, data });
}

export function emitPtyClosed(agentId: string): void {
  getIo().emit('pty:closed', { agent_id: agentId });
}

export function emitWarningNew(warning: AgentWarning): void {
  getIo().emit('warning:new', { warning });
}

export function emitRepoCloneProgress(repoId: string, phase: string, percent: number | null): void {
  getIo().emit('repo:clone-progress', { repo_id: repoId, phase, percent });
}
