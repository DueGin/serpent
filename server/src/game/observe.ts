import {
  type Direction,
  type GameState,
  type Observation,
  type PublicRoom,
  type PublicSnake,
  type Snake,
  DIRECTIONS,
  OPPOSITE,
} from '../types';
import { nextCell, resolveDir } from './engine';

export function toPublicSnake(snake: Snake): PublicSnake {
  return {
    id: snake.id,
    name: snake.name,
    kind: snake.kind,
    color: snake.color,
    body: snake.body.map((p) => ({ ...p })),
    dir: snake.dir,
    alive: snake.alive,
    score: snake.score,
    kills: snake.kills,
    ready: snake.ready,
    isBot: Boolean(snake.strategy),
  };
}

export function remainingMs(state: GameState): number | null {
  if (state.timeLimitMs == null) return null;
  return Math.max(0, state.timeLimitMs - state.elapsedMs);
}

export function legalMoves(state: GameState, snakeId: string): Direction[] {
  const snake = state.snakes.find((s) => s.id === snakeId);
  if (!snake || !snake.alive) return [];
  const dir = resolveDir(snake);
  return DIRECTIONS.filter((d) => {
    if (snake.body.length > 1 && d === OPPOSITE[snake.dir]) return false;
    const head = snake.body[0];
    if (!head) return false;
    const next = nextCell(head, d, state.width, state.height, state.wrap);
    if (!next) return false;
    void dir;
    return true;
  });
}

export function asciiGrid(state: GameState, snakeId?: string): string {
  const grid: string[][] = Array.from({ length: state.height }, () =>
    Array.from({ length: state.width }, () => '.'),
  );
  for (const food of state.foods) {
    if (grid[food.y]) grid[food.y]![food.x] = '*';
  }
  for (const snake of state.snakes) {
    snake.body.forEach((p, i) => {
      if (!grid[p.y]) return;
      const you = snake.id === snakeId;
      if (i === 0) grid[p.y]![p.x] = you ? 'H' : 'h';
      else grid[p.y]![p.x] = you ? 'B' : 'b';
    });
  }
  const inner = grid.map((row) => row.join(''));
  if (state.wrap) return inner.join('\n');
  const wall = '#'.repeat(state.width + 2);
  return [wall, ...inner.map((r) => `#${r}#`), wall].join('\n');
}

export function observe(state: GameState, snakeId: string): Observation {
  const snake = state.snakes.find((s) => s.id === snakeId);
  return {
    protocol: 'serpent-v1',
    mode: state.mode,
    status: state.status,
    tick: state.tick,
    tickMs: state.tickMs,
    width: state.width,
    height: state.height,
    wrap: state.wrap,
    remainingMs: remainingMs(state),
    targetScore: state.targetScore,
    you: {
      id: snakeId,
      name: snake?.name ?? '',
      head: snake?.body[0] ?? null,
      body: snake?.body.map((p) => ({ ...p })) ?? [],
      dir: snake?.dir ?? null,
      alive: snake?.alive ?? false,
      score: snake?.score ?? 0,
      kills: snake?.kills ?? 0,
    },
    snakes: state.snakes.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      head: s.body[0] ?? null,
      body: s.body.map((p) => ({ ...p })),
      dir: s.dir,
      alive: s.alive,
      score: s.score,
    })),
    foods: state.foods.map((p) => ({ ...p })),
    legalMoves: legalMoves(state, snakeId),
    grid: asciiGrid(state, snakeId),
    gameOver: state.status === 'ended',
    winners: state.winners.slice(),
  };
}

export function observationText(obs: Observation): string {
  const lines = [
    `mode=${obs.mode} status=${obs.status} tick=${obs.tick} score=${obs.you.score}`,
    `you head=${obs.you.head ? `${obs.you.head.x},${obs.you.head.y}` : (obs.status === 'lobby' ? 'lobby' : 'dead')} dir=${obs.you.dir ?? '-'} alive=${obs.you.alive}`,
    `foods=${obs.foods.map((f) => `${f.x},${f.y}`).join(' ') || 'none'}`,
    `legalMoves=${obs.legalMoves.join(',')}`,
    `grid legend: H=your head B=your body h/b=others *=food .=empty #=wall`,
    obs.grid,
  ];
  if (obs.gameOver) lines.unshift(`GAME OVER winners=${obs.winners.join(',') || 'none'}`);
  return lines.join('\n');
}

export function publicRoomFrom(
  extra: Omit<PublicRoom, 'players' | 'foods' | 'tick' | 'width' | 'height' | 'tickMs' | 'wrap' | 'remainingMs' | 'targetScore' | 'winners' | 'events' | 'you' | 'mode' | 'status'> & {
    state: GameState | null;
    youId?: string;
    mode: PublicRoom['mode'];
    status: PublicRoom['status'];
  },
): PublicRoom {
  const { state, youId, ...rest } = extra;
  const snakes = state?.snakes ?? [];
  const players = snakes.map(toPublicSnake);
  return {
    ...rest,
    mode: extra.mode,
    status: extra.status,
    tick: state?.tick ?? 0,
    width: state?.width ?? 0,
    height: state?.height ?? 0,
    tickMs: state?.tickMs ?? 120,
    wrap: state?.wrap ?? false,
    foods: state?.foods.map((p) => ({ ...p })) ?? [],
    players,
    remainingMs: state ? remainingMs(state) : extra.mode === 'score' ? 60_000 : null,
    targetScore: state?.targetScore ?? null,
    winners: (state?.winners ?? []).map((id) => {
      const s = snakes.find((p) => p.id === id);
      return { id, name: s?.name ?? id, score: s?.score ?? 0 };
    }),
    events: state?.events.slice(-12) ?? [],
    you: youId ? players.find((p) => p.id === youId) : undefined,
  };
}
