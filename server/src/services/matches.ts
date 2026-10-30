import { randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import type Database from 'better-sqlite3';
import { getDb } from '../db';
import { AppError, runnerError } from '../http';
import { arenaEvents } from '../realtime';
import * as runner from '../runner';
import { COLORS, PLAYBACK_TICK_MS } from '../types';
import type { BuiltinBot, DecisionTrace, MatchConfig, MatchKind, ParticipantInput, Replay, ScriptLanguage, SimulateResult } from '../types';
import type * as DTO from '../api-types';
import { buildMatchReview, type MatchReviewAnalysis } from '../game/review';
import { resolveAgent, type Principal } from './principal';
import { validateTeamEntry } from './lineups';
import { assertRunning } from './lifecycle';
import { normalizeConfig, type StoredMatchConfig } from '../runner/config';

type Db = Database.Database;
type MatchRow = {
  id: number; kind: MatchKind; mode: MatchConfig['mode']; teams: number; ladder_id: number | null;
  ladder_slug: string | null; status: DTO.MatchSummaryDTO['status']; seed: number; config_json: string;
  ticks: number; end_reason: DTO.MatchSummaryDTO['endReason']; winners_json: string; winner_team: number | null;
  error: string | null; created_at: number; started_at: number | null; finished_at: number | null;
  broadcast_at: number | null; duration_ms: number; replay_blob?: Buffer | null; trace_blob?: Buffer | null;
};
type ParticipantRow = {
  slot: number; name: string; color: string; team: number | null; agent_id: number | null;
  agent_name: string | null; owner_user_id: number | null; script_id: number | null;
  script_name: string | null; version: number | null; builtin: BuiltinBot | null;
  team_id: number | null; team_name: string | null; rank: number | null; score: number;
  length: number; alive: number; death_tick: number | null; death_reason: DTO.MatchParticipantDTO['deathReason'];
  kills: number; timeouts: number; errors: number; invalid_moves: number; avg_move_ms: number;
  max_move_ms: number; first_error: string | null; logs_json: string; rating_before: number | null;
  rating_after: number | null;
};
type ScriptRow = {
  id: number; agent_id: number; name: string; visibility: string; archived: number; language: ScriptLanguage;
  active_version_id: number | null; agent_name: string; user_id: number; disabled: number;
};
type VersionRow = { id: number; script_id: number; version: number; status: string; code: string };
export type InternalParticipant = {
  name?: string; scriptId?: number; versionId?: number; builtin?: BuiltinBot;
  ladderEntryId?: number; teamId?: number; team?: number;
};
type ResolvedParticipant = {
  input: ParticipantInput; agentId: number | null; scriptId: number | null;
  versionId: number | null; version: number | null; builtin: BuiltinBot | null;
  ladderEntryId: number | null; teamId: number | null;
};
export interface InternalMatchInput {
  kind: 'ladder' | 'benchmark'; ladderId: number; config: MatchConfig;
  participants: InternalParticipant[]; seed?: number; wait?: boolean; db?: Db;
}

const pending = new Map<Db, Map<number, Promise<void>>>();
const reviewCache = new WeakMap<Db, Map<number, MatchReviewAnalysis>>();
const MATCH_SELECT = `SELECT m.*, l.slug AS ladder_slug FROM matches m LEFT JOIN ladders l ON l.id=m.ladder_id`;

function ownAgent(p: Principal | null, agentId: number | null, ownerId: number | null): boolean {
  return !!p && agentId !== null && p.userId === ownerId && (p.kind === 'user' || p.agentId === agentId);
}

function matchRow(db: Db, matchId: number): MatchRow {
  const row = db.prepare(`${MATCH_SELECT} WHERE m.id=?`).get(matchId) as MatchRow | undefined;
  if (!row) throw new AppError('NOT_FOUND', '对局不存在');
  return row;
}

function participantsDTO(db: Db, matchId: number, p: Principal | null): DTO.MatchParticipantDTO[] {
  const rows = db.prepare(`SELECT mp.*, a.name AS agent_name, a.user_id AS owner_user_id,
    s.name AS script_name, t.name AS team_name FROM match_participants mp
    LEFT JOIN agents a ON a.id=mp.agent_id LEFT JOIN scripts s ON s.id=mp.script_id
    LEFT JOIN teams t ON t.id=mp.team_id WHERE mp.match_id=? ORDER BY mp.slot`).all(matchId) as ParticipantRow[];
  return rows.map(row => {
    const dto: DTO.MatchParticipantDTO = {
      slot: row.slot, name: row.name, color: row.color, team: row.team,
      agentId: row.agent_id, agentName: row.agent_name, scriptId: row.script_id, scriptName: row.script_name,
      version: row.version, builtin: row.builtin, teamId: row.team_id, teamName: row.team_name,
      rank: row.rank, score: row.score, length: row.length, alive: !!row.alive,
      deathTick: row.death_tick, deathReason: row.death_reason, kills: row.kills,
      timeouts: row.timeouts, errors: row.errors, invalidMoves: row.invalid_moves,
      avgMoveMs: row.avg_move_ms, maxMoveMs: row.max_move_ms,
      ratingBefore: row.rating_before, ratingAfter: row.rating_after,
    };
    if (ownAgent(p, row.agent_id, row.owner_user_id)) {
      if (row.first_error !== null) dto.firstError = row.first_error;
      dto.logs = JSON.parse(row.logs_json);
    }
    return dto;
  });
}

function summary(db: Db, row: MatchRow, p: Principal | null): DTO.MatchSummaryDTO {
  const playbackMs = row.ticks * PLAYBACK_TICK_MS;
  return {
    id: row.id, kind: row.kind, mode: row.mode, teams: !!row.teams, ladderSlug: row.ladder_slug,
    status: row.status, seed: row.seed, ticks: row.ticks, endReason: row.end_reason,
    winners: JSON.parse(row.winners_json), winnerTeam: row.winner_team,
    createdAt: row.created_at, finishedAt: row.finished_at, broadcastAt: row.broadcast_at, playbackMs,
    live: row.broadcast_at !== null && Date.now() < row.broadcast_at + playbackMs && row.kind !== 'test',
    participants: participantsDTO(db, row.id, p),
  };
}

function detail(db: Db, matchId: number, p: Principal | null): DTO.MatchDetailDTO {
  const row = matchRow(db, matchId);
  return { ...summary(db, row, p), config: normalizeConfig(JSON.parse(row.config_json) as StoredMatchConfig),
    ...(row.error ? { error: row.error } : {}),
    ...(row.finished_at !== null ? { durationMs: row.duration_ms } : {}) };
}

function liveForDb(db: Db): DTO.MatchSummaryDTO[] {
  const rows = db.prepare(`${MATCH_SELECT} WHERE m.kind!='test' AND m.broadcast_at IS NOT NULL
    AND m.broadcast_at + m.ticks * ? > ? ORDER BY m.broadcast_at DESC, m.id DESC LIMIT 100`)
    .all(PLAYBACK_TICK_MS, Date.now()) as MatchRow[];
  return rows.map(row => summary(db, row, null));
}

function validateShape(mode: string, teams: boolean, count: number): void {
  if (!['solo', 'score', 'battle'].includes(mode)) throw new AppError('VALIDATION_ERROR', '不支持的对局模式');
  if (teams && (mode === 'solo' || count !== 4)) throw new AppError('VALIDATION_ERROR', '组队对局必须为四人 2v2，且不能是单人模式');
  if (!teams && (mode === 'solo' ? count !== 1 : count < 2 || count > 4)) {
    throw new AppError('VALIDATION_ERROR', mode === 'solo' ? '单人模式需要一个参赛者' : '多人模式需要二至四个参赛者');
  }
}

function validInteger(value: number | undefined, min: number, max: number, label: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < min || value > max)) {
    throw new AppError('VALIDATION_ERROR', `${label}不合法`);
  }
}

function resolveParticipant(db: Db, ref: InternalParticipant & { version?: number }, slot: number,
  teams: boolean, p: Principal | null, internal: boolean): ResolvedParticipant {
  const team = teams ? slot % 2 : null;
  if (ref.team !== undefined && (ref.team !== team || !teams)) {
    throw new AppError('VALIDATION_ERROR', '队伍必须与参赛位置一致：位置 0、2 为队伍 0，位置 1、3 为队伍 1');
  }
  const base = { ladderEntryId: ref.ladderEntryId ?? null, teamId: ref.teamId ?? null };
  if (ref.builtin !== undefined) {
    if (!['greedy', 'coward', 'random'].includes(ref.builtin) || ref.scriptId !== undefined || ref.versionId !== undefined) {
      throw new AppError('VALIDATION_ERROR', '参赛者只能选择一个脚本或内置对手');
    }
    return { ...base, input: { slot, team, name: ref.name ?? ref.builtin, source: { kind: 'builtin', bot: ref.builtin } },
      agentId: null, scriptId: null, versionId: null, version: null, builtin: ref.builtin };
  }
  let version: VersionRow | undefined;
  if (ref.versionId !== undefined) {
    version = db.prepare('SELECT id,script_id,version,status,code FROM script_versions WHERE id=?').get(ref.versionId) as VersionRow | undefined;
    if (!version || (ref.scriptId !== undefined && version.script_id !== ref.scriptId)) throw new AppError('NOT_FOUND', '脚本版本不存在');
  }
  const scriptId = ref.scriptId ?? version?.script_id;
  if (scriptId === undefined) throw new AppError('VALIDATION_ERROR', '请选择参赛脚本或内置对手');
  const script = db.prepare(`SELECT s.*, a.name AS agent_name, a.user_id, a.disabled
    FROM scripts s JOIN agents a ON a.id=s.agent_id WHERE s.id=?`).get(scriptId) as ScriptRow | undefined;
  if (!script || script.archived || script.disabled) throw new AppError('NOT_FOUND', '参赛脚本不存在或已归档');
  if (!internal && script.visibility === 'private' && !ownAgent(p, script.agent_id, script.user_id)) {
    throw new AppError('FORBIDDEN', '不能使用他人的私有脚本参赛');
  }
  if (!version) {
    version = ref.version !== undefined
      ? db.prepare('SELECT id,script_id,version,status,code FROM script_versions WHERE script_id=? AND version=?').get(script.id, ref.version) as VersionRow | undefined
      : db.prepare('SELECT id,script_id,version,status,code FROM script_versions WHERE id=?').get(script.active_version_id) as VersionRow | undefined;
  }
  if (!version) throw new AppError('NOT_FOUND', '脚本没有可参赛的生效版本');
  if (version.status !== 'valid') throw new AppError('VALIDATION_ERROR', '参赛脚本版本必须通过检测');
  return { ...base,
    input: { slot, team, name: ref.name ?? `${script.agent_name} / ${script.name}`, source: { kind: 'script', code: version.code, language: script.language ?? 'javascript' } },
    agentId: script.agent_id, scriptId: script.id, versionId: version.id, version: version.version, builtin: null };
}

function createRecord(db: Db, input: { kind: MatchKind; config: MatchConfig;
  participants: ResolvedParticipant[]; ladderId?: number; userId?: number; agentId?: number }): number {
  return db.transaction(() => {
    if (input.kind === 'test' && input.agentId !== undefined) {
      const quota = db.prepare(`SELECT count(*) AS total FROM matches WHERE kind='test'
        AND created_by_agent_id=? AND created_at>=?`).get(input.agentId, Date.now() - 3_600_000) as { total: number };
      if (quota.total >= 60) throw new AppError('RATE_LIMITED', '每个 Agent 每小时最多创建 60 局测试赛');
      const active = db.prepare(`SELECT count(*) AS total FROM matches WHERE kind='test'
        AND created_by_agent_id=? AND status IN ('queued','running')`).get(input.agentId) as { total: number };
      if (active.total >= 2) throw new AppError('LIMIT_EXCEEDED', '每个 Agent 同时最多进行两局测试赛');
    }
    // 表演赛同样会占用全局 runner 队列，按发起用户限流，避免一个账号刷满队列。
    if (input.kind === 'exhibition' && input.userId !== undefined) {
      const quota = db.prepare(`SELECT count(*) AS total FROM matches WHERE kind='exhibition'
        AND created_by_user_id=? AND created_at>=?`).get(input.userId, Date.now() - 3_600_000) as { total: number };
      if (quota.total >= 30) throw new AppError('RATE_LIMITED', '每个账号每小时最多创建 30 局表演赛');
      const active = db.prepare(`SELECT count(*) AS total FROM matches WHERE kind='exhibition'
        AND created_by_user_id=? AND status IN ('queued','running')`).get(input.userId) as { total: number };
      if (active.total >= 2) throw new AppError('LIMIT_EXCEEDED', '每个账号同时最多进行两局表演赛');
    }
    const info = db.prepare(`INSERT INTO matches
      (kind,mode,teams,ladder_id,status,seed,config_json,created_by_user_id,created_by_agent_id,created_at)
      VALUES (?,?,?,?,'queued',?,?,?,?,?)`).run(input.kind, input.config.mode, +input.config.teams,
      input.ladderId ?? null, input.config.seed, JSON.stringify(input.config), input.userId ?? null, input.agentId ?? null, Date.now());
    const id = Number(info.lastInsertRowid);
    const insertParticipant = db.prepare(`INSERT INTO match_participants
      (match_id,slot,name,color,team,agent_id,script_id,version_id,version,builtin,ladder_entry_id,team_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const participant of input.participants) {
      insertParticipant.run(id, participant.input.slot, participant.input.name, COLORS[participant.input.slot],
        participant.input.team, participant.agentId, participant.scriptId, participant.versionId,
        participant.version, participant.builtin, participant.ladderEntryId, participant.teamId);
    }
    return id;
  })();
}

function saveResult(db: Db, id: number, kind: MatchKind, result: SimulateResult): void {
  const finishedAt = Date.now();
  const replayBlob = gzipSync(Buffer.from(JSON.stringify(result.replay)));
  const traceBlob = result.trace ? gzipSync(Buffer.from(JSON.stringify(result.trace))) : null;
  db.transaction(() => {
    const update = db.prepare(`UPDATE match_participants SET rank=?,score=?,length=?,alive=?,death_tick=?,
      death_reason=?,kills=?,moves=?,timeouts=?,errors=?,invalid_moves=?,avg_move_ms=?,max_move_ms=?,
      cpu_ms=?,first_error=?,logs_json=? WHERE match_id=? AND slot=?`);
    for (const participant of result.participants) {
      const logs = (participant.logs ?? []).slice(0, 200).map(log => ({ tick: log.tick, text: String(log.text).slice(0, 500) }));
      update.run(participant.rank, participant.score, participant.length, +participant.alive,
        participant.deathTick, participant.deathReason, participant.kills, participant.moves,
        participant.timeouts, participant.errors, participant.invalidMoves, participant.avgMoveMs,
        participant.maxMoveMs, participant.cpuMs, participant.firstError ?? null, JSON.stringify(logs), id, participant.slot);
    }
    db.prepare(`UPDATE matches SET status='done',ticks=?,end_reason=?,winners_json=?,winner_team=?,
      replay_blob=?,trace_blob=?,finished_at=?,broadcast_at=?,duration_ms=? WHERE id=?`).run(result.ticks,
      result.endReason, JSON.stringify(result.winners), result.winnerTeam, replayBlob, traceBlob, finishedAt,
      kind === 'test' ? null : finishedAt, result.durationMs, id);
  })();
}

async function runMatch(db: Db, id: number, kind: MatchKind, config: MatchConfig, participants: ResolvedParticipant[]): Promise<void> {
  try {
    db.prepare("UPDATE matches SET status='running',started_at=? WHERE id=?").run(Date.now(), id);
    const result = await runner.simulate({ config, participants: participants.map(participant => participant.input), captureLogs: true });
    saveResult(db, id, kind, result);
    if (kind === 'ladder' || kind === 'benchmark') {
      const ladders = await import('./ladders');
      await ladders.recordMatchResult(id, db);
    }
  } catch (error) {
    // Worker errors may contain source code or internals; do not expose them publicly.
    if (db.open) db.prepare(`UPDATE matches SET status='error',error=?,finished_at=?,broadcast_at=NULL
      WHERE id=?`).run('对局执行失败，请稍后重试', Date.now(), id);
    const admissionError = runnerError(error);
    if (admissionError) throw admissionError;
    return;
  }
  // Notifications must not turn an already persisted result into an execution failure.
  // Test IDs are intentionally absent from public discovery, including the global socket.
  if (kind !== 'test') {
    try {
      arenaEvents.emit('match:finished', summary(db, matchRow(db, id), null));
      arenaEvents.emit('lobby:live', liveForDb(db));
    } catch { /* Realtime polling will recover missed live-list notifications. */ }
  }
}

function startMatch(db: Db, id: number, kind: MatchKind, config: MatchConfig, participants: ResolvedParticipant[]): Promise<void> {
  let jobs = pending.get(db);
  if (!jobs) { jobs = new Map(); pending.set(db, jobs); }
  const task = runMatch(db, id, kind, config, participants).finally(() => {
    jobs!.delete(id);
    if (!jobs!.size) pending.delete(db);
  });
  jobs.set(id, task);
  void task.catch(() => {});
  return task;
}

export function activeMatchCount(db: Db = getDb()): number { return pending.get(db)?.size ?? 0; }

export async function waitPendingMatches(db?: Db): Promise<void> {
  for (;;) {
    const jobs = db ? [...(pending.get(db)?.values() ?? [])] : [...pending.values()].flatMap(group => [...group.values()]);
    if (!jobs.length) return;
    await Promise.allSettled(jobs);
  }
}

export async function create(p: Principal, input: DTO.CreateMatchInput): Promise<DTO.MatchDetailDTO> {
  const db = getDb();
  assertRunning(db);
  if (!p || !['user', 'agent'].includes(p.kind)) throw new AppError('UNAUTHORIZED', '请先登录');
  if (!['test', 'exhibition'].includes(input.kind)) throw new AppError('VALIDATION_ERROR', '只能创建测试赛或表演赛');
  if (!Array.isArray(input.participants)) throw new AppError('VALIDATION_ERROR', '请提供参赛者');
  validateShape(input.mode, !!input.teams, input.participants.length);
  validInteger(input.seed, 0, 0xffff_ffff, '种子');
  validInteger(input.maxTicks, 1, 10_000, '最大拍数');
  const agent = input.kind === 'test' || input.agentId !== undefined || p.kind === 'agent'
    ? resolveAgent(p, input.agentId) : undefined;
  const participants = input.participants.map((ref, slot) => {
    if ('scriptId' in ref) validInteger(ref.version, 1, Number.MAX_SAFE_INTEGER, '版本');
    return resolveParticipant(db, ref, slot, !!input.teams, p, false);
  });
  if (input.kind === 'test' && !participants.some(participant => participant.agentId === agent!.id)) {
    throw new AppError('FORBIDDEN', '测试赛必须包含当前 Agent 的至少一个脚本');
  }
  const config = runner.defaultConfig(input.mode, { teams: !!input.teams,
    seed: input.seed ?? randomBytes(4).readUInt32LE(), maxTicks: input.maxTicks, players: participants.length });
  const id = createRecord(db, { kind: input.kind, config, participants, userId: p.userId, agentId: agent?.id });
  const task = startMatch(db, id, input.kind, config, participants);
  if (input.wait) await task;
  return detail(db, id, p);
}

export async function createInternalMatch(input: InternalMatchInput): Promise<DTO.MatchDetailDTO> {
  const db = input.db ?? getDb();
  assertRunning(db);
  validateShape(input.config.mode, input.config.teams, input.participants.length);
  validInteger(input.seed, 0, 0xffff_ffff, '种子');
  const config = { ...input.config, seed: input.seed ?? input.config.seed };
  const ladder = db.prepare('SELECT id,mode,teams FROM ladders WHERE id=? AND active=1').get(input.ladderId) as { id: number; mode: string; teams: number } | undefined;
  if (!ladder) throw new AppError('NOT_FOUND', '天梯不存在或已停用');
  if (ladder.mode !== config.mode || !!ladder.teams !== config.teams) throw new AppError('VALIDATION_ERROR', '对局配置与天梯不一致');
  if ((input.kind === 'benchmark') !== (config.mode === 'solo')) throw new AppError('VALIDATION_ERROR', '基准赛只能使用单人模式');
  if (config.teams) {
    const verified = new Map<number, ReturnType<typeof validateTeamEntry>>();
    for (const ref of input.participants) {
      if (ref.builtin !== undefined) continue;
      if (ref.ladderEntryId === undefined) throw new AppError('FORBIDDEN', '团队脚本必须使用已授权的天梯阵容');
      let scripts = verified.get(ref.ladderEntryId);
      if (!scripts) { scripts = validateTeamEntry(ref.ladderEntryId, db); verified.set(ref.ladderEntryId, scripts); }
      const entry = db.prepare('SELECT team_id FROM ladder_entries WHERE id=?').get(ref.ladderEntryId) as { team_id: number };
      if (ref.teamId !== entry.team_id || !scripts.some(script => script.id === ref.scriptId &&
        (ref.versionId === undefined || script.active_version_id === ref.versionId))) {
        throw new AppError('FORBIDDEN', '参赛脚本或版本不属于当前授权阵容');
      }
    }
  }
  const participants = input.participants.map((ref, slot) => resolveParticipant(db, ref, slot, config.teams, null, true));
  for (const participant of participants) {
    if (participant.ladderEntryId !== null) {
      const entry = db.prepare('SELECT ladder_id FROM ladder_entries WHERE id=?').get(participant.ladderEntryId) as { ladder_id: number } | undefined;
      if (!entry || entry.ladder_id !== input.ladderId) throw new AppError('VALIDATION_ERROR', '参赛入场不属于当前天梯');
    }
  }
  const id = createRecord(db, { kind: input.kind, config, participants, ladderId: input.ladderId });
  const task = startMatch(db, id, input.kind, config, participants);
  if (input.wait) await task;
  return detail(db, id, null);
}

export async function list(p: Principal | null, filter: {
  kind?: string; ladder?: string; agentId?: number; scriptId?: number; teamId?: number; limit?: number; before?: number;
} = {}): Promise<DTO.MatchSummaryDTO[]> {
  const db = getDb();
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (p?.kind === 'user') {
    clauses.push(`(m.kind!='test' OR m.created_by_user_id=? OR EXISTS
      (SELECT 1 FROM match_participants v JOIN agents a ON a.id=v.agent_id WHERE v.match_id=m.id AND a.user_id=?))`);
    params.push(p.userId, p.userId);
  } else if (p?.kind === 'agent') {
    clauses.push(`(m.kind!='test' OR m.created_by_agent_id=? OR EXISTS
      (SELECT 1 FROM match_participants v WHERE v.match_id=m.id AND v.agent_id=?))`);
    params.push(p.agentId, p.agentId);
  } else clauses.push("m.kind!='test'");
  if (filter.kind !== undefined) { clauses.push('m.kind=?'); params.push(filter.kind); }
  if (filter.ladder !== undefined) { clauses.push('l.slug=?'); params.push(filter.ladder); }
  if (filter.before !== undefined) { clauses.push('m.id<?'); params.push(filter.before); }
  for (const [key, column] of [['agentId', 'agent_id'], ['scriptId', 'script_id'], ['teamId', 'team_id']] as const) {
    if (filter[key] !== undefined) {
      clauses.push(`EXISTS (SELECT 1 FROM match_participants v WHERE v.match_id=m.id AND v.${column}=?)`);
      params.push(filter[key]);
    }
  }
  const limit = Math.max(1, Math.min(100, Math.floor(filter.limit ?? 30)));
  const rows = db.prepare(`${MATCH_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY m.id DESC LIMIT ?`).all(...params, limit) as MatchRow[];
  return rows.map(row => summary(db, row, p));
}

export async function live(): Promise<DTO.MatchSummaryDTO[]> { return liveForDb(getDb()); }
export async function get(p: Principal | null, matchId: number): Promise<DTO.MatchDetailDTO> { return detail(getDb(), matchId, p); }

function readReplay(db: Db, matchId: number): { row: MatchRow; replay: Replay } {
  const row = matchRow(db, matchId);
  if (row.status !== 'done' || !row.replay_blob) throw new AppError('CONFLICT', row.status === 'error' ? '此对局执行失败，没有回放' : '对局尚未完成，请稍后查看回放');
  const replay = JSON.parse(gunzipSync(row.replay_blob).toString('utf8')) as Omit<Replay, 'config'> & { config: StoredMatchConfig };
  return { row, replay: { ...replay, config: normalizeConfig(replay.config) } };
}

function cachedReview(db: Db, stored: { row: MatchRow; replay: Replay }): MatchReviewAnalysis {
  let cache = reviewCache.get(db);
  if (!cache) { cache = new Map(); reviewCache.set(db, cache); }
  const matchId = stored.row.id;
  const previous = cache.get(matchId);
  if (previous) {
    cache.delete(matchId);
    cache.set(matchId, previous);
    return previous;
  }
  const trace = stored.row.trace_blob
    ? JSON.parse(gunzipSync(stored.row.trace_blob).toString('utf8')) as DecisionTrace : undefined;
  // 只缓存公开分析；每次读取时再按调用者追加所有者字段。
  const analysis = buildMatchReview({ matchId, kind: stored.row.kind, replay: stored.replay, trace,
    participants: participantsDTO(db, matchId, null) });
  cache.set(matchId, analysis);
  if (cache.size > 64) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  return analysis;
}

export interface ReviewOptions { slot?: number; includeSeries?: boolean; from?: number; to?: number }

export async function review(p: Principal | null, matchId: number, opts: ReviewOptions = {}): Promise<DTO.MatchReviewDTO> {
  const db = getDb();
  const stored = readReplay(db, matchId);
  if (opts.slot !== undefined && !stored.replay.players.some(player => player.slot === opts.slot)) {
    throw new AppError('VALIDATION_ERROR', '参赛位置不合法');
  }
  validInteger(opts.from, 0, stored.row.ticks, '起始拍数');
  validInteger(opts.to, 0, stored.row.ticks, '结束拍数');
  const from = opts.from ?? 0, to = opts.to ?? stored.row.ticks;
  if (from > to) throw new AppError('VALIDATION_ERROR', '起始拍数不能大于结束拍数');
  if ((opts.includeSeries || opts.from !== undefined || opts.to !== undefined) && to - from > 5000) {
    throw new AppError('VALIDATION_ERROR', '逐拍序列范围最多跨度 5000 拍，请指定 from 和 to');
  }
  const analysis = cachedReview(db, stored);
  const source = analysis.review;
  const ownerParticipants = participantsDTO(db, matchId, p);
  const participants = source.participants.filter(participant => opts.slot === undefined || participant.slot === opts.slot)
    .map(participant => {
      const copy = structuredClone(participant);
      const owner = ownerParticipants.find(candidate => candidate.slot === participant.slot);
      if (owner?.logs !== undefined) copy.logs = owner.logs;
      if (owner?.firstError !== undefined) copy.firstError = owner.firstError;
      return copy;
    });
  const advice = [...(opts.slot === undefined ? source.advice : analysis.adviceBySlot.get(opts.slot) ?? [])];
  const logAdvice: string[] = [];
  for (const participant of participants) {
    const firstLog = participant.logs?.[0];
    if (firstLog) {
      logAdvice.push(`${participant.name} 在第 ${firstLog.tick} 拍附近有 ${participant.logs?.length ?? 0} 行日志，可结合该拍的选项检查决策。`);
    }
  }
  const { series: _series, seriesRange: _seriesRange, ...base } = source;
  const result: DTO.MatchReviewDTO = { ...base, config: { ...base.config }, winners: [...base.winners], participants,
    moments: source.moments.filter(moment => opts.slot === undefined || moment.slot === opts.slot).map(moment => ({ ...moment })),
    advice: [...advice.slice(0, 8 - logAdvice.length), ...logAdvice] };
  if (opts.includeSeries) {
    result.seriesRange = { from, to };
    result.series = (source.series ?? []).filter(series => opts.slot === undefined || series.slot === opts.slot)
      .map(series => ({ slot: series.slot, score: series.score.slice(from, to + 1), length: series.length.slice(from, to + 1),
        alive: series.alive.slice(from, to + 1), hp: series.hp.slice(from, to + 1), space: series.space.slice(from, to + 1), safeMoves: series.safeMoves.slice(from, to + 1),
        foodDist: series.foodDist.slice(from, to + 1), decision: series.decision.slice(from, to + 1),
        moveMs: series.moveMs.slice(from, to + 1), move: series.move.slice(from, to + 1) }));
  }
  return result;
}

export async function replay(matchId: number): Promise<DTO.ReplayDTO> {
  const stored = readReplay(getDb(), matchId);
  return { matchId, config: stored.replay.config, players: stored.replay.players,
    frames: runner.replayFrames(stored.replay), tickMs: PLAYBACK_TICK_MS, broadcastAt: stored.row.broadcast_at };
}

export async function frame(_p: Principal | null, matchId: number, tick: number, viewerSlot = 0): Promise<DTO.FrameDTO> {
  const db = getDb();
  const stored = readReplay(db, matchId);
  validInteger(tick, 0, stored.row.ticks, '拍数');
  validInteger(viewerSlot, 0, stored.replay.players.length - 1, '观察位置');
  const tickReview = cachedReview(db, stored).reviewTicks.get(viewerSlot)?.[tick] ?? null;
  return { matchId, tick, ...runner.frameState(stored.replay, tick, viewerSlot), review: structuredClone(tickReview) };
}

export async function platformStats(): Promise<{ agents: number; scripts: number; matches: number; liveMatches: number }> {
  const db = getDb();
  return db.prepare(`SELECT
    (SELECT count(*) FROM agents WHERE disabled=0) AS agents,
    (SELECT count(*) FROM scripts s JOIN agents a ON a.id=s.agent_id WHERE s.archived=0 AND s.visibility!='private' AND a.disabled=0) AS scripts,
    (SELECT count(*) FROM matches WHERE kind!='test') AS matches,
    (SELECT count(*) FROM matches WHERE kind!='test' AND broadcast_at IS NOT NULL AND broadcast_at + ticks * ? > ?) AS liveMatches`)
    .get(PLAYBACK_TICK_MS, Date.now()) as { agents: number; scripts: number; matches: number; liveMatches: number };
}
