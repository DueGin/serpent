import type Database from 'better-sqlite3';
import { z } from 'zod';
import { getDb } from '../db';
import { sha256 } from '../crypto';
import { AppError, databaseWrite, parseInput, runnerCall, runnerError } from '../http';
import type * as DTO from '../api-types';
import type { CheckReport, DryRunResult, InitInfo, ScenarioInfo, ScriptLanguage, ScriptState, ScriptVisibility } from '../types';
import * as runner from '../runner';
import { mustOwnAgent, ownsAgent, resolveAgent, type Principal } from './principal';
import { entryDTO, scriptVersionChanged } from './ladders';
import { checkDryRunOptions, languageSchema } from './script-input';
import { checkedScriptCall } from './script-limits';
import { assertRunning } from './lifecycle';

export { trend } from './trends';

type Row = Record<string, any>;
const nameSchema = z.string().trim().min(1).max(80);
const textSchema = z.string().max(4000);
const noteSchema = z.string().max(2000);
const visibilitySchema = z.enum(['private', 'listed', 'open']);
export function checkCode(code: string): void {
  if (typeof code !== 'string' || !code.trim()) throw new AppError('VALIDATION_ERROR', '脚本代码不能为空');
  if (Buffer.byteLength(code, 'utf8') > 65536) throw new AppError('LIMIT_EXCEEDED', '脚本不能超过 64KB');
}
export function scriptRow(scriptId: number, db = getDb()): Row {
  const row = db.prepare(`SELECT s.*, a.name AS agent_name, a.disabled AS agent_disabled FROM scripts s JOIN agents a ON a.id=s.agent_id WHERE s.id=?`).get(scriptId) as Row | undefined;
  if (!row || row.agent_disabled) throw new AppError('NOT_FOUND', '脚本不存在');
  return row;
}
function visible(p: Principal | null, row: Row): boolean {
  return ownsAgent(p, row.agent_id) || (row.visibility !== 'private' && !row.archived);
}
function requireVisible(p: Principal | null, row: Row): void {
  if (!visible(p, row)) throw new AppError('NOT_FOUND', '脚本不存在或不可见');
}
function requireEditable(p: Principal, scriptId: number): Row {
  const row = scriptRow(scriptId);
  mustOwnAgent(p, row.agent_id);
  if (row.archived) throw new AppError('CONFLICT', '脚本已归档');
  return row;
}
export function scriptSummaryDTO(scriptId: number): DTO.ScriptSummaryDTO {
  const db = getDb();
  const row = scriptRow(scriptId);
  const latest = row.latest_version_id ? db.prepare('SELECT version,status FROM script_versions WHERE id=?').get(row.latest_version_id) as Row : null;
  const active = row.active_version_id ? db.prepare('SELECT version FROM script_versions WHERE id=?').get(row.active_version_id) as Row : null;
  const entries = db.prepare('SELECT id FROM ladder_entries WHERE script_id=? AND active=1').all(scriptId) as Row[];
  return { id: row.id, agentId: row.agent_id, agentName: row.agent_name, name: row.name, description: row.description,
    language: row.language ?? 'javascript', visibility: row.visibility, activeVersion: active?.version ?? null, latestVersion: latest?.version ?? 0,
    latestStatus: latest?.status ?? 'pending', createdAt: row.created_at, updatedAt: row.updated_at, archived: !!row.archived,
    ladders: entries.map(({ id }) => { const e = entryDTO(id); return { slug: e.ladderSlug, entryId: id, rating: e.rating, rank: e.active ? e.rank : null, games: e.games }; }) };
}
function versionDTO(p: Principal | null, row: Row, v: Row): DTO.ScriptVersionDTO {
  const dto: DTO.ScriptVersionDTO = { id: v.id, scriptId: v.script_id, version: v.version, status: v.status,
    note: v.note, size: v.size, codeHash: v.code_hash, report: v.report_json ? JSON.parse(v.report_json) : null, createdAt: v.created_at };
  if (ownsAgent(p, row.agent_id) || row.visibility === 'open') dto.code = v.code;
  return dto;
}
export async function list(p: Principal, filter: { agentId?: number } = {}): Promise<DTO.ScriptSummaryDTO[]> {
  let rows: Row[];
  const db = getDb();
  if (filter.agentId !== undefined) {
    mustOwnAgent(p, filter.agentId);
    rows = db.prepare('SELECT id FROM scripts WHERE agent_id=? ORDER BY updated_at DESC,id DESC').all(filter.agentId) as Row[];
  } else if (p.kind === 'agent') {
    mustOwnAgent(p, p.agentId);
    rows = db.prepare('SELECT id FROM scripts WHERE agent_id=? ORDER BY updated_at DESC,id DESC').all(p.agentId) as Row[];
  } else {
    rows = db.prepare('SELECT s.id FROM scripts s JOIN agents a ON a.id=s.agent_id WHERE a.user_id=? AND a.disabled=0 ORDER BY s.updated_at DESC,s.id DESC').all(p.userId) as Row[];
  }
  return rows.map((r) => scriptSummaryDTO(r.id));
}
export async function listPublic(filter: { q?: string; limit?: number; agentId?: number } = {}): Promise<DTO.ScriptSummaryDTO[]> {
  const conditions = ["s.visibility!='private'", 's.archived=0', 'a.disabled=0'];
  const args: (number | string)[] = [];
  if (filter.q) { conditions.push("(instr(lower(s.name),lower(?))>0 OR instr(lower(a.name),lower(?))>0)"); args.push(filter.q, filter.q); }
  if (filter.agentId !== undefined) { conditions.push('s.agent_id=?'); args.push(filter.agentId); }
  args.push(Math.max(1, Math.min(1000, filter.limit ?? 50)));
  const rows = getDb().prepare(`SELECT s.id FROM scripts s JOIN agents a ON a.id=s.agent_id WHERE ${conditions.join(' AND ')} ORDER BY s.updated_at DESC,s.id DESC LIMIT ?`).all(...args) as Row[];
  return rows.map((r) => scriptSummaryDTO(r.id));
}
export async function get(p: Principal | null, scriptId: number): Promise<DTO.ScriptDetailDTO> {
  const row = scriptRow(scriptId);
  requireVisible(p, row);
  const versions = getDb().prepare('SELECT * FROM script_versions WHERE script_id=? ORDER BY version DESC').all(scriptId) as Row[];
  const dto: DTO.ScriptDetailDTO = { ...scriptSummaryDTO(scriptId), versions: versions.map((v) => versionDTO(p, row, v)), canEdit: ownsAgent(p, row.agent_id) && !row.archived };
  const selected = versions.find((v) => v.id === row.active_version_id) ?? versions[0];
  if (selected && (ownsAgent(p, row.agent_id) || row.visibility === 'open')) dto.code = selected.code;
  return dto;
}
function enforceVersionQuota(db: Database.Database, agentId: number): void {
  const row = db.prepare('SELECT count(*) AS n FROM script_versions v JOIN scripts s ON s.id=v.script_id WHERE s.agent_id=? AND v.created_at>?').get(agentId, Date.now() - 3600000) as Row;
  if (row.n >= 30) throw new AppError('RATE_LIMITED', '每小时最多提交 30 个脚本版本');
}
function insertVersion(db: Database.Database, scriptId: number, code: string, note: string): number {
  const current = db.prepare('SELECT coalesce(max(version),0)+1 AS n FROM script_versions WHERE script_id=?').get(scriptId) as Row;
  const result = db.prepare(`INSERT INTO script_versions (script_id,version,code,code_hash,size,status,note,created_at) VALUES (?,?,?,?,?,'pending',?,?)`)
    .run(scriptId, current.n, code, sha256(code), Buffer.byteLength(code, 'utf8'), note, Date.now());
  const id = Number(result.lastInsertRowid);
  db.prepare('UPDATE scripts SET latest_version_id=?,updated_at=? WHERE id=?').run(id, Date.now(), scriptId);
  return id;
}
async function checkVersion(db: Database.Database, scriptId: number, id: number, code: string, language: ScriptLanguage, activate: boolean): Promise<void> {
  let report: CheckReport;
  let admissionError: AppError | undefined;
  try { report = await runnerCall(() => runner.validateScript(code, language)); }
  catch (error) {
    admissionError = runnerError(error) ?? (error instanceof AppError && error.code === 'RATE_LIMITED' ? error : undefined);
    report = { ok: false, items: [{ id: 'runner', label: '检测服务', status: 'fail', detail: '检测未能完成，请重新提交版本' }], checkedAt: Date.now(), durationMs: 0 };
  }
  let changed = false;
  db.transaction(() => {
    db.prepare('UPDATE script_versions SET status=?,report_json=? WHERE id=?').run(report.ok ? 'valid' : 'invalid', JSON.stringify(report), id);
    const row = db.prepare('SELECT * FROM scripts WHERE id=?').get(scriptId) as Row;
    // A slower validation must not replace a newer active version.
    if (activate && report.ok && !row.archived && row.latest_version_id === id) {
      db.prepare('UPDATE scripts SET active_version_id=?,updated_at=? WHERE id=?').run(id, Date.now(), scriptId);
      changed = true;
    }
  })();
  if (changed && getDb() === db) scriptVersionChanged(scriptId);
  if (admissionError) throw admissionError;
}
export async function create(p: Principal, input: { agentId?: number; name: string; description?: string; visibility?: ScriptVisibility; language?: ScriptLanguage; code: string; note?: string }): Promise<DTO.ScriptDetailDTO> {
  const name = parseInput(nameSchema, input.name), description = parseInput(textSchema, input.description ?? ''), note = parseInput(noteSchema, input.note ?? '');
  const visibility = parseInput(visibilitySchema, input.visibility ?? 'listed');
  const language = parseInput(languageSchema, input.language ?? 'javascript');
  checkCode(input.code);
  const agent = resolveAgent(p, input.agentId), db = getDb();
  assertRunning(db);
  return checkedScriptCall(db, p, async () => {
    const { scriptId, versionId } = databaseWrite(() => db.transaction(() => {
      const count = db.prepare('SELECT count(*) AS n FROM scripts WHERE agent_id=? AND archived=0').get(agent.id) as Row;
      if (count.n >= 20) throw new AppError('LIMIT_EXCEEDED', '每个 Agent 最多拥有 20 个未归档脚本');
      enforceVersionQuota(db, agent.id);
      const now = Date.now();
      const res = db.prepare('INSERT INTO scripts(agent_id,name,description,visibility,language,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(agent.id, name, description, visibility, language, now, now);
      const scriptId = Number(res.lastInsertRowid);
      return { scriptId, versionId: insertVersion(db, scriptId, input.code, note) };
    })());
    await checkVersion(db, scriptId, versionId, input.code, language, true);
    return get(p, scriptId);
  });
}
export async function addVersion(p: Principal, scriptId: number, input: { code: string; note?: string; activate?: boolean }): Promise<DTO.ScriptVersionDTO> {
  const row = requireEditable(p, scriptId), db = getDb();
  assertRunning(db);
  checkCode(input.code);
  const note = parseInput(noteSchema, input.note ?? '');
  const language = parseInput(languageSchema, row.language ?? 'javascript');
  return checkedScriptCall(db, p, async () => {
    const versionId = db.transaction(() => { enforceVersionQuota(db, row.agent_id); return insertVersion(db, scriptId, input.code, note); })();
    await checkVersion(db, scriptId, versionId, input.code, language, input.activate ?? true);
    const version = db.prepare('SELECT * FROM script_versions WHERE id=?').get(versionId) as Row;
    return versionDTO(p, row, version);
  });
}
export async function update(p: Principal, scriptId: number, patch: { name?: string; description?: string; visibility?: ScriptVisibility; activeVersion?: number }): Promise<DTO.ScriptDetailDTO> {
  const row = requireEditable(p, scriptId), db = getDb();
  let activeId = row.active_version_id;
  if (patch.activeVersion !== undefined) {
    const v = db.prepare("SELECT * FROM script_versions WHERE script_id=? AND version=? AND status='valid'").get(scriptId, patch.activeVersion) as Row | undefined;
    if (!v) throw new AppError('VALIDATION_ERROR', '只能启用检测通过的版本');
    activeId = v.id;
  }
  databaseWrite(() => db.prepare('UPDATE scripts SET name=?,description=?,visibility=?,active_version_id=?,updated_at=? WHERE id=?')
    .run(patch.name === undefined ? row.name : parseInput(nameSchema, patch.name), patch.description === undefined ? row.description : parseInput(textSchema, patch.description),
      patch.visibility === undefined ? row.visibility : parseInput(visibilitySchema, patch.visibility), activeId, Date.now(), scriptId));
  if (activeId !== row.active_version_id) scriptVersionChanged(scriptId);
  return get(p, scriptId);
}
export async function archive(p: Principal, scriptId: number): Promise<{ ok: true }> {
  const row = scriptRow(scriptId); mustOwnAgent(p, row.agent_id);
  const db = getDb();
  db.transaction(() => {
    db.prepare('UPDATE scripts SET archived=1,updated_at=? WHERE id=?').run(Date.now(), scriptId);
    db.prepare('UPDATE ladder_entries SET active=0,updated_at=? WHERE script_id=?').run(Date.now(), scriptId);
    const entries = db.prepare("SELECT id,lineup_json FROM ladder_entries WHERE entrant_type='team' AND active=1").all() as Row[];
    for (const e of entries) if ((JSON.parse(e.lineup_json || '[]') as unknown[]).includes(scriptId)) db.prepare('UPDATE ladder_entries SET active=0,updated_at=? WHERE id=?').run(Date.now(), e.id);
  })();
  return { ok: true };
}
export async function getVersion(p: Principal | null, scriptId: number, version: number): Promise<DTO.ScriptVersionDTO> {
  const row = scriptRow(scriptId); requireVisible(p, row);
  const v = getDb().prepare('SELECT * FROM script_versions WHERE script_id=? AND version=?').get(scriptId, version) as Row | undefined;
  if (!v) throw new AppError('NOT_FOUND', '脚本版本不存在');
  return versionDTO(p, row, v);
}
export async function validate(code: string, p?: Principal, language: ScriptLanguage = 'javascript'): Promise<CheckReport> {
  checkCode(code);
  const checkedLanguage = parseInput(languageSchema, language);
  return checkedScriptCall(getDb(), p, () => runner.validateScript(code, checkedLanguage));
}
export async function dryRun(p: Principal, input: { code?: string; language?: ScriptLanguage; scriptId?: number; version?: number; scenario?: string; state?: ScriptState; init?: InitInfo }): Promise<DryRunResult> {
  const options = checkDryRunOptions(input);
  let code = input.code;
  let language = parseInput(languageSchema, input.language ?? 'javascript');
  let captureLogs = true;
  if (code !== undefined && input.scriptId !== undefined) throw new AppError('VALIDATION_ERROR', 'code 和 scriptId 只能提供一个');
  if (code === undefined) {
    if (input.scriptId === undefined) throw new AppError('VALIDATION_ERROR', '请提供 code 或 scriptId');
    const row = scriptRow(input.scriptId); requireVisible(p, row);
    language = parseInput(languageSchema, row.language ?? 'javascript');
    const owner = ownsAgent(p, row.agent_id);
    if (!owner && row.visibility !== 'open') throw new AppError('FORBIDDEN', '只有所有者可以试跑未公开代码的脚本');
    captureLogs = owner;
    const v = input.version === undefined
      ? getDb().prepare('SELECT code FROM script_versions WHERE id=?').get(row.active_version_id ?? row.latest_version_id) as Row | undefined
      : getDb().prepare('SELECT code FROM script_versions WHERE script_id=? AND version=?').get(row.id, input.version) as Row | undefined;
    if (!v) throw new AppError('NOT_FOUND', '脚本版本不存在');
    code = v.code as string;
  }
  checkCode(code);
  const result = await checkedScriptCall(getDb(), p, () => runner.dryRun({ code, language, ...options }));
  if (!captureLogs) { result.logs = []; delete result.error; }
  return result;
}
export async function scenarios(): Promise<ScenarioInfo[]> { return runner.listScenarios(); }
