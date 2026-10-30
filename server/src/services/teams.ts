import { z, type ZodType } from 'zod';
import type * as DTO from '../api-types';
import { getDb, type TeamRow } from '../db';
import { newInviteCode } from '../crypto';
import { AppError } from '../http';
import { ownsAgent, resolveAgent, type Principal } from './principal';
import * as laddersSvc from './ladders';

const teamPatch = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  tag: z.string().trim().max(12).optional(),
  description: z.string().trim().max(4000).optional(),
});

function parse<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new AppError('VALIDATION_ERROR', result.error.issues[0]?.message || '队伍信息不合法');
  return result.data;
}

function row(teamId: number): TeamRow {
  const team = getDb().prepare('SELECT * FROM teams WHERE id=? AND disbanded=0').get(teamId) as TeamRow | undefined;
  if (!team) throw new AppError('NOT_FOUND', '队伍不存在或已解散');
  return team;
}

export function mustCaptain(p: Principal, teamId: number): TeamRow {
  const team = row(teamId);
  if (!ownsAgent(p, team.captain_agent_id)) throw new AppError('FORBIDDEN', '只有队长可以执行此操作');
  return team;
}

function teamDTO(p: Principal | null, teamId: number): DTO.TeamDTO {
  const team = row(teamId);
  const members = getDb().prepare(`SELECT m.agent_id AS agentId,a.name AS agentName,m.role,m.joined_at AS joinedAt
    FROM team_members m JOIN agents a ON a.id=m.agent_id WHERE m.team_id=?
    ORDER BY CASE m.role WHEN 'captain' THEN 0 ELSE 1 END,m.joined_at,m.agent_id`).all(teamId) as DTO.TeamDTO['members'];
  const entryIds = getDb().prepare('SELECT id FROM ladder_entries WHERE team_id=? ORDER BY id').all(teamId) as Array<{ id: number }>;
  return {
    id: team.id, name: team.name, tag: team.tag, description: team.description,
    captainAgentId: team.captain_agent_id, members, createdAt: team.created_at,
    ...(members.some((member) => ownsAgent(p, member.agentId)) ? { inviteCode: team.invite_code } : {}),
    entries: entryIds.map((entry) => laddersSvc.entryDTO(entry.id)),
  };
}

function uniqueError(err: unknown): never {
  if ((err as { code?: string })?.code?.startsWith('SQLITE_CONSTRAINT_UNIQUE')) {
    throw new AppError('CONFLICT', '队伍名称已被使用，或 Agent 已加入其他队伍');
  }
  throw err;
}

// Call inside a transaction: rosters cannot keep competing after losing a member.
export function unlinkAgentFromTeam(agentId: number): void {
  const membership = getDb().prepare('SELECT team_id,role FROM team_members WHERE agent_id=?').get(agentId) as
    { team_id: number; role: 'captain' | 'member' } | undefined;
  if (!membership) return;
  const teamId = membership.team_id;
  getDb().prepare('DELETE FROM team_members WHERE team_id=? AND agent_id=?').run(teamId, agentId);
  const next = getDb().prepare('SELECT agent_id FROM team_members WHERE team_id=? ORDER BY joined_at,agent_id LIMIT 1')
    .get(teamId) as { agent_id: number } | undefined;
  const now = Date.now();
  if (!next) {
    getDb().prepare('UPDATE teams SET disbanded=1,invite_code=? WHERE id=?').run(newInviteCode(), teamId);
    getDb().prepare('UPDATE ladder_entries SET active=0,updated_at=? WHERE team_id=?').run(now, teamId);
    return;
  }
  if (membership.role === 'captain') {
    getDb().prepare("UPDATE team_members SET role='captain' WHERE team_id=? AND agent_id=?").run(teamId, next.agent_id);
    getDb().prepare('UPDATE teams SET captain_agent_id=? WHERE id=?').run(next.agent_id, teamId);
  }
  const entries = getDb().prepare('SELECT id,lineup_json FROM ladder_entries WHERE team_id=?').all(teamId) as
    Array<{ id: number; lineup_json: string | null }>;
  const owner = getDb().prepare('SELECT id FROM scripts WHERE agent_id=?').all(agentId) as Array<{ id: number }>;
  const scriptIds = new Set(owner.map((script) => script.id));
  for (const entry of entries) {
    let lineup: unknown;
    try { lineup = JSON.parse(entry.lineup_json || '[]'); } catch { lineup = []; }
    if (!Array.isArray(lineup) || lineup.some((id) => scriptIds.has(Number(id)))) {
      getDb().prepare('UPDATE ladder_entries SET active=0,updated_at=? WHERE id=?').run(now, entry.id);
    }
  }
}

export async function list(): Promise<DTO.TeamDTO[]> {
  const ids = getDb().prepare('SELECT id FROM teams WHERE disbanded=0 ORDER BY created_at DESC,id DESC').all() as Array<{ id: number }>;
  return ids.map((team) => teamDTO(null, team.id));
}

export async function get(p: Principal | null, teamId: number): Promise<DTO.TeamDTO> {
  return teamDTO(p, teamId);
}

export async function create(p: Principal, input: { agentId?: number; name: string; tag?: string; description?: string }): Promise<DTO.TeamDTO> {
  const parsed = parse(teamPatch.extend({ name: z.string().trim().min(1).max(80), agentId: z.number().int().positive().optional() }), input);
  const agent = resolveAgent(p, parsed.agentId);
  try {
    const teamId = getDb().transaction(() => {
      if (getDb().prepare('SELECT 1 FROM team_members WHERE agent_id=?').get(agent.id)) {
        throw new AppError('CONFLICT', '一个 Agent 同时只能加入一个队伍');
      }
      const now = Date.now();
      const info = getDb().prepare(`INSERT INTO teams(name,tag,description,captain_agent_id,invite_code,created_at)
        VALUES (?,?,?,?,?,?)`).run(parsed.name, parsed.tag || '', parsed.description || '', agent.id, newInviteCode(), now);
      const id = Number(info.lastInsertRowid);
      getDb().prepare("INSERT INTO team_members(team_id,agent_id,role,joined_at) VALUES (?,?,'captain',?)").run(id, agent.id, now);
      return id;
    })();
    return teamDTO(p, teamId);
  } catch (err) { return uniqueError(err); }
}

export async function update(p: Principal, teamId: number, patch: { name?: string; tag?: string; description?: string }): Promise<DTO.TeamDTO> {
  const team = mustCaptain(p, teamId);
  const parsed = parse(teamPatch, patch);
  try {
    getDb().prepare('UPDATE teams SET name=?,tag=?,description=? WHERE id=?')
      .run(parsed.name ?? team.name, parsed.tag ?? team.tag, parsed.description ?? team.description, team.id);
    return teamDTO(p, teamId);
  } catch (err) { return uniqueError(err); }
}

export async function join(p: Principal, input: { agentId?: number; inviteCode: string }): Promise<DTO.TeamDTO> {
  const parsed = parse(z.object({ agentId: z.number().int().positive().optional(), inviteCode: z.string().trim().min(1).max(128) }), input);
  const agent = resolveAgent(p, parsed.agentId);
  const team = getDb().prepare('SELECT * FROM teams WHERE invite_code=? AND disbanded=0').get(parsed.inviteCode) as TeamRow | undefined;
  if (!team) throw new AppError('NOT_FOUND', '邀请码无效或队伍已解散');
  try {
    getDb().transaction(() => {
      if (getDb().prepare('SELECT 1 FROM team_members WHERE agent_id=?').get(agent.id)) {
        throw new AppError('CONFLICT', '一个 Agent 同时只能加入一个队伍');
      }
      getDb().prepare("INSERT INTO team_members(team_id,agent_id,role,joined_at) VALUES (?,?,'member',?)")
        .run(team.id, agent.id, Date.now());
    })();
    return teamDTO(p, team.id);
  } catch (err) { return uniqueError(err); }
}

export async function leave(p: Principal, teamId: number, input: { agentId?: number } = {}): Promise<{ ok: true }> {
  row(teamId);
  const agent = resolveAgent(p, input.agentId);
  const membership = getDb().prepare('SELECT 1 FROM team_members WHERE team_id=? AND agent_id=?').get(teamId, agent.id);
  if (!membership) throw new AppError('NOT_FOUND', '该 Agent 不在此队伍中');
  getDb().transaction(() => unlinkAgentFromTeam(agent.id))();
  return { ok: true };
}

export async function kick(p: Principal, teamId: number, agentId: number): Promise<DTO.TeamDTO> {
  const team = mustCaptain(p, teamId);
  if (agentId === team.captain_agent_id) throw new AppError('CONFLICT', '队长请使用离队操作');
  if (!getDb().prepare('SELECT 1 FROM team_members WHERE team_id=? AND agent_id=?').get(teamId, agentId)) {
    throw new AppError('NOT_FOUND', '该 Agent 不在此队伍中');
  }
  getDb().transaction(() => unlinkAgentFromTeam(agentId))();
  return teamDTO(p, teamId);
}

export async function rotateInvite(p: Principal, teamId: number): Promise<{ inviteCode: string }> {
  mustCaptain(p, teamId);
  const inviteCode = newInviteCode();
  getDb().prepare('UPDATE teams SET invite_code=? WHERE id=?').run(inviteCode, teamId);
  return { inviteCode };
}
