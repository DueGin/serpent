export type Direction = 'up' | 'down' | 'left' | 'right';
export type GameMode = 'solo' | 'score' | 'battle';
export type PlayerKind = 'human' | 'agent';
export type RoomStatus = 'lobby' | 'countdown' | 'running' | 'ended';
export type BotStrategy = 'greedy' | 'coward' | 'random';
export type AgentThinkStatus = 'idle' | 'thinking' | 'done' | 'timeout' | 'error';

export interface AgentThink {
  status: AgentThinkStatus;
  direction?: Direction | null;
  elapsedMs?: number;
}

export function clampThinkTimeoutSec(sec?: number): number {
  const n = Math.round(Number(sec ?? 10));
  if (!Number.isFinite(n)) return 10;
  return Math.min(60, Math.max(3, n));
}

export interface Point {
  x: number;
  y: number;
}

export interface Snake {
  id: string;
  name: string;
  kind: PlayerKind;
  color: string;
  body: Point[];
  dir: Direction;
  pendingDir: Direction | null;
  alive: boolean;
  score: number;
  kills: number;
  ready: boolean;
  /** In-process bot; empty for remote agents / humans. */
  strategy?: BotStrategy;
}

export interface GameEvent {
  tick: number;
  type: 'eat' | 'die' | 'win' | 'spawn' | 'info';
  playerId?: string;
  message: string;
}

export interface GameState {
  mode: GameMode;
  status: RoomStatus;
  width: number;
  height: number;
  tickMs: number;
  wrap: boolean;
  tick: number;
  foods: Point[];
  snakes: Snake[];
  foodCount: number;
  targetScore: number | null;
  timeLimitMs: number | null;
  elapsedMs: number;
  rng: () => number;
  events: GameEvent[];
  winners: string[];
}

export interface CreatePlayerInput {
  id: string;
  name: string;
  kind: PlayerKind;
  color: string;
  strategy?: BotStrategy;
  spawnIndex?: number;
}

export interface CreateGameInput {
  mode: GameMode;
  width?: number;
  height?: number;
  tickMs?: number;
  wrap?: boolean;
  foodCount?: number;
  targetScore?: number | null;
  timeLimitMs?: number | null;
  players: CreatePlayerInput[];
  foods?: Point[];
  rng?: () => number;
}

export interface PublicSnake {
  id: string;
  name: string;
  kind: PlayerKind;
  color: string;
  body: Point[];
  dir: Direction;
  alive: boolean;
  score: number;
  kills: number;
  ready: boolean;
  isBot: boolean;
  think?: AgentThink;
}

export interface PublicRoom {
  id: string;
  code: string;
  mode: GameMode;
  status: RoomStatus;
  countdown: number;
  tick: number;
  width: number;
  height: number;
  tickMs: number;
  wrap: boolean;
  foods: Point[];
  players: PublicSnake[];
  hostId: string;
  remainingMs: number | null;
  targetScore: number | null;
  maxPlayers: number;
  winners: { id: string; name: string; score: number }[];
  events: GameEvent[];
  you?: PublicSnake;
  waitingOn?: string[];
  thinkTimeoutSec?: number;
}

export interface Observation {
  protocol: 'serpent-v1';
  mode: GameMode;
  status: RoomStatus;
  tick: number;
  tickMs: number;
  width: number;
  height: number;
  wrap: boolean;
  remainingMs: number | null;
  targetScore: number | null;
  you: {
    id: string;
    name: string;
    head: Point | null;
    body: Point[];
    dir: Direction | null;
    alive: boolean;
    score: number;
    kills: number;
  };
  snakes: Array<{
    id: string;
    name: string;
    kind: PlayerKind;
    head: Point | null;
    body: Point[];
    dir: Direction;
    alive: boolean;
    score: number;
  }>;
  foods: Point[];
  legalMoves: Direction[];
  grid: string;
  gameOver: boolean;
  winners: string[];
}

export const DIRECTIONS: Direction[] = ['up', 'down', 'left', 'right'];

export const DELTA: Record<Direction, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export const OPPOSITE: Record<Direction, Direction> = {
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left',
};

export const COLORS = ['#e8c547', '#e23d2a', '#3ecf8e', '#4ea3f0'];

export function pointKey(p: Point): string {
  return `${p.x},${p.y}`;
}

export function pointsEqual(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}
