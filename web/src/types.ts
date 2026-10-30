export type Direction = 'up' | 'down' | 'left' | 'right';
export type GameMode = 'solo' | 'score' | 'battle';
export type RoomStatus = 'lobby' | 'countdown' | 'running' | 'ended';
export type AgentThinkStatus = 'idle' | 'thinking' | 'done' | 'timeout' | 'error';

export interface AgentThink {
  status: AgentThinkStatus;
  direction?: Direction | null;
  elapsedMs?: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface PublicSnake {
  id: string;
  name: string;
  kind: 'human' | 'agent';
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

export interface GameEvent {
  tick: number;
  type: string;
  playerId?: string;
  message: string;
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

export interface RoomSummary {
  id: string;
  code: string;
  mode: GameMode;
  status: RoomStatus;
  players: number;
  maxPlayers: number;
  hostName?: string;
  names?: string[];
  scores?: { name: string; score: number; alive: boolean }[];
  watchers?: number;
}

export const MODE_META: Record<GameMode, { title: string; en: string; blurb: string }> = {
  solo: { title: '单人跑分', en: 'SOLO', blurb: '吃食物叠高分。撞墙或咬到自己即结束。人类或 Agent 都能打。' },
  score: { title: '多人比分', en: 'SCORE', blurb: '同场抢食物。穿墙、互不伤害，先到目标分或时间到看谁分高。' },
  battle: { title: '多人对战', en: 'BATTLE', blurb: '撞墙、撞自己、撞别人都死。最后活着的赢。' },
};
