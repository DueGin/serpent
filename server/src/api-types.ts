import type { BuiltinBot, CheckReport, DeathReason, DecisionCode, Direction, EndReason, Frame, GameMode, MatchConfig, MatchKind, MatchStatus, Ruleset, ScriptLanguage, ScriptState, ScriptVisibility, VersionStatus } from './types';

export interface AgentDTO { id: number; name: string; description: string; modelLabel: string; color: string;
  userId: number; ownerName: string; createdAt: number; lastSeenAt: number | null; keyPrefix?: string;  // keyPrefix 仅所有者
  team: { id: number; name: string; tag: string } | null;
  stats: { scripts: number; matches: number; wins: number } }
export interface AgentCreatedDTO extends AgentDTO { apiKey: string }
export interface AgentProfileDTO { agent: AgentDTO; scripts: ScriptSummaryDTO[];
  ladders: Array<{ slug: string; name: string; bestRating: number; bestRank: number | null; entries: number }>;
  stats: { matches: number; wins: number; winRate: number; avgScore: number; avgMoveMs: number; errors: number; timeouts: number; moves: number };
  recentMatches: MatchSummaryDTO[] }

export interface ScriptSummaryDTO { id: number; agentId: number; agentName: string; name: string; description: string;
  language: ScriptLanguage; visibility: ScriptVisibility; activeVersion: number | null; latestVersion: number; latestStatus: VersionStatus;
  createdAt: number; updatedAt: number; archived: boolean;
  ladders: Array<{ slug: string; entryId: number; rating: number; rank: number | null; games: number }> }
export interface ScriptVersionDTO { id: number; scriptId: number; version: number; status: VersionStatus; note: string;
  size: number; codeHash: string; report: CheckReport | null; createdAt: number; code?: string }
export interface ScriptDetailDTO extends ScriptSummaryDTO { versions: ScriptVersionDTO[]; canEdit: boolean; code?: string }

export interface MatchParticipantDTO { slot: number; name: string; color: string; team: number | null;
  agentId: number | null; agentName: string | null; scriptId: number | null; scriptName: string | null;
  version: number | null; builtin: BuiltinBot | null; teamId: number | null; teamName: string | null;
  rank: number | null; score: number; length: number; alive: boolean; deathTick: number | null;
  deathReason: DeathReason | null; kills: number; timeouts: number; errors: number; invalidMoves: number;
  avgMoveMs: number; maxMoveMs: number; ratingBefore: number | null; ratingAfter: number | null;
  firstError?: string; logs?: Array<{ tick: number; text: string }> }   // 后两项仅所有者
export interface MatchSummaryDTO { id: number; kind: MatchKind; mode: GameMode; teams: boolean;
  ladderSlug: string | null; status: MatchStatus; seed: number; ticks: number; endReason: EndReason | null;
  winners: number[]; winnerTeam: number | null; createdAt: number; finishedAt: number | null;
  broadcastAt: number | null; playbackMs: number; live: boolean; participants: MatchParticipantDTO[] }
export interface MatchDetailDTO extends MatchSummaryDTO { config: MatchConfig; error?: string; durationMs?: number }
export interface ReplayDTO { matchId: number; config: MatchConfig;
  players: Array<{ slot: number; name: string; team: number | null; color: string }>;
  frames: Frame[]; tickMs: number; broadcastAt: number | null }
export interface FrameDTO { matchId: number; tick: number; ascii: string; state: ScriptState;
  review: ReviewTick | null }   // viewer 在该拍的决策与反事实分析；该拍无决策（已死/已结束）为 null

/** 复盘：反事实地把某一拍的方向换成 dir（其他蛇保持实际走法）推演一步的结果。 */
export interface ReviewOption { dir: Direction; legal: boolean; death: DeathReason | null; space: number; chosen: boolean }
export interface ReviewTick { tick: number; slot: number; decision: DecisionCode | null; moveMs: number | null;
  applied: Direction | null; options: ReviewOption[] }
/** 列式逐拍序列：下标 i 即第 i 帧，长度为 to - from + 1（见 MatchReviewDTO.seriesRange）。 */
export interface ReviewSeries { slot: number; score: number[]; length: number[]; alive: Array<0 | 1>; hp: Array<number | null>;
  space: number[]; safeMoves: number[]; foodDist: Array<number | null>;
  decision: Array<DecisionCode | null>; moveMs: Array<number | null>; move: Array<Direction | null> }
export type ReviewMomentKind = 'eat' | 'death' | 'kill' | 'win' | 'timeout' | 'error' | 'invalid' | 'reverse'
  | 'disqualified' | 'low_space' | 'trapped' | 'risky_move' | 'slow_move' | 'starving';
export interface ReviewMoment { tick: number; slot: number | null; kind: ReviewMomentKind;
  severity: 'info' | 'warn' | 'critical'; message: string }
export interface ReviewDeath { tick: number; reason: DeathReason; decisionTick: number; decision: ReviewTick | null;
  hadSafeAlternative: boolean; trappedSince: number | null; killerSlot: number | null;
  lastTicks: Array<{ tick: number; space: number; safeMoves: number; move: Direction | null }> }
export interface ReviewParticipantStats { survivalTicks: number; decisions: number; ok: number; timeouts: number;
  errors: number; invalid: number; reverses: number; avgMoveMs: number | null; p95MoveMs: number | null;
  maxMoveMs: number | null; foods: number; ticksPerFood: number | null; avgSpace: number; minSpace: number;
  lowSpaceTicks: number; riskyMoves: number; avgFoodDist: number | null;
  minHp: number | null; lowHpTicks: number }   // lowHpTicks：存活且 hp ≤ 25 的帧数；classic 为 null / 0
export interface ReviewParticipant { slot: number; name: string; color: string; team: number | null;
  agentId: number | null; scriptId: number | null; version: number | null; builtin: BuiltinBot | null;
  rank: number | null; score: number; length: number; alive: boolean; deathTick: number | null;
  deathReason: DeathReason | null; kills: number; stats: ReviewParticipantStats; death: ReviewDeath | null;
  firstError?: string; logs?: Array<{ tick: number; text: string }> }   // 后两项仅所有者
export interface MatchReviewDTO { matchId: number; kind: MatchKind; mode: GameMode; teams: boolean; ticks: number;
  endReason: EndReason | null; winners: number[]; winnerTeam: number | null; config: MatchConfig;
  hasTrace: boolean;            // 旧对局没有逐拍决策遥测，decision/moveMs 全为 null
  participants: ReviewParticipant[]; moments: ReviewMoment[]; advice: string[];
  series?: ReviewSeries[]; seriesRange?: { from: number; to: number } }

export interface ScriptTrendVersion { version: number; matches: number; wins: number; winRate: number; avgRank: number;
  avgScore: number; avgLength: number; avgSurvivalTicks: number; survivalRate: number;
  deathReasons: Partial<Record<DeathReason, number>>; decisions: number; timeoutRate: number; errorRate: number;
  invalidRate: number; avgMoveMs: number; maxMoveMs: number }
export interface ScriptTrendMatch { matchId: number; kind: MatchKind; mode: GameMode; teams: boolean; version: number | null;
  players: number; rank: number | null; score: number; length: number; alive: boolean; deathTick: number | null;
  deathReason: DeathReason | null; ticks: number; timeouts: number; errors: number; invalidMoves: number; createdAt: number }
export interface ScriptTrendDTO { scriptId: number; scriptName: string; mode: GameMode | null;
  ruleset: Ruleset;   // 只统计该规则集的对局（当前规则）
  versions: ScriptTrendVersion[]; recent: ScriptTrendMatch[] }

export interface LadderDTO { id: number; slug: string; name: string; description: string;
  kind: 'solo' | 'individual' | 'team'; mode: GameMode; teams: boolean; playersPerMatch: number;
  entrants: number; matches: number; top: LeaderboardRow[] }
export interface LeaderboardRow { rank: number; entryId: number; entrantType: 'script' | 'team' | 'builtin'; name: string;
  scriptId: number | null; scriptName: string | null; agentId: number | null; agentName: string | null;
  teamId: number | null; teamName: string | null; rating: number; mu: number; sigma: number;
  games: number; wins: number; winRate: number; avgScore: number | null; bestScore: number | null;
  lastMatchAt: number | null }
export interface LadderEntryDTO extends LeaderboardRow { ladderSlug: string; active: boolean; lineup?: number[]; joinedAt: number }

export interface TeamDTO { id: number; name: string; tag: string; description: string; captainAgentId: number;
  members: Array<{ agentId: number; agentName: string; role: 'captain' | 'member'; joinedAt: number }>;
  createdAt: number; inviteCode?: string;            // 仅成员/成员的所有者
  entries: LadderEntryDTO[] }

export type ParticipantRef = { scriptId: number; version?: number; team?: number } | { builtin: BuiltinBot; team?: number };
export interface CreateMatchInput { kind: 'test' | 'exhibition'; mode: GameMode; teams?: boolean; participants: ParticipantRef[]; seed?: number; maxTicks?: number; wait?: boolean; agentId?: number }
