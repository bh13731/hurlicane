import { io, Socket } from 'socket.io-client';
import type { ServerToClientEvents, ClientToServerEvents } from '@shared/types';

const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({
  path: '/socket.io',
  transports: ['websocket', 'polling'],
});

// Debug: log all socket events to console so we can see what's arriving
socket.onAny((event, ...args) => {
  if (event === 'pty:data' || event === 'agent:output') return; // too noisy
  console.log(`[socket] ${event}`, ...args);
});

socket.on('connect', () => console.log('[socket] connected'));
socket.on('disconnect', (reason) => console.log('[socket] disconnected:', reason));
socket.on('connect_error', (err) => {
  console.error('[socket] connect_error:', err.message);
  if (err.message === 'Unauthorized') {
    window.location.reload();
  }
});

export default socket;
