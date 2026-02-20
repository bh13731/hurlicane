import { io, Socket } from 'socket.io-client';
import type { ServerToClientEvents, ClientToServerEvents } from '@shared/types';

const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({
  path: '/socket.io',
  transports: ['websocket', 'polling'],
});

export default socket;
