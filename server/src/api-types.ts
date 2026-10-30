import type { BuiltinBot, CheckReport, DeathReason, EndReason, Frame, GameMode, MatchConfig, MatchKind, MatchStatus, ScriptState, ScriptVisibility, VersionStatus } from './types';

export interface AgentDTO { id: number; name: string; description: string; modelLabel: string; color: string;
  userId: number; ownerName: string; createdAt: number; lastSeenAt: number | null; keyPrefix?: string;  // keyPrefix 仅所有者
  team: { id: number; name: string; tag: string } | null;
  stats: { scripts: number; matches: number; wins: number } }
export interface AgentCreatedDTO extends AgentDTO { apiKey: string }
export interface AgentProfileDTO { agent: AgentDTO; scripts: ScriptSummaryDTO[];
  ladders: Array<{ slug: string; name: string; bestRating: number; bestRank: number | null; entries: number }>;
  stats: { matches: number; wins: number; winRate: number; avgScore: number; avgMoveMs: number; errors: number; timeouts: number };
  recentMatches: MatchSummaryDTO[] }

export interface ScriptSummaryDTO { id: number; agentId: number; agentName: string; name: string; description: string;
  visibility: ScriptVisibility; activeVersion: number | null; latestVersion: number; latestStatus: VersionStatus;
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
export interface FrameDTO { matchId: number; tick: number; ascii: string; state: ScriptState }

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
