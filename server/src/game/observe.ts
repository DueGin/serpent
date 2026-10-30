import {
  type Direction,
  type InitInfo,
  type ScriptState,
  type SnakeView,
  type Point,
  DIRECTIONS,
  OPPOSITE,
} from '../types';
import { type GameState, nextCell } from './engine';

function findSnake(state: GameState, id: string | number) {
  const snake = state.snakes.find((entry) => typeof id === 'number' ? entry.slot === id : entry.id === id);
  if (!snake) throw new Error(`Unknown snake: ${id}`);
  return snake;
}

export function legalMoves(state: GameState, id: string | number): Direction[] {
  const snake = findSnake(state, id);
  if (!snake.alive || !snake.body[0]) return [];
  return DIRECTIONS.filter((direction) => direction !== OPPOSITE[snake.dir] &&
    nextCell(snake.body[0]!, direction, state.width, state.height, state.wrap) !== null);
}

export function buildInitInfo(state: GameState, id: string | number): InitInfo {
  const you = findSnake(state, id);
  return {
    protocol: 'serpent-script-v1', mode: state.mode, teams: state.teams,
    width: state.width, height: state.height, wrap: state.wrap,
    maxTicks: state.maxTicks, targetScore: state.targetScore,
    you: { id: you.id, slot: you.slot, team: you.team },
    players: state.snakes.map((snake) => ({ id: snake.id, slot: snake.slot, name: snake.name, team: snake.team })),
    limits: {
      moveTimeoutMs: state.config.moveTimeoutMs,
      initTimeoutMs: state.config.initTimeoutMs,
      memoryLimitMB: state.config.memoryLimitMB,
    },
  };
}

export function buildScriptState(state: GameState, id: string | number): ScriptState {
  const you = findSnake(state, id);
  const snakes: SnakeView[] = state.snakes.map((snake) => ({
    id: snake.id, slot: snake.slot, name: snake.name, team: snake.team,
    head: snake.body[0] ? { ...snake.body[0] } : null,
    body: snake.body.map((point) => ({ ...point })), dir: snake.dir,
    length: snake.body.length, score: snake.score, alive: snake.alive,
  }));
  return {
    protocol: 'serpent-script-v1', tick: state.tick, maxTicks: state.maxTicks,
    remainingTicks: Math.max(0, state.maxTicks - state.tick), mode: state.mode,
    teams: state.teams, width: state.width, height: state.height,
    wrap: state.wrap, targetScore: state.targetScore,
    you: snakes.find((snake) => snake.slot === you.slot)!, snakes,
    foods: state.foods.map((food) => ({ ...food })), legalMoves: legalMoves(state, id),
  };
}

export function asciiGrid(state: GameState, id?: string | number): string {
  const viewer = id === undefined ? null : findSnake(state, id).id;
  const grid: string[][] = Array.from({ length: state.height }, () => Array<string>(state.width).fill('.'));
  const mark = (point: Point, char: string) => {
    if (grid[point.y]?.[point.x] !== undefined) grid[point.y]![point.x] = char;
  };
  for (const food of state.foods) mark(food, '*');
  // Dead bodies are historical only; show active obstacles, placing the viewer last.
  for (const snake of state.snakes.filter((entry) => entry.alive).sort((a, b) => (a.id === viewer ? 1 : 0) - (b.id === viewer ? 1 : 0))) {
    snake.body.forEach((point, index) => mark(point, snake.id === viewer ? index ? 'B' : 'H' : index ? 'b' : 'h'));
  }
  if (state.wrap) return grid.map((row) => row.join('')).join('\n');
  const wall = '#'.repeat(state.width + 2);
  return [wall, ...grid.map((row) => `#${row.join('')}#`), wall].join('\n');
}
