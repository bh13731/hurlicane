import { Server as HttpServer } from 'http';
import { Server as SocketIoServer } from 'socket.io';
import type { ServerToClientEvents, ClientToServerEvents, AgentWithJob, Job, Question, FileLock, AgentOutput, QueueSnapshot, Debate } from '../../shared/types.js';

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

export function emitDebateNew(debate: Debate): void {
  getIo().emit('debate:new', { debate });
}

export function emitDebateUpdate(debate: Debate): void {
  getIo().emit('debate:update', { debate });
}
