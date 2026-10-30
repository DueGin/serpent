import { getDb } from '../db';
import { AppError } from '../http';
import type { ScriptTrendDTO, ScriptTrendMatch, ScriptTrendVersion } from '../api-types';
import { CURRENT_RULESET, type GameMode } from '../types';
import { ownsAgent, type Principal } from './principal';

interface ScriptRow { id: number; agent_id: number; name: string; visibility: string; archived: number; disabled: number }
interface TrendRow extends ScriptTrendMatch { moves: number; avgMoveMs: number; maxMoveMs: number }

export async function trend(p: Principal | null, scriptId: number, opts: { mode?: GameMode; limit?: number } = {}): Promise<ScriptTrendDTO> {
  const db = getDb();
  const script = db.prepare(`SELECT s.id,s.agent_id,s.name,s.visibility,s.archived,a.disabled
    FROM scripts s JOIN agents a ON a.id=s.agent_id WHERE s.id=?`).get(scriptId) as ScriptRow | undefined;
  if (!script || script.disabled) throw new AppError('NOT_FOUND', '脚本不存在');
  const owner = ownsAgent(p, script.agent_id);
  if (!owner && (script.visibility === 'private' || script.archived)) throw new AppError('NOT_FOUND', '脚本不存在或不可见');
  if (opts.mode !== undefined && !['solo', 'score', 'battle'].includes(opts.mode)) {
    throw new AppError('VALIDATION_ERROR', '对局模式不合法');
  }
  const limit = opts.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new AppError('VALIDATION_ERROR', '趋势窗口必须为 1 至 200 场');
  // 一个脚本可占多个位置，趋势窗口按对局计数，以最小 slot 的参赛结果代表该局。
  const conditions = ['mp.script_id=?', "m.status='done'", `mp.slot=(SELECT min(other.slot)
    FROM match_participants other WHERE other.match_id=m.id AND other.script_id=mp.script_id)`];
  const args: Array<string | number> = [scriptId];
  if (!owner) conditions.push("m.kind!='test'");
  if (opts.mode !== undefined) { conditions.push('m.mode=?'); args.push(opts.mode); }
  const rows = db.prepare(`SELECT m.id AS matchId,m.kind,m.mode,m.teams,mp.version,
    (SELECT count(*) FROM match_participants players WHERE players.match_id=m.id) AS players,
    mp.rank,mp.score,mp.length,mp.alive,mp.death_tick AS deathTick,mp.death_reason AS deathReason,
    m.ticks,mp.timeouts,mp.errors,mp.invalid_moves AS invalidMoves,m.created_at AS createdAt,
    mp.moves,mp.avg_move_ms AS avgMoveMs,mp.max_move_ms AS maxMoveMs
    FROM match_participants mp JOIN matches m ON m.id=mp.match_id
    WHERE ${conditions.join(' AND ')} ORDER BY m.id DESC,mp.slot ASC LIMIT ?`).all(...args, limit) as Array<Omit<TrendRow, 'teams' | 'alive'> & { teams: number; alive: number }>;
  const groups = new Map<number, TrendRow[]>();
  const recent: ScriptTrendMatch[] = [];
  for (const row of rows) {
    const converted: TrendRow = { ...row, teams: !!row.teams, alive: !!row.alive };
    const { moves: _moves, avgMoveMs: _avgMoveMs, maxMoveMs: _maxMoveMs, ...match } = converted;
    recent.push(match);
    if (converted.version !== null) {
      const group = groups.get(converted.version) ?? [];
      group.push(converted);
      groups.set(converted.version, group);
    }
  }
  const versions = [...groups].sort(([a], [b]) => b - a).map(([version, matches]): ScriptTrendVersion => {
    const count = matches.length;
    const sum = (value: (row: TrendRow) => number): number => matches.reduce((total, row) => total + value(row), 0);
    const wins = sum(row => Number(row.rank === 1));
    const decisions = sum(row => row.moves);
    const ranked = matches.filter(row => row.rank !== null);
    const deathReasons: ScriptTrendVersion['deathReasons'] = {};
    for (const row of matches) if (row.deathReason !== null) deathReasons[row.deathReason] = (deathReasons[row.deathReason] ?? 0) + 1;
    return { version, matches: count, wins, winRate: wins / count,
      avgRank: ranked.length ? ranked.reduce((total, row) => total + (row.rank ?? 0), 0) / ranked.length : 0,
      avgScore: sum(row => row.score) / count, avgLength: sum(row => row.length) / count,
      avgSurvivalTicks: sum(row => row.deathTick ?? row.ticks) / count,
      survivalRate: sum(row => Number(row.alive)) / count, deathReasons, decisions,
      timeoutRate: decisions ? sum(row => row.timeouts) / decisions : 0,
      errorRate: decisions ? sum(row => row.errors) / decisions : 0,
      invalidRate: decisions ? sum(row => row.invalidMoves) / decisions : 0,
      avgMoveMs: decisions ? sum(row => row.avgMoveMs * row.moves) / decisions : 0,
      maxMoveMs: Math.max(...matches.map(row => row.maxMoveMs)) };
  });
  // 脚手架：按规则集过滤由规则实现补上，目前只声明当前规则集。
  return { scriptId, scriptName: script.name, mode: opts.mode ?? null, ruleset: CURRENT_RULESET, versions, recent };
}
