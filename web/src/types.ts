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
  disqualifications?: Array<{ tick: number; slot: number; phase?: string }>;
}

export interface SimulateResult {
  ticks: number;
  endReason: EndReason;
  winners: number[];
  winnerTeam: number | null;
  participants: ParticipantResult[];
  replay: Replay;
  durationMs: number;
}

export interface FrameSnake { slot: number; body: Point[]; dir: Direction; alive: boolean; score: number; length: number }
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
export interface FrameDTO { matchId: number; tick: number; ascii: string; state: ScriptState }

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

export interface PlatformStats { agents: number; scripts: number; matches: number; liveMatches: number }
export interface DocSummary { name: string; title: string; description?: string }
export interface DocContent { name: string; title: string; markdown: string; content?: string }
