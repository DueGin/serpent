import {
  type BuiltinBot,
  type Direction,
  type Point,
  DIRECTIONS,
  OPPOSITE,
  pointKey,
} from '../types';
import { type GameState, nextCell, seedRng } from './engine';

function blockedSet(state: GameState, slot: number, coward: boolean): Set<string> {
  const me = state.snakes.find((snake) => snake.slot === slot)!;
  const blocked = new Set<string>();
  for (const snake of state.snakes) {
    if (!snake.alive || (snake.slot !== slot &&
        (state.config.ruleset === 'classic' && state.mode === 'score' || (state.teams && snake.team === me.team)))) continue;
    const body = snake.slot === slot ? snake.body.slice(0, -1) : snake.body;
    for (const point of body) blocked.add(pointKey(point));
  }
  if ((coward || state.config.ruleset !== 'classic') && state.mode !== 'solo') {
    for (const snake of state.snakes) {
      if (!snake.alive || snake.slot === slot || (state.teams && snake.team === me.team)) continue;
      // Avoid immediate head-to-head with an opponent that is at least as long.
      for (const dir of DIRECTIONS) {
        const point = nextCell(snake.body[0]!, dir, state.width, state.height, state.wrap);
        if (point && (!coward || (me.body.length <= snake.body.length))) blocked.add(pointKey(point));
      }
    }
  }
  return blocked;
}

function bfsDir(state: GameState, slot: number, blocked: Set<string>): Direction | null {
  const snake = state.snakes.find((candidate) => candidate.slot === slot)!;
  const start = snake.body[0]!;
  const goals = new Set(state.foods.map(pointKey));
  const queue: Array<{ point: Point; first: Direction | null }> = [{ point: start, first: null }];
  const visited = new Set([pointKey(start)]);
  for (let i = 0; i < queue.length; i++) {
    const { point, first } = queue[i]!;
    for (const dir of DIRECTIONS) {
      if (first === null && dir === OPPOSITE[snake.dir]) continue;
      const next = nextCell(point, dir, state.width, state.height, state.wrap);
      if (!next) continue;
      const key = pointKey(next);
      if (blocked.has(key) || visited.has(key)) continue;
      const firstDir = first ?? dir;
      if (goals.has(key)) return firstDir;
      visited.add(key);
      queue.push({ point: next, first: firstDir });
    }
  }
  return null;
}

export function chooseMove(state: GameState, id: string | number, strategy: BuiltinBot = 'greedy'): Direction {
  const snake = state.snakes.find((candidate) => typeof id === 'number' ? candidate.slot === id : candidate.id === id);
  if (!snake?.alive || !snake.body[0]) return snake?.dir ?? 'right';
  const options = DIRECTIONS.filter((dir) => dir !== OPPOSITE[snake.dir] &&
    nextCell(snake.body[0]!, dir, state.width, state.height, state.wrap));
  if (strategy === 'random') {
    // Separate seed stream: builtin bots must never advance the food RNG.
    const random = seedRng((state.config.seed ^ Math.imul(snake.slot + 1, 0x9e3779b1) ^ Math.imul(state.tick + 1, 0x85ebca6b)) >>> 0);
    return options[Math.floor(random() * options.length)] ?? snake.dir;
  }
  const blocked = blockedSet(state, snake.slot, strategy === 'coward');
  if (strategy === 'coward' && snake.hp !== null && snake.hp <= 25) {
    // BFS already targets food; making the current head a goal naturally prioritizes recovery.
    const nearest = state.foods.map((food) => Math.abs(food.x - snake.body[0]!.x) + Math.abs(food.y - snake.body[0]!.y))
      .sort((a, b) => a - b)[0];
    if (nearest !== undefined && nearest >= snake.hp) return bfsDir(state, snake.slot, blocked) ?? snake.dir;
  }
  const path = bfsDir(state, snake.slot, blocked);
  if (path) return path;
  return options.find((dir) => {
    const next = nextCell(snake.body[0]!, dir, state.width, state.height, state.wrap);
    return next && !blocked.has(pointKey(next));
  }) ?? options[0] ?? snake.dir;
}
