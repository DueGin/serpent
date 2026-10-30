import { z } from 'zod';
import type * as DTO from '../api-types';
import { getAgentById, getDb, getUserById, type AgentRow } from '../db';
import { hashAgentKey, newAgentKey } from '../crypto';
import { AppError } from '../http';
import { mustOwnAgent, ownsAgent, type Principal } from './principal';
import { unlinkAgentFromTeam } from './teams';
import * as scriptsSvc from './scripts';
import * as matchesSvc from './matches';
import * as laddersSvc from './ladders';

const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  modelLabel: z.string().trim().max(120).optional(),
  description: z.string().trim().max(4000).optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i, '颜色须为六位十六进制色值').optional(),
  disabled: z.boolean().optional(),
});
const COLORS = ['#edc748', '#e94f37', '#55bfa5', '#52a8dd', '#e98d49', '#b3bd61'];

function userOnly(p: Principal): void {
  if (p.kind !== 'user') throw new AppError('FORBIDDEN', '此操作需要用户登录');
  if (!getUserById(p.userId)) throw new AppError('UNAUTHORIZED', '账号不存在');
}

function existing(agentId: number, includeDisabled = false): AgentRow {
  const agent = getAgentById(agentId);
  if (!agent || (agent.disabled && !includeDisabled)) throw new AppError('NOT_FOUND', 'Agent 不存在');
  return agent;
}

export function agentDTO(agentId: number, p: Principal | null = null, includeDisabled = false): DTO.AgentDTO {
  const agent = existing(agentId, includeDisabled);
  const owner = getUserById(agent.user_id)!;
  const team = getDb().prepare(`SELECT t.id,t.name,t.tag FROM teams t
    JOIN team_members m ON m.team_id=t.id WHERE m.agent_id=? AND t.disbanded=0`).get(agent.id) as DTO.AgentDTO['team'] | undefined;
  const scripts = getDb().prepare('SELECT COUNT(*) AS count FROM scripts WHERE agent_id=? AND archived=0').get(agent.id) as { count: number };
  const results = getDb().prepare(`SELECT COUNT(DISTINCT p.match_id) AS matches,
    COUNT(DISTINCT CASE WHEN p.rank=1 THEN p.match_id END) AS wins
    FROM match_participants p JOIN matches m ON m.id=p.match_id WHERE p.agent_id=? AND m.status='done'`).get(agent.id) as
    { matches: number; wins: number };
  return {
    id: agent.id, name: agent.name, description: agent.description, modelLabel: agent.model_label,
    color: agent.color, userId: agent.user_id, ownerName: owner.username, createdAt: agent.created_at,
    lastSeenAt: agent.last_seen_at, team: team || null,
    ...(ownsAgent(p, agent.id) ? { keyPrefix: agent.api_key_prefix } : {}),
    stats: { scripts: scripts.count, matches: results.matches, wins: results.wins },
  };
}

function uniqueness(err: unknown): never {
  if ((err as { code?: string })?.code?.startsWith('SQLITE_CONSTRAINT_UNIQUE')) {
    throw new AppError('CONFLICT', 'Agent 名称已被使用');
  }
  throw err;
}

export async function getMe(p: Principal): Promise<DTO.AgentDTO> {
  if (p.kind !== 'agent') throw new AppError('FORBIDDEN', '请使用 Agent API Key');
  mustOwnAgent(p, p.agentId);
  return agentDTO(p.agentId, p);
}

export async function listMine(p: Principal): Promise<DTO.AgentDTO[]> {
  userOnly(p);
  const ids = getDb().prepare('SELECT id FROM agents WHERE user_id=? AND disabled=0 ORDER BY id DESC').all(p.userId) as Array<{ id: number }>;
  return ids.map((agent) => agentDTO(agent.id, p));
}

export async function create(p: Principal, input: { name: string; modelLabel?: string; description?: string }): Promise<DTO.AgentCreatedDTO> {
  userOnly(p);
  const parsed = patchSchema.pick({ name: true, modelLabel: true, description: true }).required({ name: true }).safeParse(input);
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.issues[0]?.message || 'Agent 信息不合法');
  const apiKey = newAgentKey();
  const now = Date.now();
  const count = getDb().prepare('SELECT COUNT(*) AS count FROM agents').get() as { count: number };
  try {
    const info = getDb().prepare(`INSERT INTO agents
      (user_id,name,description,model_label,color,api_key_hash,api_key_prefix,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(p.userId, parsed.data.name, parsed.data.description || '', parsed.data.modelLabel || '',
      COLORS[count.count % COLORS.length],
      hashAgentKey(apiKey), apiKey.slice(0, 12), now, now);
    return { ...agentDTO(Number(info.lastInsertRowid), p), apiKey };
  } catch (err) { return uniqueness(err); }
}

export async function update(p: Principal, agentId: number, patch: { name?: string; modelLabel?: string; description?: string; color?: string; disabled?: boolean }): Promise<DTO.AgentDTO> {
  const agent = mustOwnAgent(p, agentId);
  const parsed = patchSchema.safeParse(patch);
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.issues[0]?.message || 'Agent 信息不合法');
  try {
    getDb().prepare('UPDATE agents SET name=?,description=?,model_label=?,color=?,updated_at=? WHERE id=?').run(
      parsed.data.name ?? agent.name, parsed.data.description ?? agent.description,
      parsed.data.modelLabel ?? agent.model_label, parsed.data.color ?? agent.color, Date.now(), agent.id,
    );
    if (parsed.data.disabled) await remove(p, agentId);
    return agentDTO(agent.id, p, !!parsed.data.disabled);
  } catch (err) { return uniqueness(err); }
}

export async function remove(p: Principal, agentId: number): Promise<{ ok: true }> {
  mustOwnAgent(p, agentId);
  getDb().transaction(() => {
    const now = Date.now();
    unlinkAgentFromTeam(agentId);
    getDb().prepare('UPDATE agents SET disabled=1,updated_at=? WHERE id=?').run(now, agentId);
    getDb().prepare('UPDATE scripts SET archived=1,updated_at=? WHERE agent_id=?').run(now, agentId);
    getDb().prepare('UPDATE ladder_entries SET active=0,updated_at=? WHERE agent_id=?').run(now, agentId);
  })();
  return { ok: true };
}

export async function rotateKey(p: Principal, agentId: number): Promise<{ apiKey: string }> {
  mustOwnAgent(p, agentId);
  const apiKey = newAgentKey();
  getDb().prepare('UPDATE agents SET api_key_hash=?,api_key_prefix=?,updated_at=? WHERE id=?')
    .run(hashAgentKey(apiKey), apiKey.slice(0, 12), Date.now(), agentId);
  return { apiKey };
}

export async function profile(agentId: number): Promise<DTO.AgentProfileDTO> {
  const agent = agentDTO(agentId);
  const publicScripts = getDb().prepare(`SELECT id FROM scripts WHERE agent_id=? AND archived=0 AND visibility IN ('listed','open')
    ORDER BY updated_at DESC,id DESC`).all(agentId) as Array<{ id: number }>;
  const scripts = publicScripts.map((script) => scriptsSvc.scriptSummaryDTO(script.id));
  const ladderIds = getDb().prepare(`SELECT DISTINCT l.slug,l.name FROM ladder_entries e JOIN ladders l ON l.id=e.ladder_id
    WHERE e.agent_id=? AND e.active=1 AND l.active=1`).all(agentId) as Array<{ slug: string; name: string }>;
  const ladders = ladderIds.map((ladder) => {
    const entries = getDb().prepare(`SELECT e.id FROM ladder_entries e JOIN ladders l ON l.id=e.ladder_id
      WHERE l.slug=? AND e.agent_id=? AND e.active=1`).all(ladder.slug, agentId) as Array<{ id: number }>;
    const ranked = entries.map((entry) => laddersSvc.entryDTO(entry.id));
    const ranks = ranked.map((entry) => entry.rank).filter((rank) => rank > 0);
    return { slug: ladder.slug, name: ladder.name, bestRating: Math.max(...ranked.map((entry) => entry.rating)),
      bestRank: ranks.length ? Math.min(...ranks) : null, entries: ranked.length };
  });
  const aggregate = getDb().prepare(`SELECT COALESCE(AVG(p.score),0) AS avgScore,COALESCE(AVG(p.avg_move_ms),0) AS avgMoveMs,
    COALESCE(SUM(p.errors),0) AS errors,COALESCE(SUM(p.timeouts),0) AS timeouts
    FROM match_participants p JOIN matches m ON m.id=p.match_id WHERE p.agent_id=? AND m.status='done'`).get(agentId) as
    { avgScore: number; avgMoveMs: number; errors: number; timeouts: number };
  return { agent, scripts, ladders, stats: { matches: agent.stats.matches, wins: agent.stats.wins,
    winRate: agent.stats.matches ? agent.stats.wins / agent.stats.matches : 0, ...aggregate },
    recentMatches: await matchesSvc.list(null, { agentId, limit: 10 }) };
}

export async function directory(): Promise<DTO.AgentDTO[]> {
  const agents = getDb().prepare('SELECT id FROM agents WHERE disabled=0 ORDER BY created_at DESC,id DESC').all() as Array<{ id: number }>;
  return agents.map((agent) => agentDTO(agent.id));
}
