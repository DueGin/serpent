import os from 'node:os';
import { randomInt } from 'node:crypto';
import type Database from 'better-sqlite3';
import { rate } from 'openskill';
import { getDb } from '../db';
import { AppError, databaseWrite } from '../http';
import { arenaEvents } from '../realtime';
import type * as DTO from '../api-types';
import type { BuiltinBot, MatchConfig } from '../types';
import { mustOwnAgent, ownsAgent, type Principal } from './principal';
import { activeMatchCount, createInternalMatch, waitPendingMatches, type InternalParticipant } from './matches';
import { validateTeamEntry, validateTeamLineup } from './lineups';
import { assertRunning, lifecycle, lifecycleActive, startLifecycle, type Lifecycle } from './lifecycle';
import { waitScriptChecks } from './script-limits';

type Row = Record<string, any>;
const initialMu = 25, initialSigma = 25 / 3;
const benchmarkSeeds = [17, 101, 307, 509, 701, 907, 1201, 1601, 2003, 3001];
const queueTimes = new WeakMap<Database.Database, Map<number, number>>();
const busyEntries = new WeakMap<Database.Database, Set<number>>();
const benchmarkTokens = new WeakMap<Database.Database, Map<number, object>>();
const benchmarkJobs = new WeakMap<Database.Database, Map<number, { versionId: number | undefined; promise: Promise<void> }>>();
const backgroundJobs = new Set<Promise<unknown>>();
function track(job: Promise<unknown>): void { backgroundJobs.add(job); void job.catch(() => {}).finally(() => backgroundJobs.delete(job)); }
export async function waitLadderJobs(): Promise<void> { while (backgroundJobs.size) await Promise.allSettled([...backgroundJobs]); }
function busy(db: Database.Database): Set<number> { let set = busyEntries.get(db); if (!set) { set = new Set(); busyEntries.set(db, set); } return set; }
function ladderRow(slug: string, db = getDb()): Row {
  const row = db.prepare('SELECT * FROM ladders WHERE slug=? AND active=1').get(slug) as Row | undefined;
  if (!row) throw new AppError('NOT_FOUND', '天梯不存在');
  return row;
}
function entryRow(id: number, db = getDb()): Row {
  const row = db.prepare(`SELECT e.*, l.slug, l.kind AS ladder_kind, l.mode, l.teams, l.config_json, l.players_per_match,
    s.name AS script_name, s.archived, s.active_version_id, a.name AS agent_name, a.disabled,
    t.name AS team_name,t.disbanded,t.captain_agent_id FROM ladder_entries e JOIN ladders l ON l.id=e.ladder_id
    LEFT JOIN scripts s ON s.id=e.script_id LEFT JOIN agents a ON a.id=e.agent_id LEFT JOIN teams t ON t.id=e.team_id WHERE e.id=?`).get(id) as Row | undefined;
  if (!row) throw new AppError('NOT_FOUND', '天梯入场记录不存在');
  return row;
}
function orderedEntries(ladderId: number, kind: string, db = getDb()): Row[] {
  const order = kind === 'solo' ? 'coalesce(e.avg_score,-1) DESC,coalesce(e.best_score,-1) DESC,coalesce(e.avg_ticks,1e100) ASC,e.id ASC' : 'e.rating DESC,e.games DESC,e.id ASC';
  return db.prepare(`SELECT e.id FROM ladder_entries e LEFT JOIN agents a ON a.id=e.agent_id LEFT JOIN scripts s ON s.id=e.script_id LEFT JOIN teams t ON t.id=e.team_id
    WHERE e.ladder_id=? AND e.active=1 AND (a.id IS NULL OR a.disabled=0) AND (s.id IS NULL OR s.archived=0) AND (t.id IS NULL OR t.disbanded=0) ORDER BY ${order}`).all(ladderId) as Row[];
}
function toLeaderboard(row: Row, rank: number): DTO.LeaderboardRow {
  const name = row.entrant_type === 'script' ? `${row.agent_name} / ${row.script_name}` : row.entrant_type === 'team' ? row.team_name : row.builtin === 'house' ? '平台陪练队' : `内置 ${row.builtin}`;
  return { rank, entryId: row.id, entrantType: row.entrant_type, name, scriptId: row.script_id, scriptName: row.script_name ?? null,
    agentId: row.agent_id, agentName: row.agent_name ?? null, teamId: row.team_id, teamName: row.team_name ?? null,
    rating: row.rating, mu: row.mu, sigma: row.sigma, games: row.games, wins: row.wins, winRate: row.games ? row.wins / row.games : 0,
    avgScore: row.avg_score, bestScore: row.best_score, lastMatchAt: row.last_match_at };
}
export function entryDTO(entryId: number, db = getDb()): DTO.LadderEntryDTO {
  const row = entryRow(entryId, db);
  const rank = orderedEntries(row.ladder_id, row.ladder_kind, db).findIndex((r) => r.id === row.id) + 1;
  const dto: DTO.LadderEntryDTO = { ...toLeaderboard(row, rank), ladderSlug: row.slug, active: !!row.active, joinedAt: row.joined_at };
  if (row.entrant_type === 'team') dto.lineup = JSON.parse(row.lineup_json || '[]');
  return dto;
}
function authorizeEntry(p: Principal, row: Row): void {
  if (row.entrant_type === 'script') mustOwnAgent(p, row.agent_id);
  else if (row.entrant_type === 'team') mustOwnAgent(p, row.captain_agent_id);
  else throw new AppError('FORBIDDEN', '不能管理平台内置选手');
}
function validScript(scriptId: number, db = getDb()): Row {
  const s = db.prepare(`SELECT s.*,a.disabled,v.status FROM scripts s JOIN agents a ON a.id=s.agent_id LEFT JOIN script_versions v ON v.id=s.active_version_id WHERE s.id=?`).get(scriptId) as Row | undefined;
  if (!s || s.archived || s.disabled) throw new AppError('NOT_FOUND', '参赛脚本不存在或已归档');
  if (s.status !== 'valid') throw new AppError('VALIDATION_ERROR', '参赛脚本必须有检测通过的生效版本');
  return s;
}
function entryLimit(agentId: number, ladderId: number, exceptId?: number): void {
  const n = getDb().prepare('SELECT count(*) AS n FROM ladder_entries WHERE agent_id=? AND ladder_id=? AND active=1 AND id!=?').get(agentId, ladderId, exceptId ?? -1) as Row;
  if (n.n >= 3) throw new AppError('LIMIT_EXCEEDED', '每个 Agent 在同一天梯最多有 3 个入场');
}
async function ladderDTO(row: Row): Promise<DTO.LadderDTO> {
  const matches = getDb().prepare("SELECT count(*) AS n FROM matches WHERE ladder_id=? AND status='done'").get(row.id) as Row;
  return { id: row.id, slug: row.slug, name: row.name, description: row.description, kind: row.kind, mode: row.mode,
    teams: !!row.teams, playersPerMatch: row.players_per_match, entrants: orderedEntries(row.id, row.kind).length,
    matches: matches.n, top: await leaderboard(row.slug, { limit: 3 }) };
}
export async function list(): Promise<DTO.LadderDTO[]> {
  return Promise.all((getDb().prepare('SELECT * FROM ladders WHERE active=1 ORDER BY id').all() as Row[]).map(ladderDTO));
}
export async function get(slug: string): Promise<DTO.LadderDTO> { return ladderDTO(ladderRow(slug)); }
export async function leaderboard(slug: string, filter: { by?: 'entry' | 'agent'; limit?: number } = {}): Promise<DTO.LeaderboardRow[]> {
  const ladder = ladderRow(slug), seen = new Set<number>();
  const rows = orderedEntries(ladder.id, ladder.kind).map(({ id }, i) => toLeaderboard(entryRow(id), i + 1));
  const selected = filter.by === 'agent' ? rows.filter((r) => { if (r.agentId === null) return true; if (seen.has(r.agentId)) return false; seen.add(r.agentId); return true; }).map((r, i) => ({ ...r, rank: i + 1 })) : rows;
  return selected.slice(0, Math.min(1000, Math.max(1, filter.limit ?? 50)));
}
export async function join(p: Principal, slug: string, input: { scriptId: number } | { teamId: number; lineup: [number, number] }): Promise<DTO.LadderEntryDTO> {
  const db = getDb(), ladder = ladderRow(slug), now = Date.now();
  assertRunning(db);
  let id: number;
  if ('scriptId' in input) {
    if (ladder.kind === 'team') throw new AppError('VALIDATION_ERROR', '团队天梯需要队伍与阵容');
    const script = validScript(input.scriptId); mustOwnAgent(p, script.agent_id);
    const existing = db.prepare('SELECT id FROM ladder_entries WHERE ladder_id=? AND script_id=?').get(ladder.id, script.id) as Row | undefined;
    entryLimit(script.agent_id, ladder.id, existing?.id);
    if (existing) { id = existing.id; db.prepare('UPDATE ladder_entries SET active=1,updated_at=? WHERE id=?').run(now, id); }
    else { const info = db.prepare("INSERT INTO ladder_entries(ladder_id,entrant_type,script_id,agent_id,mu,sigma,rating,joined_at,updated_at) VALUES(?,'script',?,?,?,?,?,?,?)").run(ladder.id, script.id, script.agent_id, initialMu, initialSigma, ladder.kind === 'solo' ? 0 : 1000, now, now); id = Number(info.lastInsertRowid); }
  } else {
    if (ladder.kind !== 'team') throw new AppError('VALIDATION_ERROR', '此天梯只接受个人脚本');
    validateTeamLineup(p, input.teamId, input.lineup, db);
    const existing = db.prepare('SELECT id FROM ladder_entries WHERE ladder_id=? AND team_id=?').get(ladder.id, input.teamId) as Row | undefined;
    if (existing) {
      id = existing.id;
      const old = entryRow(id, db), changed = JSON.stringify(input.lineup) !== old.lineup_json;
      const sigma = changed ? Math.max(old.sigma, 5) : old.sigma;
      db.prepare('UPDATE ladder_entries SET active=1,lineup_json=?,sigma=?,rating=?,updated_at=? WHERE id=?')
        .run(JSON.stringify(input.lineup), sigma, Math.round(1000 + 40 * (old.mu - 3 * sigma)), now, id);
    }
    else { const info = db.prepare("INSERT INTO ladder_entries(ladder_id,entrant_type,team_id,lineup_json,joined_at,updated_at) VALUES(?,'team',?,?,?,?)").run(ladder.id, input.teamId, JSON.stringify(input.lineup), now, now); id = Number(info.lastInsertRowid); }
    db.prepare('UPDATE ladder_entries SET authorized_user_id=?,authorized_agent_id=?,inactive_reason=NULL WHERE id=?')
      .run(p.userId, p.kind === 'agent' ? p.agentId : null, id);
  }
  if (ladder.kind === 'solo' && entryRow(id, db).avg_score === null) scheduleBenchmark(id, db);
  arenaEvents.emit('ladder:updated', { slug });
  return entryDTO(id);
}
export async function updateEntry(p: Principal, slug: string, entryId: number, patch: { scriptId?: number; lineup?: [number, number]; active?: boolean }): Promise<DTO.LadderEntryDTO> {
  const row = entryRow(entryId), ladder = ladderRow(slug), db = getDb();
  if (row.ladder_id !== ladder.id) throw new AppError('NOT_FOUND', '入场记录不属于此天梯');
  authorizeEntry(p, row);
  let scriptId = row.script_id, agentId = row.agent_id, lineup = row.lineup_json;
  if (row.entrant_type === 'script') {
    if (patch.lineup !== undefined) throw new AppError('VALIDATION_ERROR', '个人入场不支持团队阵容');
    if (patch.scriptId !== undefined) {
      const s = validScript(patch.scriptId); mustOwnAgent(p, s.agent_id);
      if (s.agent_id !== row.agent_id) throw new AppError('VALIDATION_ERROR', '不能将天梯战绩转移给其他 Agent');
      if (db.prepare('SELECT 1 FROM ladder_entries WHERE ladder_id=? AND script_id=? AND id!=?').get(ladder.id, s.id, row.id)) {
        throw new AppError('CONFLICT', '该脚本已有此天梯的入场记录');
      }
      scriptId = s.id; agentId = s.agent_id;
    }
    if ((patch.active ?? !!row.active)) { validScript(scriptId); entryLimit(agentId, ladder.id, row.id); }
  } else {
    if (patch.scriptId !== undefined) throw new AppError('VALIDATION_ERROR', '团队入场需要更新阵容');
    const selected = patch.lineup ?? JSON.parse(row.lineup_json);
    if (patch.lineup !== undefined || (patch.active ?? !!row.active)) validateTeamLineup(p, row.team_id, selected, db);
    lineup = JSON.stringify(selected);
  }
  const changed = scriptId !== row.script_id || lineup !== row.lineup_json;
  const sigma = changed ? Math.max(row.sigma, 5) : row.sigma;
  const rating = ladder.kind === 'solo' ? row.rating : Math.round(1000 + 40 * (row.mu - 3 * sigma));
  databaseWrite(() => db.prepare('UPDATE ladder_entries SET script_id=?,agent_id=?,lineup_json=?,active=?,sigma=?,rating=?,updated_at=? WHERE id=?')
    .run(scriptId, agentId, lineup, Number(patch.active ?? !!row.active), sigma, rating, Date.now(), entryId));
  if (row.entrant_type === 'team' && (patch.lineup !== undefined || (patch.active ?? !!row.active))) {
    db.prepare('UPDATE ladder_entries SET authorized_user_id=?,authorized_agent_id=?,inactive_reason=NULL WHERE id=?')
      .run(p.userId, p.kind === 'agent' ? p.agentId : null, entryId);
  }
  if (ladder.kind === 'solo' && changed) db.prepare('UPDATE ladder_entries SET avg_score=NULL,best_score=NULL,avg_ticks=NULL,rating=0 WHERE id=?').run(entryId);
  const updated = entryRow(entryId, db);
  if (ladder.kind === 'solo' && updated.active && updated.avg_score === null) scheduleBenchmark(entryId, db);
  arenaEvents.emit('ladder:updated', { slug });
  return entryDTO(entryId);
}
export async function leave(p: Principal, slug: string, entryId: number): Promise<{ ok: true }> {
  await updateEntry(p, slug, entryId, { active: false }); return { ok: true };
}
export async function mine(p: Principal): Promise<DTO.LadderEntryDTO[]> {
  const rows = getDb().prepare('SELECT id FROM ladder_entries WHERE entrant_type!=\'builtin\' ORDER BY id DESC').all() as Row[];
  return rows.map(({ id }) => entryRow(id)).filter((e) => e.entrant_type === 'script' ? ownsAgent(p, e.agent_id) : ownsAgent(p, e.captain_agent_id) || !!getDb().prepare(`SELECT 1 FROM team_members m JOIN agents a ON a.id=m.agent_id WHERE m.team_id=? AND a.user_id=? AND (?='user' OR a.id=?)`).get(e.team_id, p.userId, p.kind, p.kind === 'agent' ? p.agentId : -1)).map((e) => entryDTO(e.id));
}
function eligible(row: Row, db: Database.Database): boolean {
  if (!row.active || row.archived || row.disabled || row.disbanded) return false;
  try {
    if (row.entrant_type === 'script') validScript(row.script_id, db);
    if (row.entrant_type === 'team') {
      validateTeamEntry(row.id, db);
    }
    return true;
  } catch { return false; }
}
function members(row: Row, db: Database.Database): number[] {
  if (row.entrant_type === 'script') return [row.agent_id];
  if (row.entrant_type === 'team') return (db.prepare('SELECT agent_id FROM team_members WHERE team_id=?').all(row.team_id) as Row[]).map((r) => r.agent_id);
  return [];
}
function shuffled<T>(values: T[]): T[] { const a = values.slice(); for (let i = a.length - 1; i > 0; i--) { const j = randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function runnerCapacity(): number { return Math.max(1, Math.min(32, Number(process.env.RUNNER_WORKERS) || Math.min(4, Math.max(1, os.availableParallelism() - 1)))); }
async function scheduleMatch(ladder: Row, requestedId?: number, db = getDb()): Promise<DTO.MatchSummaryDTO> {
  assertRunning(db);
  if (activeMatchCount(db) >= runnerCapacity()) throw new AppError('RATE_LIMITED', '模拟任务池繁忙，请稍后排队');
  let candidates = (db.prepare('SELECT id FROM ladder_entries WHERE ladder_id=? AND active=1 ORDER BY coalesce(last_match_at,0),games,id').all(ladder.id) as Row[])
    .map(({ id }) => entryRow(id, db)).filter((e) => !busy(db).has(e.id) && eligible(e, db));
  const first = requestedId === undefined ? candidates[0] : candidates.find((e) => e.id === requestedId);
  if (!first) throw new AppError('CONFLICT', '入场者不可用或正在比赛');
  const chosen = [first], used = new Set(members(first, db));
  candidates = candidates.filter((e) => e.id !== first.id).sort((a, b) => Math.abs(a.rating - first.rating) - Math.abs(b.rating - first.rating));
  for (const e of shuffled(candidates.slice(0, 12))) {
    if (members(e, db).some((id) => used.has(id))) continue;
    chosen.push(e); for (const id of members(e, db)) used.add(id);
    if (chosen.length === (ladder.kind === 'team' ? 2 : ladder.players_per_match)) break;
  }
  if (chosen.length < 2) throw new AppError('CONFLICT', '暂时没有符合条件的对手');
  const ordered = shuffled(chosen);
  const participants: InternalParticipant[] = [];
  if (ladder.kind === 'team') {
    const slots: InternalParticipant[] = new Array(4);
    ordered.forEach((entry, team) => {
      const lineup = shuffled(JSON.parse(entry.lineup_json) as Array<number | string>);
      lineup.forEach((ref, i) => {
        const base = { ladderEntryId: entry.id, teamId: entry.team_id ?? undefined, team };
        slots[team + i * 2] = typeof ref === 'number' ? { ...base, scriptId: ref, versionId: validScript(ref, db).active_version_id } : { ...base, builtin: ref.replace('builtin:', '') as BuiltinBot };
      });
    });
    participants.push(...slots);
  } else for (const entry of ordered) participants.push(entry.entrant_type === 'script'
    ? { scriptId: entry.script_id, versionId: validScript(entry.script_id, db).active_version_id, ladderEntryId: entry.id }
    : { builtin: entry.builtin, ladderEntryId: entry.id });
  const config: MatchConfig = { ...JSON.parse(ladder.config_json), seed: randomInt(0x100000000), foodCount: Math.max(3, participants.length) };
  for (const e of chosen) busy(db).add(e.id);
  try { return await createInternalMatch({ kind: 'ladder', ladderId: ladder.id, config, participants, wait: true, db }); }
  finally { for (const e of chosen) busy(db).delete(e.id); }
}
export async function queue(p: Principal, slug: string, entryId: number): Promise<DTO.MatchSummaryDTO> {
  const db = getDb(), ladder = ladderRow(slug), entry = entryRow(entryId);
  if (entry.ladder_id !== ladder.id) throw new AppError('NOT_FOUND', '入场记录不属于此天梯');
  authorizeEntry(p, entry);
  if (!eligible(entry, db)) throw new AppError('CONFLICT', '入场者已暂停或阵容不可用');
  let times = queueTimes.get(db); if (!times) { times = new Map(); queueTimes.set(db, times); }
  const previous = times.get(entryId);
  if (previous !== undefined && Date.now() - previous < 15000) throw new AppError('RATE_LIMITED', '手动排队需间隔 15 秒');
  times.set(entryId, Date.now());
  try {
    if (ladder.kind === 'solo') { await runBenchmark(entryId, db); const row = db.prepare('SELECT match_id FROM match_participants WHERE ladder_entry_id=? ORDER BY match_id DESC LIMIT 1').get(entryId) as Row | undefined; if (!row) throw new AppError('INTERNAL', '基准赛未完成'); const { get: getMatch } = await import('./matches'); return getMatch(p, row.match_id); }
    return await scheduleMatch(ladder, entryId, db);
  } catch (err) { if (err instanceof AppError && err.code !== 'RATE_LIMITED') times.delete(entryId); throw err; }
}
export function scriptVersionChanged(scriptId: number): void {
  const db = getDb(), entries = db.prepare('SELECT id,lineup_json,script_id FROM ladder_entries').all() as Row[];
  for (const e of entries) {
    if (e.script_id !== scriptId && !(JSON.parse(e.lineup_json || '[]') as unknown[]).includes(scriptId)) continue;
    db.prepare('UPDATE ladder_entries SET sigma=max(sigma,5),rating=round(1000+40*(mu-3*max(sigma,5))),updated_at=? WHERE id=?').run(Date.now(), e.id);
    const row = entryRow(e.id);
    if (row.ladder_kind === 'solo') {
      db.prepare('UPDATE ladder_entries SET avg_score=NULL,best_score=NULL,avg_ticks=NULL,rating=0 WHERE id=?').run(e.id);
      if (row.active) scheduleBenchmark(e.id, db);
    }
    arenaEvents.emit('ladder:updated', { slug: row.slug });
  }
}
function scheduleBenchmark(entryId: number, db: Database.Database): void {
  track(runBenchmark(entryId, db).catch(() => { console.warn(`[serpent] 单人基准赛未完成 entry=${entryId}`); }));
}
function runBenchmark(entryId: number, db: Database.Database): Promise<void> {
  const generation = lifecycle(db);
  if (!lifecycleActive(db, generation)) return Promise.resolve();
  const entry = entryRow(entryId, db);
  const versionId = entry.entrant_type === 'script' ? validScript(entry.script_id, db).active_version_id as number : undefined;
  let jobs = benchmarkJobs.get(db);
  if (!jobs) { jobs = new Map(); benchmarkJobs.set(db, jobs); }
  const current = jobs.get(entryId);
  if (current && current.versionId === versionId) return current.promise;
  // Bound queued entry work as well as submitted matches; a replacement waits
  // for the prior version's currently running simulation to finish.
  if (current) benchmarkTokens.get(db)?.delete(entryId);
  let promise!: Promise<void>;
  promise = (async () => {
    await (current?.promise.catch(() => {}) ?? Promise.resolve());
    if (lifecycleActive(db, generation) && jobs!.get(entryId)?.promise === promise) await executeBenchmark(entryId, db, generation);
  })().finally(() => {
    if (jobs!.get(entryId)?.promise === promise) jobs!.delete(entryId);
  });
  jobs.set(entryId, { versionId, promise });
  return promise;
}
async function executeBenchmark(entryId: number, db: Database.Database, generation: Lifecycle): Promise<void> {
  if (!lifecycleActive(db, generation)) return;
  const entry = entryRow(entryId, db);
  if (!entry.active || entry.ladder_kind !== 'solo') throw new AppError('CONFLICT', '单人基准入场不可用');
  let tokens = benchmarkTokens.get(db); if (!tokens) { tokens = new Map(); benchmarkTokens.set(db, tokens); }
  const token = {};
  // A new version supersedes queued benchmark results without changing past matches.
  tokens.set(entryId, token);
  const versionId = entry.entrant_type === 'script' ? validScript(entry.script_id, db).active_version_id : undefined;
  const results: Array<{ score: number; ticks: number }> = [];
  try {
    for (const seed of benchmarkSeeds) {
      if (tokens.get(entryId) !== token || !lifecycleActive(db, generation)) return;
      if (!entryRow(entryId, db).active) return;
      if (entry.entrant_type === 'script') { const current = validScript(entry.script_id, db); if (current.active_version_id !== versionId) return; }
      // Do not turn many solo enrollments into an unbounded worker-pool queue.
      while (activeMatchCount(db) >= runnerCapacity()) {
        await new Promise<void>(resolve => setTimeout(resolve, 25));
        if (tokens.get(entryId) !== token || !lifecycleActive(db, generation) || !entryRow(entryId, db).active) return;
      }
      if (tokens.get(entryId) !== token || !lifecycleActive(db, generation)) return;
      const config: MatchConfig = { ...JSON.parse(entry.config_json), seed };
      const match = await createInternalMatch({ kind: 'benchmark', ladderId: entry.ladder_id, config,
        participants: [entry.entrant_type === 'script' ? { scriptId: entry.script_id, versionId, ladderEntryId: entry.id } : { builtin: entry.builtin, ladderEntryId: entry.id }], wait: true, db });
      if (match.status !== 'done') throw new AppError('INTERNAL', '基准赛模拟失败');
      results.push({ score: match.participants[0].score, ticks: match.ticks });
    }
    if (tokens.get(entryId) !== token || !lifecycleActive(db, generation)) return;
    const current = entryRow(entryId, db);
    if (!current.active || (versionId !== undefined && current.active_version_id !== versionId)) return;
    const avgScore = results.reduce((n, r) => n + r.score, 0) / results.length;
    db.prepare('UPDATE ladder_entries SET games=games+?,wins=wins+?,avg_score=?,best_score=?,avg_ticks=?,rating=?,last_match_at=?,updated_at=? WHERE id=?')
      .run(results.length, results.length, avgScore, Math.max(...results.map((r) => r.score)), results.reduce((n, r) => n + r.ticks, 0) / results.length, avgScore, Date.now(), Date.now(), entryId);
    arenaEvents.emit('ladder:updated', { slug: entry.slug });
  } finally { if (tokens.get(entryId) === token) tokens.delete(entryId); }
}
export async function recordMatchResult(matchId: number, db = getDb()): Promise<void> {
  const match = db.prepare("SELECT * FROM matches WHERE id=? AND status='done'").get(matchId) as Row | undefined;
  if (!match || !match.ladder_id || match.kind === 'benchmark') return;
  db.transaction(() => {
    const participants = db.prepare('SELECT * FROM match_participants WHERE match_id=? AND ladder_entry_id IS NOT NULL ORDER BY slot').all(matchId) as Row[];
    if (!participants.length || participants.some((p) => p.rating_before !== null)) return;
    const groups = new Map<number, Row[]>();
    for (const p of participants) { const rows = groups.get(p.ladder_entry_id) ?? []; rows.push(p); groups.set(p.ladder_entry_id, rows); }
    const entries = [...groups.keys()].map((id) => entryRow(id, db));
    const ranks = entries.map((e) => match.teams ? match.winner_team === null ? 1 : groups.get(e.id)![0].team === match.winner_team ? 1 : 2 : Math.min(...groups.get(e.id)!.map((p) => p.rank ?? 1)));
    const updated = rate(entries.map((e) => [{ mu: e.mu, sigma: e.sigma }]), { rank: ranks });
    entries.forEach((entry, i) => {
      const skill = updated[i][0], rating = Math.round(1000 + 40 * (skill.mu - 3 * skill.sigma));
      const players = groups.get(entry.id)!, score = players.reduce((n, p) => n + p.score, 0), games = entry.games + 1;
      const avg = ((entry.avg_score ?? 0) * entry.games + score) / games;
      db.prepare('UPDATE ladder_entries SET mu=?,sigma=?,rating=?,games=?,wins=wins+?,avg_score=?,best_score=?,avg_ticks=?,updated_at=?,last_match_at=? WHERE id=?')
        .run(skill.mu, skill.sigma, rating, games, ranks[i] === Math.min(...ranks) ? 1 : 0, avg, Math.max(entry.best_score ?? 0, score), ((entry.avg_ticks ?? 0) * entry.games + match.ticks) / games, Date.now(), Date.now(), entry.id);
      db.prepare('UPDATE match_participants SET rating_before=?,rating_after=? WHERE match_id=? AND ladder_entry_id=?').run(entry.rating, rating, matchId, entry.id);
    });
  })();
  const row = db.prepare('SELECT slug FROM ladders WHERE id=?').get(match.ladder_id) as Row;
  arenaEvents.emit('ladder:updated', { slug: row.slug });
}
export async function runMatchmakerOnce(): Promise<void> {
  const db = getDb();
  assertRunning(db);
  const ladders = db.prepare("SELECT * FROM ladders WHERE active=1 AND kind!='solo'").all() as Row[];
  await Promise.all(ladders.map(async (ladder) => { try { await scheduleMatch(ladder, undefined, db); } catch (err) { if (!(err instanceof AppError)) console.warn('[serpent] 天梯匹配失败'); } }));
}
export function startMatchmaker(): () => Promise<void> {
  const db = getDb();
  const generation = startLifecycle(db);
  let timer: NodeJS.Timeout | undefined;
  let stopped: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (!stopped) {
      generation.stopping = true;
      if (timer) clearInterval(timer);
      benchmarkTokens.get(db)?.clear();
      stopped = (async () => {
        while (benchmarkJobs.get(db)?.size) {
          await Promise.allSettled([...(benchmarkJobs.get(db)?.values() ?? [])].map(job => job.promise));
        }
        await Promise.all([waitPendingMatches(db), waitScriptChecks(db)]);
      })();
    }
    return stopped;
  };
  if (process.env.LADDER_AUTO === '0') return stop;
  const solos = db.prepare("SELECT e.id FROM ladder_entries e JOIN ladders l ON l.id=e.ladder_id WHERE e.active=1 AND l.kind='solo' AND e.avg_score IS NULL").all() as Row[];
  for (const entry of solos) scheduleBenchmark(entry.id, db);
  let running = false;
  timer = setInterval(() => { if (running || !lifecycleActive(db, generation)) return; running = true; track(runMatchmakerOnce().finally(() => { running = false; })); }, Math.max(100, Number(process.env.LADDER_INTERVAL_MS) || 20000));
  timer.unref();
  return stop;
}
