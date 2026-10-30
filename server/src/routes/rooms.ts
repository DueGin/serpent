import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { readBearer, verifyToken } from '../auth';
import { getUserById } from '../db';
import { manager, dirSchema, modeSchema, strategySchema } from '../game/manager';
import { sendError } from '../http';
import type { PlayerKind } from '../types';

const router = Router();

function actor(req: Request): { id: string; name: string; kind: PlayerKind; userId?: number } {
  const key = String(req.headers['x-agent-api-key'] ?? '');
  const agent = manager.agentByKey(key);
  if (agent) return { id: agent.id, name: agent.name, kind: 'agent' };
  const token = readBearer(req);
  if (token) {
    const payload = verifyToken(token);
    const user = getUserById(payload.userId);
    if (!user) throw Object.assign(new Error('请先登录'), { code: 'UNAUTHORIZED' });
    return { id: `u_${user.id}`, name: user.username, kind: 'human', userId: user.id };
  }
  const name = String(req.headers['x-player-name'] ?? req.body?.name ?? 'player').slice(0, 16);
  const id = String(req.headers['x-player-id'] ?? '').slice(0, 32) || `p_${name}`;
  return { id, name, kind: 'human' };
}

function requireActor(req: Request, res: Response, next: NextFunction): void {
  const key = String(req.headers['x-agent-api-key'] ?? '');
  if (key && !manager.agentByKey(key)) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '无效的 X-Agent-Api-Key' } });
    return;
  }
  if (req.headers.authorization) {
    try {
      const token = readBearer(req);
      if (!token) throw new Error('no token');
      verifyToken(token);
    } catch {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '请先登录' } });
      return;
    }
  }
  next();
}

router.get('/', (_req, res) => {
  res.json({ data: manager.listRooms() });
});

router.post('/', requireActor, (req, res) => {
  try {
    const body = z.object({
      mode: modeSchema,
      name: z.string().max(16).optional(),
      maxPlayers: z.number().int().min(2).max(4).optional(),
      timeLimitMs: z.number().int().positive().optional(),
      targetScore: z.number().int().positive().optional(),
      thinkTimeoutSec: z.number().min(3).max(60).optional(),
    }).parse(req.body ?? {});
    const who = actor(req);
    if (body.name) who.name = body.name;
    const room = manager.createRoom(who, {
      mode: body.mode,
      maxPlayers: body.maxPlayers,
      timeLimitMs: body.timeLimitMs,
      targetScore: body.targetScore,
      thinkTimeoutSec: body.thinkTimeoutSec,
    });
    if (who.kind === 'agent') room.join(who);
    res.status(201).json(room.toPublic(who.id));
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/:id', (req, res) => {
  try {
    const who = actor(req);
    res.json(manager.getRoom(req.params.id).toPublic(who.id));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/:id/join', requireActor, (req, res) => {
  try {
    const who = actor(req);
    if (typeof req.body?.name === 'string') who.name = req.body.name.slice(0, 16);
    const room = manager.getRoom(req.params.id);
    if (room.status === 'lobby') {
      room.join(who);
    }
    res.json(room.toPublic(who.id));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/:id/leave', requireActor, (req, res) => {
  try {
    const who = actor(req);
    const room = manager.getRoom(req.params.id);
    room.leave(who.id);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/:id/ready', requireActor, (req, res) => {
  try {
    const who = actor(req);
    const room = manager.getRoom(req.params.id);
    room.setReady(who.id, req.body?.ready !== false);
    res.json(room.toPublic(who.id));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/:id/start', requireActor, (req, res) => {
  try {
    const who = actor(req);
    const room = manager.getRoom(req.params.id);
    if (room.hostId !== who.id) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: '只有房主可以开局' } });
      return;
    }
    room.start();
    res.json(room.toPublic(who.id));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/:id/deploy', requireActor, (req, res) => {
  try {
    const who = actor(req);
    if (!who.userId) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: '请用账号派遣自己的 Agent' } });
      return;
    }
    const body = z.object({ agentId: z.number().int() }).parse(req.body ?? {});
    const room = manager.deployAgent(req.params.id, who.userId, body.agentId);
    res.json(room.toPublic(who.id));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/:id/bots', requireActor, (req, res) => {
  try {
    const body = z.object({ strategy: strategySchema.optional() }).parse(req.body ?? {});
    const who = actor(req);
    const room = manager.getRoom(req.params.id);
    room.addBot(body.strategy ?? 'greedy');
    res.json(room.toPublic(who.id));
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/:id/observe', requireActor, (req, res) => {
  try {
    const who = actor(req);
    const room = manager.getRoom(req.params.id);
    res.json(room.observe(who.id));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/:id/act', requireActor, (req, res) => {
  try {
    const body = z.object({ direction: dirSchema }).parse(req.body ?? {});
    const who = actor(req);
    const room = manager.act(req.params.id, who.id, body.direction);
    res.json(room.observe(who.id));
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
