import { randomBytes, randomUUID } from 'node:crypto';
import { Server, type Socket } from 'socket.io';
import { z } from 'zod';
import { verifyToken } from '../auth';
import { getAgentById, getAgentByPlatformKey, getUserById } from '../db';
import type { BotStrategy, Direction, GameMode, PlayerKind } from '../types';
import { Room, type RoomConfig } from './room';

export interface AgentRecord {
  id: string;
  name: string;
  apiKey: string;
  createdAt: number;
}

export interface PresenceUser {
  userId: number;
  username: string;
  roomCode: string | null;
}

const dirSchema = z.enum(['up', 'down', 'left', 'right']);
const modeSchema = z.enum(['solo', 'score', 'battle']);
const strategySchema = z.enum(['greedy', 'coward', 'random']);

interface SocketData {
  playerId: string;
  name: string;
  userId: number;
  roomId?: string;
}

export class GameManager {
  readonly rooms = new Map<string, Room>();
  readonly roomsByCode = new Map<string, Room>();
  readonly agents = new Map<string, AgentRecord>();
  readonly agentsByKey = new Map<string, AgentRecord>();
  private io: Server | null = null;

  attach(io: Server): void {
    this.io = io;
    io.use((socket, next) => {
      try {
        const token = String(socket.handshake.auth?.token ?? '');
        const payload = verifyToken(token);
        const user = getUserById(payload.userId);
        if (!user) {
          next(new Error('请先登录'));
          return;
        }
        const data: SocketData = {
          playerId: `u_${user.id}`,
          name: user.username,
          userId: user.id,
        };
        socket.data = data;
        next();
      } catch {
        next(new Error('请先登录'));
      }
    });
    io.on('connection', (socket) => this.bindSocket(socket));
  }

  private bindSocket(socket: Socket): void {
    const data = socket.data as SocketData;
    socket.emit('session:ok', { playerId: data.playerId, name: data.name, userId: data.userId });
    socket.emit('rooms:list', this.listRooms());
    this.broadcastPresence();

    socket.on('rooms:list', () => {
      socket.emit('rooms:list', this.listRooms());
    });

    socket.on('room:create', (payload: unknown) => {
      try {
        const body = z.object({
          mode: modeSchema,
          maxPlayers: z.number().int().min(2).max(4).optional(),
          thinkTimeoutSec: z.number().min(3).max(60).optional(),
        }).parse(payload ?? {});
        const room = this.createRoom(
          { id: data.playerId, name: data.name, kind: 'human' },
          { mode: body.mode, maxPlayers: body.maxPlayers, thinkTimeoutSec: body.thinkTimeoutSec },
        );
        this.enterSocket(socket, room);
        socket.emit('room:joined', room.toPublic(data.playerId));
      } catch (err) {
        socket.emit('error', { message: messageOf(err) });
      }
    });

    socket.on('room:join', (payload: unknown) => {
      try {
        const body = z.object({ code: z.string().min(2), play: z.boolean().optional() }).parse(payload ?? {});
        const room = this.getRoom(body.code);
        const seated = room.players().some((p) => p.id === data.playerId);
        const play = body.play === true;
        if (!seated && room.status === 'lobby' && play) {
          room.join({ id: data.playerId, name: data.name, kind: 'human' });
        }
        this.enterSocket(socket, room);
        socket.emit('room:joined', room.toPublic(data.playerId));
      } catch (err) {
        socket.emit('error', { message: messageOf(err) });
      }
    });

    socket.on('room:leave', () => {
      this.leaveSocket(socket);
    });

    socket.on('room:seat', () => {
      const room = this.currentRoom(socket);
      if (!room) return;
      try {
        if (room.status !== 'lobby') {
          socket.emit('error', { message: '对局已经开始，不能下场' });
          return;
        }
        room.join({ id: data.playerId, name: data.name, kind: 'human' });
        socket.emit('room:joined', room.toPublic(data.playerId));
      } catch (err) {
        socket.emit('error', { message: messageOf(err) });
      }
    });

    socket.on('room:ready', (payload: { ready?: boolean } = {}) => {
      const room = this.currentRoom(socket);
      if (!room) return;
      try {
        room.setReady(data.playerId, payload.ready !== false);
      } catch (err) {
        socket.emit('error', { message: messageOf(err) });
      }
    });

    socket.on('room:config', (payload: unknown) => {
      const room = this.currentRoom(socket);
      if (!room) return;
      if (room.hostId !== data.playerId) {
        socket.emit('error', { message: '只有房主可以改房间设定' });
        return;
      }
      try {
        const body = z.object({ thinkTimeoutSec: z.number().min(3).max(60) }).parse(payload ?? {});
        room.setThinkTimeoutSec(body.thinkTimeoutSec);
      } catch (err) {
        socket.emit('error', { message: messageOf(err) });
      }
    });

    socket.on('room:start', () => {
      const room = this.currentRoom(socket);
      if (!room) return;
      if (room.hostId !== data.playerId) {
        socket.emit('error', { message: '只有房主可以开局' });
        return;
      }
      try {
        room.start();
      } catch (err) {
        socket.emit('error', { message: messageOf(err) });
      }
    });

    socket.on('room:bot', (payload: unknown) => {
      const room = this.currentRoom(socket);
      if (!room) return;
      try {
        const body = z.object({ strategy: strategySchema.optional() }).parse(payload ?? {});
        room.addBot(body.strategy ?? 'greedy');
      } catch (err) {
        socket.emit('error', { message: messageOf(err) });
      }
    });

    socket.on('room:deploy-agent', (payload: unknown) => {
      const room = this.currentRoom(socket);
      if (!room) return;
      try {
        const body = z.object({ agentId: z.number().int() }).parse(payload ?? {});
        const agent = getAgentById(body.agentId);
        if (!agent || agent.user_id !== data.userId) {
          socket.emit('error', { message: '只能派遣自己绑定的 Agent' });
          return;
        }
        if (!agent.enabled) {
          socket.emit('error', { message: '该 Agent 已停用' });
          return;
        }
        const playerId = `a_${agent.id}`;
        room.join({ id: playerId, name: agent.name, kind: 'agent' });
        room.attachLlm(playerId, agent);
        this.broadcastList();
      } catch (err) {
        socket.emit('error', { message: messageOf(err) });
      }
    });

    socket.on('game:act', (payload: unknown) => {
      const room = this.currentRoom(socket);
      if (!room) return;
      const parsed = z.object({ direction: dirSchema }).safeParse(payload);
      if (!parsed.success) return;
      room.act(data.playerId, parsed.data.direction);
    });

    socket.on('disconnect', () => {
      this.leaveSocket(socket);
      this.broadcastPresence();
    });
  }

  private enterSocket(socket: Socket, room: Room): void {
    const data = socket.data as SocketData;
    if (data.roomId && data.roomId !== room.id) socket.leave(data.roomId);
    data.roomId = room.id;
    void socket.join(room.id);
    this.broadcastList();
    this.broadcastPresence();
  }

  private leaveSocket(socket: Socket): void {
    const data = socket.data as SocketData;
    if (!data.roomId) return;
    const room = this.rooms.get(data.roomId);
    socket.leave(data.roomId);
    data.roomId = undefined;
    if (room) {
      room.leave(data.playerId);
      if (room.players().length === 0 && room.status !== 'running') this.removeRoom(room);
    }
    this.broadcastList();
    this.broadcastPresence();
  }

  private currentRoom(socket: Socket): Room | undefined {
    const id = (socket.data as SocketData).roomId;
    return id ? this.rooms.get(id) : undefined;
  }

  registerAgent(name: string): AgentRecord {
    const trimmed = name.trim().slice(0, 16) || `agent-${this.agents.size + 1}`;
    const rec: AgentRecord = {
      id: `ag_${randomUUID().slice(0, 8)}`,
      name: trimmed,
      apiKey: `agk_${randomBytes(24).toString('hex')}`,
      createdAt: Date.now(),
    };
    this.agents.set(rec.id, rec);
    this.agentsByKey.set(rec.apiKey, rec);
    return rec;
  }

  agentByKey(apiKey: string | undefined): AgentRecord | undefined {
    if (!apiKey) return undefined;
    const mem = this.agentsByKey.get(apiKey);
    if (mem) return mem;
    const bound = getAgentByPlatformKey(apiKey);
    if (!bound) return undefined;
    return { id: `a_${bound.id}`, name: bound.name, apiKey, createdAt: bound.created_at };
  }

  createRoom(
    host: { id: string; name: string; kind: PlayerKind; strategy?: BotStrategy },
    config: RoomConfig,
  ): Room {
    const room = new Room(host, config, randomUUID(), uniqueCode(this.roomsByCode));
    this.rooms.set(room.id, room);
    this.roomsByCode.set(room.code, room);
    room.onUpdate((r) => this.broadcastRoom(r));
    this.broadcastList();
    return room;
  }

  getRoom(idOrCode: string): Room {
    const room = this.rooms.get(idOrCode) ?? this.roomsByCode.get(idOrCode.toUpperCase());
    if (!room) throw Object.assign(new Error('房间不存在'), { code: 'NOT_FOUND' });
    return room;
  }

  joinRoom(
    idOrCode: string,
    player: { id: string; name: string; kind: PlayerKind; strategy?: BotStrategy },
  ): Room {
    const room = this.getRoom(idOrCode);
    room.join(player);
    this.broadcastList();
    return room;
  }

  deployAgent(idOrCode: string, userId: number, agentId: number): Room {
    const room = this.getRoom(idOrCode);
    if (room.status !== 'lobby') throw Object.assign(new Error('对局已经开始'), { code: 'STARTED' });
    const agent = getAgentById(agentId);
    if (!agent || agent.user_id !== userId) {
      throw Object.assign(new Error('只能派遣自己绑定的 Agent'), { code: 'FORBIDDEN' });
    }
    if (!agent.enabled) throw Object.assign(new Error('该 Agent 已停用'), { code: 'FORBIDDEN' });
    const playerId = `a_${agent.id}`;
    room.join({ id: playerId, name: agent.name, kind: 'agent' });
    room.attachLlm(playerId, agent);
    this.broadcastList();
    return room;
  }

  listRooms() {
    return [...this.rooms.values()]
      .filter((r) => r.status !== 'ended')
      .map((r) => {
        const players = r.players();
        const host = players.find((p) => p.id === r.hostId);
        const seated = this.io?.sockets.adapter.rooms.get(r.id)?.size ?? 0;
        return {
          id: r.id,
          code: r.code,
          mode: r.mode,
          status: r.status,
          players: players.length,
          maxPlayers: r.maxPlayers,
          hostName: r.hostName || host?.name || '',
          names: players.map((p) => p.name),
          scores: players.map((p) => ({ name: p.name, score: p.score, alive: p.alive })),
          watchers: Math.max(0, seated - players.filter((p) => p.kind === 'human').length),
        };
      });
  }

  listPresence(): PresenceUser[] {
    if (!this.io) return [];
    const uniq = new Map<number, PresenceUser>();
    for (const sock of this.io.sockets.sockets.values()) {
      const data = sock.data as SocketData;
      if (!data?.userId) continue;
      const room = data.roomId ? this.rooms.get(data.roomId) : undefined;
      uniq.set(data.userId, {
        userId: data.userId,
        username: data.name,
        roomCode: room?.code ?? null,
      });
    }
    return [...uniq.values()];
  }

  act(idOrCode: string, playerId: string, direction: Direction): Room {
    const room = this.getRoom(idOrCode);
    const ok = room.act(playerId, direction);
    if (!ok && room.status === 'ended') return room;
    if (!ok && room.status === 'lobby') {
      throw Object.assign(new Error('对局尚未开始'), { code: 'NOT_STARTED' });
    }
    return room;
  }

  private publishedStatus = new Map<string, string>();

  private removeRoom(room: Room): void {
    this.publishedStatus.delete(room.id);
    room.stop();
    this.rooms.delete(room.id);
    this.roomsByCode.delete(room.code);
    this.broadcastList();
  }

  private broadcastRoom(room: Room): void {
    if (!this.io) return;
    for (const sock of this.io.sockets.sockets.values()) {
      const data = sock.data as SocketData;
      if (data.roomId !== room.id) continue;
      sock.emit('room:state', room.toPublic(data.playerId));
    }
    if (room.status === 'ended') room.stop();
    const prev = this.publishedStatus.get(room.id);
    if (prev !== room.status) {
      this.publishedStatus.set(room.id, room.status);
      this.broadcastList();
    }
  }

  private broadcastList(): void {
    this.io?.emit('rooms:list', this.listRooms());
  }

  private broadcastPresence(): void {
    this.io?.emit('presence:list', this.listPresence());
  }
}

function uniqueCode(existing: Map<string, Room>): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let i = 0; i < 20; i++) {
    const bytes = randomBytes(4);
    const code = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
    if (!existing.has(code)) return code;
  }
  return randomBytes(3).toString('hex').toUpperCase();
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : '未知错误';
}

export const manager = new GameManager();

export { dirSchema, modeSchema, strategySchema };
