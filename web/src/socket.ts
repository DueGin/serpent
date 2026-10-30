import { io, Socket } from 'socket.io-client';
import type { PublicRoom, RoomSummary } from './types';

export interface PresenceUser {
  userId: number;
  username: string;
  roomCode: string | null;
}

export interface ServerToClient {
  'session:ok': (data: { playerId: string; name?: string; userId?: number }) => void;
  'rooms:list': (rooms: RoomSummary[]) => void;
  'presence:list': (users: PresenceUser[]) => void;
  'room:joined': (room: PublicRoom) => void;
  'room:state': (room: PublicRoom) => void;
  error: (data: { message: string }) => void;
}

export interface ClientToServer {
  'rooms:list': () => void;
  'room:create': (data: { mode: string; thinkTimeoutSec?: number }) => void;
  'room:join': (data: { code: string; play?: boolean }) => void;
  'room:seat': () => void;
  'room:leave': () => void;
  'room:ready': (data?: { ready?: boolean }) => void;
  'room:config': (data: { thinkTimeoutSec: number }) => void;
  'room:start': () => void;
  'room:bot': (data?: { strategy?: string }) => void;
  'room:deploy-agent': (data: { agentId: number }) => void;
  'game:act': (data: { direction: string }) => void;
}

export const socket: Socket<ServerToClient, ClientToServer> = io({
  autoConnect: false,
});

export function connectSocket(token: string): void {
  socket.auth = { token };
  if (socket.connected) socket.disconnect();
  socket.connect();
}

export function disconnectSocket(): void {
  if (socket.connected) socket.disconnect();
}
