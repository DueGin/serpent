export type Direction = 'up' | 'down' | 'left' | 'right';
export type GameMode = 'solo' | 'score' | 'battle';
export type BuiltinBot = 'greedy' | 'coward' | 'random';
export type MatchKind = 'test' | 'exhibition' | 'ladder' | 'benchmark';
export type MatchStatus = 'queued' | 'running' | 'done' | 'error';
export type ScriptVisibility = 'private' | 'listed' | 'open';
export type VersionStatus = 'pending' | 'valid' | 'invalid';
export type DeathReason = 'wall' | 'self' | 'snake' | 'head' | 'starve' | 'disqualified';
export type ScriptLanguage = 'javascript' | 'python';
export type Ruleset = 'classic' | 'survival-64' | 'survival';
export const CURRENT_RULESET: Ruleset = 'survival';
export const DEFAULT_MAX_HP = 100;
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
  ruleset: Ruleset;
  maxHp: number | null;
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
  maxHp: number | null;
  you: { id: string; slot: number; team: number | null };
  players: Array<{ id: string; slot: number; name: string; team: number | null }>;
  limits: { moveTimeoutMs: number; initTimeoutMs: number; memoryLimitMB: number };
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
  hp: number | null;
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
  maxHp: number | null;
  you: SnakeView;
  snakes: SnakeView[];
  foods: Point[];
  legalMoves: Direction[];
}

export interface ParticipantInput {
  slot: number;
  name: string;
  team: number | null;
  source: { kind: 'script'; code: string; language?: ScriptLanguage } | { kind: 'builtin'; bot: BuiltinBot };
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
  disqualifications?: Array<{ tick: number; slot: number; phase?: string }>;
}

export type DecisionCode = 'ok' | 'timeout' | 'error' | 'invalid' | 'reverse' | 'builtin';
export interface DecisionTrace { v: 1; codes: string[]; ms: Array<Array<number | null>> }

export interface SimulateResult {
  ticks: number;
  endReason: EndReason;
  winners: number[];
  winnerTeam: number | null;
  participants: ParticipantResult[];
  replay: Replay;
  trace?: DecisionTrace;
  durationMs: number;
}

export interface FrameSnake { slot: number; body: Point[]; dir: Direction; alive: boolean; score: number; length: number; hp: number | null }
export interface FrameEvent { type: 'eat' | 'die' | 'win'; slot?: number; message: string }
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

export interface ScenarioInfo { id: string; title: string; description: string; init: InitInfo; state: ScriptState }
export interface DryRunInput { code: string; language?: ScriptLanguage; scenario?: string; state?: ScriptState; init?: InitInfo }
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
export const DELTA: Record<Direction, Point> = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
export const OPPOSITE: Record<Direction, Direction> = { up: 'down', down: 'up', left: 'right', right: 'left' };
export const pointKey = (point: Point): string => `${point.x},${point.y}`;
export const pointsEqual = (a: Point, b: Point): boolean => a.x === b.x && a.y === b.y;

export interface AgentDTO {
  id: number;
  name: string;
  description: string;
  modelLabel: string;
  color: string;
  userId: number;
  ownerName: string;
  createdAt: number;
  lastSeenAt: number | null;
  keyPrefix?: string;
  team: { id: number; name: string; tag: string } | null;
  stats: { scripts: number; matches: number; wins: number };
}
export interface AgentCreatedDTO extends AgentDTO { apiKey: string }
export interface AgentProfileDTO {
  agent: AgentDTO;
  scripts: ScriptSummaryDTO[];
  ladders: Array<{ slug: string; name: string; bestRating: number; bestRank: number | null; entries: number }>;
  stats: { matches: number; wins: number; winRate: number; avgScore: number; avgMoveMs: number; moves: number; errors: number; timeouts: number };
  recentMatches: MatchSummaryDTO[];
}

export interface ScriptSummaryDTO {
  id: number;
  agentId: number;
  agentName: string;
  name: string;
  description: string;
  language: ScriptLanguage;
  visibility: ScriptVisibility;
  activeVersion: number | null;
  latestVersion: number;
  latestStatus: VersionStatus;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  ladders: Array<{ slug: string; entryId: number; rating: number; rank: number | null; games: number }>;
}
export interface ScriptVersionDTO {
  id: number;
  scriptId: number;
  version: number;
  status: VersionStatus;
  note: string;
  size: number;
  codeHash: string;
  report: CheckReport | null;
  createdAt: number;
  code?: string;
}
export interface ScriptDetailDTO extends ScriptSummaryDTO { versions: ScriptVersionDTO[]; canEdit: boolean; code?: string }

export interface MatchParticipantDTO {
  slot: number;
  name: string;
  color: string;
  team: number | null;
  agentId: number | null;
  agentName: string | null;
  scriptId: number | null;
  scriptName: string | null;
  version: number | null;
  builtin: BuiltinBot | null;
  teamId: number | null;
  teamName: string | null;
  rank: number | null;
  score: number;
  length: number;
  alive: boolean;
  deathTick: number | null;
  deathReason: DeathReason | null;
  kills: number;
  timeouts: number;
  errors: number;
  invalidMoves: number;
  avgMoveMs: number;
  maxMoveMs: number;
  ratingBefore: number | null;
  ratingAfter: number | null;
  firstError?: string;
  logs?: Array<{ tick: number; text: string }>;
}
export interface MatchSummaryDTO {
  id: number;
  kind: MatchKind;
  mode: GameMode;
  teams: boolean;
  ladderSlug: string | null;
  status: MatchStatus;
  seed: number;
  ticks: number;
  endReason: EndReason | null;
  winners: number[];
  winnerTeam: number | null;
  createdAt: number;
  finishedAt: number | null;
  broadcastAt: number | null;
  playbackMs: number;
  live: boolean;
  participants: MatchParticipantDTO[];
}
export interface MatchDetailDTO extends MatchSummaryDTO { config: MatchConfig; error?: string; durationMs?: number }
export interface ReplayDTO {
  matchId: number;
  config: MatchConfig;
  players: Array<{ slot: number; name: string; team: number | null; color: string }>;
  frames: Frame[];
  tickMs: number;
  broadcastAt: number | null;
}
export interface FrameDTO { matchId: number; tick: number; ascii: string; state: ScriptState; review: ReviewTick | null }

export interface ReviewOption { dir: Direction; legal: boolean; death: DeathReason | null; space: number; chosen: boolean }
export interface ReviewTick {
  tick: number;
  slot: number;
  decision: DecisionCode | null;
  moveMs: number | null;
  applied: Direction | null;
  options: ReviewOption[];
}
export interface ReviewSeries {
  slot: number;
  score: number[];
  length: number[];
  alive: Array<0 | 1>;
  hp: Array<number | null>;
  space: number[];
  safeMoves: number[];
  foodDist: Array<number | null>;
  decision: Array<DecisionCode | null>;
  moveMs: Array<number | null>;
  move: Array<Direction | null>;
}
export type ReviewMomentKind = 'eat' | 'death' | 'kill' | 'win' | 'timeout' | 'error' | 'invalid' | 'reverse'
  | 'disqualified' | 'low_space' | 'trapped' | 'risky_move' | 'slow_move' | 'starving';
export interface ReviewMoment { tick: number; slot: number | null; kind: ReviewMomentKind; severity: 'info' | 'warn' | 'critical'; message: string }
export interface ReviewDeath {
  tick: number;
  reason: DeathReason;
  decisionTick: number;
  decision: ReviewTick | null;
  hadSafeAlternative: boolean;
  trappedSince: number | null;
  killerSlot: number | null;
  lastTicks: Array<{ tick: number; space: number; safeMoves: number; move: Direction | null }>;
}
export interface ReviewParticipantStats {
  survivalTicks: number;
  decisions: number;
  ok: number;
  timeouts: number;
  errors: number;
  invalid: number;
  reverses: number;
  avgMoveMs: number | null;
  p95MoveMs: number | null;
  maxMoveMs: number | null;
  foods: number;
  ticksPerFood: number | null;
  avgSpace: number;
  minSpace: number;
  lowSpaceTicks: number;
  riskyMoves: number;
  avgFoodDist: number | null;
  minHp: number | null;
  lowHpTicks: number;
}
export interface ReviewParticipant {
  slot: number;
  name: string;
  color: string;
  team: number | null;
  agentId: number | null;
  scriptId: number | null;
  version: number | null;
  builtin: BuiltinBot | null;
  rank: number | null;
  score: number;
  length: number;
  alive: boolean;
  deathTick: number | null;
  deathReason: DeathReason | null;
  kills: number;
  stats: ReviewParticipantStats;
  death: ReviewDeath | null;
  firstError?: string;
  logs?: Array<{ tick: number; text: string }>;
}
export interface MatchReviewDTO {
  matchId: number;
  kind: MatchKind;
  mode: GameMode;
  teams: boolean;
  ticks: number;
  endReason: EndReason | null;
  winners: number[];
  winnerTeam: number | null;
  config: MatchConfig;
  hasTrace: boolean;
  participants: ReviewParticipant[];
  moments: ReviewMoment[];
  advice: string[];
  series?: ReviewSeries[];
  seriesRange?: { from: number; to: number };
}

export interface ScriptTrendVersion {
  version: number;
  matches: number;
  wins: number;
  winRate: number;
  avgRank: number;
  avgScore: number;
  avgLength: number;
  avgSurvivalTicks: number;
  survivalRate: number;
  deathReasons: Partial<Record<DeathReason, number>>;
  decisions: number;
  timeoutRate: number;
  errorRate: number;
  invalidRate: number;
  avgMoveMs: number;
  maxMoveMs: number;
}
export interface ScriptTrendMatch {
  matchId: number;
  kind: MatchKind;
  mode: GameMode;
  teams: boolean;
  version: number | null;
  players: number;
  rank: number | null;
  score: number;
  length: number;
  alive: boolean;
  deathTick: number | null;
  deathReason: DeathReason | null;
  ticks: number;
  timeouts: number;
  errors: number;
  invalidMoves: number;
  createdAt: number;
}
export interface ScriptTrendDTO { scriptId: number; scriptName: string; mode: GameMode | null; ruleset: Ruleset; versions: ScriptTrendVersion[]; recent: ScriptTrendMatch[] }

export interface LadderDTO {
  id: number;
  slug: string;
  name: string;
  description: string;
  kind: 'solo' | 'individual' | 'team';
  mode: GameMode;
  teams: boolean;
  playersPerMatch: number;
  entrants: number;
  matches: number;
  top: LeaderboardRow[];
}
export interface LeaderboardRow {
  rank: number;
  entryId: number;
  entrantType: 'script' | 'team' | 'builtin';
  name: string;
  scriptId: number | null;
  scriptName: string | null;
  agentId: number | null;
  agentName: string | null;
  teamId: number | null;
  teamName: string | null;
  rating: number;
  mu: number;
  sigma: number;
  games: number;
  wins: number;
  winRate: number;
  avgScore: number | null;
  bestScore: number | null;
  lastMatchAt: number | null;
}
export interface LadderEntryDTO extends LeaderboardRow { ladderSlug: string; active: boolean; lineup?: number[]; joinedAt: number }

export interface TeamDTO {
  id: number;
  name: string;
  tag: string;
  description: string;
  captainAgentId: number;
  members: Array<{ agentId: number; agentName: string; role: 'captain' | 'member'; joinedAt: number }>;
  createdAt: number;
  inviteCode?: string;
  entries: LadderEntryDTO[];
}

export type ParticipantRef = { scriptId: number; version?: number; team?: number } | { builtin: BuiltinBot; team?: number };
export interface CreateMatchInput {
  kind: 'test' | 'exhibition';
  mode: GameMode;
  teams?: boolean;
  participants: ParticipantRef[];
  seed?: number;
  maxTicks?: number;
  wait?: boolean;
  agentId?: number;
}

export interface PlatformStats { agents: number; scripts: number; matches: number; liveMatches: number; pythonAvailable?: boolean }
export interface HealthDTO { ok: boolean; service?: string; python?: { available: boolean; reason?: string } }
export interface DocSummary { name: string; title: string; description?: string }
export interface DocContent { name: string; title: string; markdown: string; content?: string }
