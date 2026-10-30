import {
  type BotStrategy,
  type Direction,
  type GameState,
  type Point,
  DIRECTIONS,
  OPPOSITE,
  pointKey,
} from '../types';
import { nextCell, resolveDir } from './engine';

function blockedSet(state: GameState, snakeId: string, coward: boolean): Set<string> {
  const blocked = new Set<string>();
  for (const snake of state.snakes) {
    const cells = snake.id === snakeId && snake.body.length > 1
      ? snake.body.slice(0, -1)
      : snake.body;
    for (const p of cells) blocked.add(pointKey(p));
  }
  if (!coward) return blocked;
  for (const snake of state.snakes) {
    if (snake.id === snakeId || !snake.alive) continue;
    const head = snake.body[0];
    if (!head) continue;
    for (const dir of DIRECTIONS) {
      const n = nextCell(head, dir, state.width, state.height, state.wrap);
      if (n) blocked.add(pointKey(n));
    }
  }
  return blocked;
}

function neighbors(
  point: Point,
  state: GameState,
  blocked: Set<string>,
  goals: Set<string>,
): Array<{ point: Point; dir: Direction }> {
  const out: Array<{ point: Point; dir: Direction }> = [];
  for (const dir of DIRECTIONS) {
    const n = nextCell(point, dir, state.width, state.height, state.wrap);
    if (!n) continue;
    const k = pointKey(n);
    if (blocked.has(k) && !goals.has(k)) continue;
    out.push({ point: n, dir });
  }
  return out;
}

function reconstruct(
  came: Map<string, { prev: string; dir: Direction }>,
  goal: string,
  startKey: string,
): Direction | null {
  let cur = goal;
  let dir: Direction | null = null;
  let guard = 0;
  while (cur !== startKey && guard++ < 10_000) {
    const node = came.get(cur);
    if (!node) return dir;
    dir = node.dir;
    cur = node.prev;
  }
  return dir;
}

function bfsDir(
  start: Point,
  goals: Set<string>,
  state: GameState,
  blocked: Set<string>,
  reverse: Direction | null,
): Direction | null {
  const startKey = pointKey(start);
  if (goals.has(startKey)) return null;
  const q: Point[] = [start];
  const came = new Map<string, { prev: string; dir: Direction }>();
  const seen = new Set<string>([startKey]);
  let qi = 0;
  while (qi < q.length) {
    const cur = q[qi++]!;
    for (const n of neighbors(cur, state, blocked, goals)) {
      if (pointKey(cur) === startKey && reverse && n.dir === reverse) continue;
      const k = pointKey(n.point);
      if (seen.has(k)) continue;
      seen.add(k);
      came.set(k, { prev: pointKey(cur), dir: n.dir });
      if (goals.has(k)) return reconstruct(came, k, startKey);
      q.push(n.point);
    }
  }
  return null;
}

function anySafe(state: GameState, snakeId: string): Direction | null {
  const snake = state.snakes.find((s) => s.id === snakeId);
  if (!snake || !snake.body[0]) return null;
  const blocked = blockedSet(state, snakeId, false);
  const reverse = snake.body.length > 1 ? OPPOSITE[snake.dir] : null;
  const head = snake.body[0];
  for (const dir of DIRECTIONS) {
    if (reverse && dir === reverse) continue;
    const n = nextCell(head, dir, state.width, state.height, state.wrap);
    if (n && !blocked.has(pointKey(n))) return dir;
  }
  return DIRECTIONS.find((d) => d !== reverse) ?? snake.dir;
}

export function chooseMove(state: GameState, snakeId: string, strategy: BotStrategy = 'greedy'): Direction {
  const snake = state.snakes.find((s) => s.id === snakeId);
  if (!snake || !snake.alive || !snake.body[0]) return 'right';
  const reverse = snake.body.length > 1 ? OPPOSITE[snake.dir] : null;
  if (strategy === 'random') {
    const options = DIRECTIONS.filter((d) => d !== reverse);
    const pick = options[Math.floor(state.rng() * options.length)];
    return pick ?? snake.dir;
  }
  const blocked = blockedSet(state, snakeId, strategy === 'coward');
  const goals = new Set(state.foods.map(pointKey));
  const found = bfsDir(snake.body[0], goals, state, blocked, reverse);
  if (found) return found;
  return anySafe(state, snakeId) ?? resolveDir(snake);
}
