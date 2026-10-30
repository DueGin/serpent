import { EventEmitter } from 'node:events';
import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import type { MatchSummaryDTO } from './api-types';
import { matchesSvc } from './services';

export const arenaEvents = new EventEmitter();

function publicMatch(match: MatchSummaryDTO): MatchSummaryDTO {
  return {
    ...match,
    participants: match.participants.map(({ logs: _logs, firstError: _error, ...participant }) => participant),
  };
}

export function attachRealtime(server: HttpServer): Server {
  const io = new Server(server, { cors: { origin: '*' } });
  let stopped = false;
  let polling = false;
  let lastLive = '';

  const liveChanged = (matches: MatchSummaryDTO[]) => {
    if (stopped) return;
    const publicMatches = matches.map(publicMatch);
    const snapshot = JSON.stringify(publicMatches);
    if (snapshot !== lastLive) {
      lastLive = snapshot;
      io.emit('lobby:live', publicMatches);
    }
  };
  const matchFinished = (match: MatchSummaryDTO) => { io.emit('match:finished', publicMatch(match)); };
  const ladderUpdated = (event: { slug: string }) => { io.emit('ladder:updated', event); };
  arenaEvents.on('lobby:live', liveChanged);
  arenaEvents.on('match:finished', matchFinished);
  arenaEvents.on('ladder:updated', ladderUpdated);

  io.on('connection', socket => {
    void matchesSvc.live().then(matches => {
      if (socket.connected) socket.emit('lobby:live', matches.map(publicMatch));
    }).catch(() => { /* The next poll retries transient database failures. */ });
  });

  // Finished simulations leave the live list when their playback window expires.
  const timer = setInterval(() => {
    if (stopped || polling) return;
    polling = true;
    void matchesSvc.live().then(liveChanged).catch(() => {}).finally(() => { polling = false; });
  }, 1000);
  timer.unref();
  server.once('close', () => {
    stopped = true;
    clearInterval(timer);
    arenaEvents.off('lobby:live', liveChanged);
    arenaEvents.off('match:finished', matchFinished);
    arenaEvents.off('ladder:updated', ladderUpdated);
  });

  return io;
}
