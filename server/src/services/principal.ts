import type { Request } from 'express';
import { readBearer, verifyToken } from '../auth';
import { getAgentById, getAgentByPlatformKey, getDb, getUserById, type AgentRow } from '../db';
import { AppError } from '../http';

export type Principal = { kind: 'agent'; agentId: number; userId: number } | { kind: 'user'; userId: number };

export async function principalFromAgentKey(key: string): Promise<Principal> {
  if (typeof key !== 'string' || key.length > 512 || !key.startsWith('agk_')) {
    throw new AppError('UNAUTHORIZED', 'Agent API Key 无效');
  }
  const agent = getAgentByPlatformKey(key);
  if (!agent || !getUserById(agent.user_id)) throw new AppError('UNAUTHORIZED', 'Agent API Key 无效或已停用');
  getDb().prepare('UPDATE agents SET last_seen_at=? WHERE id=?').run(Date.now(), agent.id);
  return { kind: 'agent', agentId: agent.id, userId: agent.user_id };
}

export async function principalFromRequest(req: Request): Promise<Principal | null> {
  const agentHeader = req.headers['x-agent-api-key'];
  if (agentHeader !== undefined) {
    if (typeof agentHeader !== 'string' || !agentHeader.trim()) throw new AppError('UNAUTHORIZED', 'Agent API Key 无效');
    return principalFromAgentKey(agentHeader.trim());
  }
  const token = readBearer(req);
  if (!token) {
    if (req.headers.authorization !== undefined) throw new AppError('UNAUTHORIZED', '认证格式无效');
    return null;
  }
  if (token.startsWith('agk_')) return principalFromAgentKey(token);
  if (token.length > 8192) throw new AppError('UNAUTHORIZED', '登录凭证无效');
  try {
    const payload = verifyToken(token);
    const user = getUserById(payload.userId);
    if (!user) throw new Error('missing user');
    return { kind: 'user', userId: user.id };
  } catch {
    throw new AppError('UNAUTHORIZED', '登录已过期或凭证无效');
  }
}

export function ownsAgent(p: Principal | null, agentId: number): boolean {
  if (!p || !getUserById(p.userId)) return false;
  const agent = getAgentById(agentId);
  return !!agent && !agent.disabled && agent.user_id === p.userId && (p.kind === 'user' || p.agentId === agentId);
}

export function mustOwnAgent(p: Principal, agentId: number): AgentRow {
  const agent = getAgentById(agentId);
  if (!agent || agent.disabled) throw new AppError('NOT_FOUND', 'Agent 不存在');
  if (!ownsAgent(p, agentId)) throw new AppError('FORBIDDEN', '无权操作此 Agent');
  return agent;
}

export function resolveAgent(p: Principal, agentId?: number): AgentRow {
  if (p.kind === 'agent') {
    if (agentId !== undefined && agentId !== p.agentId) throw new AppError('FORBIDDEN', 'Agent 只能代表自己操作');
    return mustOwnAgent(p, p.agentId);
  }
  if (agentId === undefined) throw new AppError('VALIDATION_ERROR', '请指定 agentId');
  return mustOwnAgent(p, agentId);
}
