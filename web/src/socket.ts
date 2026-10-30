import { io, type Socket } from 'socket.io-client';
import type { MatchSummaryDTO } from './types';

export interface ServerToClient {
  'lobby:live': (matches: MatchSummaryDTO[]) => void;
  'match:finished': (match: MatchSummaryDTO) => void;
  'ladder:updated': (data: { slug: string }) => void;
}

export const socket: Socket<ServerToClient> = io({ autoConnect: false });

export function connectSocket(): void {
  if (!socket.connected) socket.connect();
}

export function disconnectSocket(): void {
  if (socket.connected) socket.disconnect();
}

export function onRealtime(handlers: Partial<ServerToClient>): () => void {
  (Object.entries(handlers) as Array<[keyof ServerToClient, ServerToClient[keyof ServerToClient]]>).forEach(([event, handler]) => {
    socket.on(event, handler as never);
  });
  return () => {
    (Object.entries(handlers) as Array<[keyof ServerToClient, ServerToClient[keyof ServerToClient]]>).forEach(([event, handler]) => {
      socket.off(event, handler as never);
    });
  };
}
