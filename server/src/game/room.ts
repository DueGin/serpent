import { randomBytes } from 'node:crypto';
import {
  type AgentThink,
  type AgentThinkStatus,
  type BotStrategy,
  type Direction,
  type GameMode,
  type GameState,
  type PlayerKind,
  type PublicRoom,
  type Snake,
  COLORS,
  clampThinkTimeoutSec,
} from '../types';
import type { AgentRow } from '../db';
import { completeLlm, observationPrompt, parseDir } from '../agent/llm-client';
import { createGame, queueDirection, step } from './engine';
import { chooseMove } from './bot';
import { observe, publicRoomFrom, toPublicSnake } from './observe';

export interface RoomConfig {
  mode: GameMode;
  maxPlayers?: number;
  timeLimitMs?: number | null;
  targetScore?: number | null;
  thinkTimeoutSec?: number;
}

function code4(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(4);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export class Room {
  readonly id: string;
  readonly code: string;
  readonly mode: GameMode;
  readonly maxPlayers: number;
  readonly createdAt = Date.now();
  hostId: string;
  hostName: string;
  status: PublicRoom['status'] = 'lobby';
  countdown = 0;
  state: GameState | null = null;
  timeLimitMs: number | null;
  targetScore: number | null;
  thinkTimeoutSec: number;
  private lobby: Snake[] = [];
  private timer: NodeJS.Timeout | null = null;
  private listeners = new Set<(room: Room) => void>();
  private llmByPlayer = new Map<string, AgentRow>();
  private waitingOn: string[] = [];
  private lockstepAbort: AbortController | null = null;
  private think = new Map<string, AgentThink & { startedAt?: number }>();
  private wallStart = 0;

  constructor(host: { id: string; name: string; kind: PlayerKind; strategy?: BotStrategy }, config: RoomConfig, id: string, code?: string) {
    this.id = id;
    this.code = code ?? code4();
    this.mode = config.mode;
    this.maxPlayers = config.mode === 'solo' ? 1 : Math.min(4, Math.max(2, config.maxPlayers ?? 4));
    this.timeLimitMs = config.timeLimitMs === undefined ? (config.mode === 'score' ? 60_000 : null) : config.timeLimitMs;
    this.targetScore = config.targetScore === undefined ? (config.mode === 'score' ? 80 : null) : config.targetScore;
    this.thinkTimeoutSec = clampThinkTimeoutSec(config.thinkTimeoutSec);
    this.hostId = host.id;
    this.hostName = host.name.slice(0, 16) || 'host';
  }

  onUpdate(fn: (room: Room) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this);
  }

  private makeSnake(p: { id: string; name: string; kind: PlayerKind; strategy?: BotStrategy }, index: number): Snake {
    return {
      id: p.id,
      name: p.name.slice(0, 16) || 'player',
      kind: p.kind,
      color: COLORS[index % COLORS.length]!,
      body: [],
      dir: 'right',
      pendingDir: null,
      alive: true,
      score: 0,
      kills: 0,
      ready: p.kind === 'agent',
      strategy: p.strategy,
    };
  }

  players(): Snake[] {
    return this.state?.snakes ?? this.lobby;
  }

  join(p: { id: string; name: string; kind: PlayerKind; strategy?: BotStrategy }): Snake {
    const existing = this.players().find((s) => s.id === p.id);
    if (existing) return existing;
    if (this.status !== 'lobby') throw Object.assign(new Error('对局已经开始'), { code: 'STARTED' });
    if (this.lobby.length >= this.maxPlayers) throw Object.assign(new Error('房间已满'), { code: 'FULL' });
    const snake = this.makeSnake(p, this.lobby.length);
    this.lobby.push(snake);
    this.emit();
    return snake;
  }

  leave(playerId: string): void {
    if (this.status === 'lobby') {
      this.lobby = this.lobby.filter((s) => s.id !== playerId);
      if (this.hostId === playerId) this.hostId = this.lobby[0]?.id ?? this.hostId;
      this.emit();
      return;
    }
    // 对局中途离开不断开蛇，方便刷新/观战重连
  }

  setReady(playerId: string, ready = true): void {
    const snake = this.players().find((s) => s.id === playerId);
    if (!snake) throw Object.assign(new Error('你不在这个房间'), { code: 'NOT_IN_ROOM' });
    snake.ready = ready;
    this.emit();
    if (this.status === 'lobby' && this.lobby.length > 0 && this.lobby.every((s) => s.ready)) {
      const humans = this.lobby.filter((s) => s.kind === 'human');
      if (humans.length > 0) this.start();
    }
  }

  attachLlm(playerId: string, agent: AgentRow): void {
    this.llmByPlayer.set(playerId, agent);
    this.patchThink(playerId, { status: 'idle' });
    this.emit();
  }

  setThinkTimeoutSec(sec: number): void {
    if (this.status !== 'lobby') throw Object.assign(new Error('对局开始后不能改超时'), { code: 'STARTED' });
    this.thinkTimeoutSec = clampThinkTimeoutSec(sec);
    this.emit();
  }

  addBot(strategy: BotStrategy = 'greedy'): Snake {
    if (this.status !== 'lobby') throw Object.assign(new Error('对局已经开始'), { code: 'STARTED' });
    if (this.lobby.length >= this.maxPlayers) throw Object.assign(new Error('房间已满'), { code: 'FULL' });
    const n = this.lobby.filter((s) => s.strategy).length + 1;
    return this.join({
      id: `bot_${randomBytes(4).toString('hex')}`,
      name: `${strategy}-${n}`,
      kind: 'agent',
      strategy,
    });
  }

  start(): void {
    if (this.status !== 'lobby') return;
    if (this.lobby.length === 0) throw Object.assign(new Error('房间是空的'), { code: 'EMPTY' });
    if (this.mode !== 'solo' && this.lobby.length < 2) {
      throw Object.assign(new Error('至少需要两名玩家'), { code: 'NEED_MORE' });
    }
    this.state = createGame({
      mode: this.mode,
      players: this.lobby.map((s, i) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        color: s.color,
        strategy: s.strategy,
        spawnIndex: i,
      })),
      timeLimitMs: this.timeLimitMs,
      targetScore: this.targetScore,
    });
    this.state.status = 'countdown';
    this.status = 'countdown';
    this.countdown = 3;
    this.emit();
    this.armTimer();
  }

  act(playerId: string, dir: Direction): boolean {
    if (!this.state) return false;
    return queueDirection(this.state, playerId, dir);
  }

  observe(playerId: string) {
    if (!this.state) {
      const lobbyGrid = '(lobby — game not started)';
      return {
        protocol: 'serpent-v1' as const,
        mode: this.mode,
        status: this.status,
        tick: 0,
        tickMs: 120,
        width: 0,
        height: 0,
        wrap: this.mode === 'score',
        remainingMs: this.timeLimitMs,
        targetScore: this.targetScore,
        you: {
          id: playerId,
          name: this.lobby.find((s) => s.id === playerId)?.name ?? '',
          head: null,
          body: [],
          dir: null,
          alive: true,
          score: 0,
          kills: 0,
        },
        snakes: this.lobby.map((s) => ({
          id: s.id,
          name: s.name,
          kind: s.kind,
          head: null,
          body: [],
          dir: s.dir,
          alive: true,
          score: 0,
        })),
        foods: [],
        legalMoves: [],
        grid: lobbyGrid,
        gameOver: false,
        winners: [] as string[],
      };
    }
    return observe(this.state, playerId);
  }

  toPublic(youId?: string): PublicRoom {
    const pub = publicRoomFrom({
      id: this.id,
      code: this.code,
      hostId: this.hostId,
      maxPlayers: this.maxPlayers,
      countdown: this.countdown,
      mode: this.mode,
      status: this.status,
      state: this.state,
      youId,
    });
    if (!this.state) {
      pub.players = this.lobby.map(toPublicSnake);
      pub.you = youId ? pub.players.find((p) => p.id === youId) : undefined;
      pub.width = this.mode === 'solo' ? 24 : 28;
      pub.height = this.mode === 'solo' ? 16 : 20;
    }
    pub.waitingOn = this.waitingOn.slice();
    pub.thinkTimeoutSec = this.thinkTimeoutSec;
    pub.players = pub.players.map((p) => ({ ...p, think: this.publicThink(p.id) }));
    if (pub.you) pub.you = { ...pub.you, think: this.publicThink(pub.you.id) };
    return pub;
  }

  private publicThink(playerId: string): AgentThink | undefined {
    const rec = this.think.get(playerId);
    if (!rec) return undefined;
    const elapsedMs = rec.status === 'thinking' && rec.startedAt
      ? Date.now() - rec.startedAt
      : rec.elapsedMs;
    return { status: rec.status, direction: rec.direction, elapsedMs };
  }

  private patchThink(playerId: string, patch: Partial<AgentThink> & { startedAt?: number }): void {
    const prev = this.think.get(playerId) ?? { status: 'idle' as AgentThinkStatus };
    this.think.set(playerId, { ...prev, ...patch });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.lockstepAbort?.abort();
    this.lockstepAbort = null;
  }

  private armTimer(): void {
    this.stop();
    const ms = this.status === 'countdown' ? 1000 : (this.state?.tickMs ?? 120);
    this.timer = setInterval(() => this.tick(), ms);
  }

  private applyBots(): void {
    if (!this.state || this.state.status !== 'running') return;
    for (const snake of this.state.snakes) {
      if (!snake.alive || !snake.strategy) continue;
      const dir = chooseMove(this.state, snake.id, snake.strategy);
      queueDirection(this.state, snake.id, dir);
    }
  }

  private tick(): void {
    if (this.status === 'countdown') {
      this.countdown -= 1;
      if (this.countdown <= 0) {
        this.status = 'running';
        if (this.state) this.state.status = 'running';
        this.countdown = 0;
        this.wallStart = Date.now();
        if (this.llmByPlayer.size > 0) {
          this.stop();
          this.lockstepAbort = new AbortController();
          void this.lockstep(this.lockstepAbort.signal);
        } else {
          this.armTimer();
        }
      }
      this.emit();
      return;
    }
    if (this.status !== 'running' || !this.state) return;
    this.applyBots();
    step(this.state);
    this.status = this.state.status;
    this.emit();
    if (this.status === 'ended') this.stop();
  }

  /** 有绑定 LLM 时：所有存活 Agent 都返回方向后，才共同前进一步。 */
  private async lockstep(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && this.status === 'running' && this.state) {
      const jobs = this.state.snakes
        .filter((s) => s.alive && this.llmByPlayer.has(s.id))
        .map((s) => this.queryLlm(s.id, signal));
      this.waitingOn = jobs.length
        ? this.state.snakes.filter((s) => s.alive && this.llmByPlayer.has(s.id)).map((s) => s.name)
        : [];
      this.emit();
      if (jobs.length) {
        const beat = setInterval(() => {
          if (signal.aborted || !this.state) return;
          this.state.elapsedMs = Date.now() - this.wallStart;
          this.emit();
        }, 400);
        try {
          await Promise.all(jobs);
        } finally {
          clearInterval(beat);
        }
      }
      if (signal.aborted || this.status !== 'running' || !this.state) break;
      this.waitingOn = [];
      this.applyBots();
      step(this.state, { elapsedMs: Date.now() - this.wallStart });
      this.status = this.state.status;
      this.emit();
      if (this.status === 'ended') {
        this.stop();
        break;
      }
    }
  }

  private async queryLlm(playerId: string, signal: AbortSignal): Promise<void> {
    const agent = this.llmByPlayer.get(playerId);
    if (!agent || !this.state) return;
    const tick = this.state.tick;
    const obs = this.observe(playerId);
    const fallback = obs.legalMoves.includes(obs.you.dir as Direction)
      ? obs.you.dir!
      : (obs.legalMoves[0] ?? 'right');
    const startedAt = Date.now();
    this.patchThink(playerId, { status: 'thinking', direction: null, startedAt, elapsedMs: 0 });
    this.emit();
    try {
      const text = await completeLlm({
        protocol: agent.protocol,
        baseUrl: agent.base_url,
        model: agent.model,
        apiKey: agent.api_key,
        systemPrompt: agent.system_prompt,
        userPrompt: observationPrompt(obs),
        legalMoves: obs.legalMoves,
        maxTokens: 32,
        timeoutMs: this.thinkTimeoutSec * 1000,
      });
      if (signal.aborted || this.state?.tick !== tick) return;
      const parsed = parseDir(text);
      const dir = parsed && obs.legalMoves.includes(parsed) ? parsed : fallback;
      const elapsedMs = Date.now() - startedAt;
      console.log(`[llm ${agent.name}] tick=${tick} raw=${JSON.stringify(text).slice(0, 80)} -> ${dir}${parsed ? '' : ' (unparsed, keep)'}`);
      this.act(playerId, dir);
      this.patchThink(playerId, { status: 'done', direction: dir, elapsedMs, startedAt: undefined });
      this.emit();
    } catch (err) {
      if (signal.aborted || this.state?.tick !== tick) return;
      const elapsedMs = Date.now() - startedAt;
      const timedOut = err instanceof Error && /aborted|timeout/i.test(err.message);
      console.error(`[llm ${agent.name}] tick=${tick} ${timedOut ? 'TIMEOUT keep ' + fallback : 'FAIL'}`, err instanceof Error ? err.message : err);
      this.act(playerId, fallback);
      this.patchThink(playerId, {
        status: timedOut ? 'timeout' : 'error',
        direction: fallback,
        elapsedMs,
        startedAt: undefined,
      });
      this.emit();
    }
  }
}
