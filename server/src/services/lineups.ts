import type Database from 'better-sqlite3';
import { AppError } from '../http';
import type { Principal } from './principal';

type Script = { id: number; agent_id: number; user_id: number; visibility: string;
  archived: number; disabled: number; status: string | null; active_version_id: number | null };
type TeamEntry = { id: number; team_id: number; active: number; lineup_json: string;
  authorized_user_id: number | null; authorized_agent_id: number | null };

function owns(p: Principal, agentId: number, userId: number): boolean {
  return p.userId === userId && (p.kind === 'user' || p.agentId === agentId);
}

// Persist the authorizing identity, not just the captain: a user may own both
// agents, whereas an Agent Key never grants access to its sibling's private code.
export function validateTeamLineup(p: Principal, teamId: number, lineup: unknown, db: Database.Database): Script[] {
  const team = db.prepare(`SELECT t.captain_agent_id,a.user_id,a.disabled FROM teams t
    JOIN agents a ON a.id=t.captain_agent_id WHERE t.id=? AND t.disbanded=0`).get(teamId) as
    { captain_agent_id: number; user_id: number; disabled: number } | undefined;
  if (!team) throw new AppError('NOT_FOUND', '队伍不存在');
  if (team.disabled || !owns(p, team.captain_agent_id, team.user_id)) throw new AppError('FORBIDDEN', '只有当前队长可以授权阵容');
  if (!Array.isArray(lineup) || lineup.length !== 2 || lineup[0] === lineup[1] ||
    !lineup.every((id: unknown) => typeof id === 'number' && Number.isSafeInteger(id) && id > 0)) {
    throw new AppError('VALIDATION_ERROR', '阵容必须是两个不同成员的脚本 ID');
  }
  const scripts: Script[] = [];
  for (const id of lineup) {
    const script = db.prepare(`SELECT s.id,s.agent_id,s.visibility,s.archived,s.active_version_id,
      a.user_id,a.disabled,v.status FROM scripts s JOIN agents a ON a.id=s.agent_id
      LEFT JOIN script_versions v ON v.id=s.active_version_id AND v.script_id=s.id WHERE s.id=?`).get(id) as Script | undefined;
    if (!script || script.archived || script.disabled) throw new AppError('NOT_FOUND', '阵容脚本不存在或已归档');
    if (!db.prepare('SELECT 1 FROM team_members WHERE team_id=? AND agent_id=?').get(teamId, script.agent_id)) {
      throw new AppError('FORBIDDEN', '阵容脚本必须属于当前队伍成员');
    }
    if (script.status !== 'valid') throw new AppError('VALIDATION_ERROR', '阵容脚本必须有检测通过的生效版本');
    if (script.visibility === 'private' && !owns(p, script.agent_id, script.user_id)) {
      throw new AppError('FORBIDDEN', '不能使用其他成员的私有脚本参赛');
    }
    scripts.push(script);
  }
  if (scripts[0].agent_id === scripts[1].agent_id) throw new AppError('VALIDATION_ERROR', '阵容需要两位不同 Agent');
  return scripts;
}

export function validateTeamEntry(entryId: number, db: Database.Database): Script[] {
  const entry = db.prepare("SELECT * FROM ladder_entries WHERE id=? AND entrant_type='team'").get(entryId) as TeamEntry | undefined;
  if (!entry || !entry.active) throw new AppError('CONFLICT', '团队入场已暂停或不存在');
  try {
    if (entry.authorized_user_id === null) throw new AppError('FORBIDDEN', '阵容授权需要队长重新确认');
    const p: Principal = entry.authorized_agent_id === null
      ? { kind: 'user', userId: entry.authorized_user_id }
      : { kind: 'agent', userId: entry.authorized_user_id, agentId: entry.authorized_agent_id };
    return validateTeamLineup(p, entry.team_id, JSON.parse(entry.lineup_json), db);
  } catch (error) {
    const reason = error instanceof AppError ? error.message : '阵容数据无效，请重新确认';
    db.prepare('UPDATE ladder_entries SET active=0,inactive_reason=?,updated_at=? WHERE id=?').run(reason, Date.now(), entryId);
    throw new AppError('CONFLICT', `团队入场已暂停：${reason}`);
  }
}
