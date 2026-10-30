export type Direction = 'up' | 'down' | 'left' | 'right';
export type GameMode = 'solo' | 'score' | 'battle';
export type BuiltinBot = 'greedy' | 'coward' | 'random';
export type MatchKind = 'test' | 'exhibition' | 'ladder' | 'benchmark';
export type MatchStatus = 'queued' | 'running' | 'done' | 'error';
export type ScriptVisibility = 'private' | 'listed' | 'open';
export type VersionStatus = 'pending' | 'valid' | 'invalid';
export type DeathReason = 'wall' | 'self' | 'snake' | 'head' | 'disqualified';
export type EndReason = 'last_alive' | 'all_dead' | 'max_ticks' | 'target_score';

export interface Point { x: number; y: number }

export interface MatchConfig {
  mode: GameMode;
  teams: boolean;
  width: number;
  height: number;
  wrap: boolean;
  foodCount: number;
  maxTicks: number;
  targetScore: number | null;
  seed: number;
  moveTimeoutMs: number;
  initTimeoutMs: number;
  memoryLimitMB: number;
  matchCpuBudgetMs: number;
}

export interface ParticipantInput {
  slot: number;
  name: string;
  team: number | null;
  source: { kind: 'script'; code: string } | { kind: 'builtin'; bot: BuiltinBot };
}

export interface SimulateInput {
  config: MatchConfig;
  participants: ParticipantInput[];
  captureLogs?: boolean;
}

export interface ParticipantResult {
  slot: number;
  rank: number;
  score: number;
  length: number;
  alive: boolean;
  deathTick: number | null;
  deathReason: DeathReason | null;
  kills: number;
  moves: number;
  timeouts: number;
  errors: number;
  invalidMoves: number;
  avgMoveMs: number;
  maxMoveMs: number;
  cpuMs: number;
  firstError?: string;
  logs?: Array<{ tick: number; text: string }>;
}

export interface Replay {
  v: 1;
  engine: string;
  config: MatchConfig;
  players: Array<{ slot: number; name: string; team: number | null; color: string }>;
  moves: string[];
  /** Disqualification cannot be represented by a direction in moves. */
  disqualifications?: Array<{ tick: number; slot: number; phase?: 'init' | 'move' }>;
}

/** Outcome of one move() decision. Telemetry only: it never changes the simulated game. */
export type DecisionCode = 'ok' | 'timeout' | 'error' | 'invalid' | 'reverse' | 'builtin';

/**
 * Per-round decision telemetry, aligned with frames: codes[t] / ms[t] belong to the
 * decision round that observed frame t (Replay.moves[t] applies it). When a
 * disqualification ends the match, the final round has no matching move.
 * codes[t] has one char per replay player: o=ok t=timeout e=error i=invalid
 * r=reverse b=builtin .=not deciding (dead). ms[t][i] is move() wall time in ms
 * (2 decimals), null for builtin or non-deciding players.
 */
export interface DecisionTrace { v: 1; codes: string[]; ms: Array<Array<number | null>> }

export interface SimulateResult {
  ticks: number;
  endReason: EndReason;
  winners: number[];
  winnerTeam: number | null;
  participants: ParticipantResult[];
  replay: Replay;
  /** Absent only for results produced before decision telemetry existed. */
  trace?: DecisionTrace;
  durationMs: number;
}

export interface FrameSnake {
  slot: number;
  body: Point[];
  dir: Direction;
  alive: boolean;
  score: number;
  length: number;
}
export interface FrameEvent { type: 'eat' | 'die' | 'win'; slot?: number; message: string }
// Tick N includes that tick's disqualifications, before the next engine step.
export interface Frame { tick: number; snakes: FrameSnake[]; foods: Point[]; events: FrameEvent[] }

export type CheckStatus = 'pass' | 'warn' | 'fail';
export interface CheckItem { id: string; label: string; status: CheckStatus; detail?: string }
export interface CheckReport {
  ok: boolean;
  items: CheckItem[];
  stats?: {
    soloAvgScore: number;
    soloAvgTicks: number;
    battleWinRateVsGreedy: number;
    avgMoveMs: number;
    maxMoveMs: number;
  };
  checkedAt: number;
  durationMs: number;
}

export interface SnakeView {
  id: string;
  slot: number;
  name: string;
  team: number | null;
  head: Point | null;
  body: Point[];
  dir: Direction;
  length: number;
  score: number;
  alive: boolean;
}

export interface InitInfo {
  protocol: 'serpent-script-v1';
  mode: GameMode;
  teams: boolean;
  width: number;
  height: number;
  wrap: boolean;
  maxTicks: number;
  targetScore: number | null;
  you: { id: string; slot: number; team: number | null };
  players: Array<{ id: string; slot: number; name: string; team: number | null }>;
  limits: { moveTimeoutMs: number; initTimeoutMs: number; memoryLimitMB: number };
}

export interface ScriptState {
  protocol: 'serpent-script-v1';
  tick: number;
  maxTicks: number;
  remainingTicks: number;
  mode: GameMode;
  teams: boolean;
  width: number;
  height: number;
  wrap: boolean;
  targetScore: number | null;
  you: SnakeView;
  snakes: SnakeView[];
  foods: Point[];
  legalMoves: Direction[];
}

export interface ScenarioInfo {
  id: string;
  title: string;
  description: string;
  init: InitInfo;
  state: ScriptState;
}
export interface DryRunInput { code: string; scenario?: string; state?: ScriptState; init?: InitInfo }
export interface DryRunResult {
  ok: boolean;
  direction: Direction | null;
  raw: unknown;
  legal: boolean;
  logs: string[];
  initMs: number;
  moveMs: number;
  error?: string;
}

export const PLAYBACK_TICK_MS = 120;
export const COLORS = ['#e8c547', '#e23d2a', '#3ecf8e', '#4ea3f0'];
export const DIRECTIONS: Direction[] = ['up', 'down', 'left', 'right'];
export const DELTA: Record<Direction, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};
export const OPPOSITE: Record<Direction, Direction> = {
  up: 'down', down: 'up', left: 'right', right: 'left',
};
export function pointKey(p: Point): string { return `${p.x},${p.y}`; }
export function pointsEqual(a: Point, b: Point): boolean { return a.x === b.x && a.y === b.y; }
