import { randomUUID } from 'node:crypto';
import type { BotStrategy, Direction, GameMode, Observation } from '../types';
import type { GameManager } from '../game/manager';
import { observationText } from '../game/observe';

export type Intent =
  | { type: 'help' }
  | { type: 'list' }
  | { type: 'create'; mode: GameMode; name?: string }
  | { type: 'join'; room: string; name?: string }
  | { type: 'ready' }
  | { type: 'start' }
  | { type: 'act'; direction: Direction }
  | { type: 'observe' }
  | { type: 'bot'; strategy?: BotStrategy };

export interface AgentTask {
  id: string;
  contextId: string;
  agentId: string;
  playerId: string;
  roomCode?: string;
  state: 'working' | 'input-required' | 'completed' | 'failed' | 'canceled';
}

const tasks = new Map<string, AgentTask>();

export function getTask(id: string): AgentTask | undefined {
  return tasks.get(id);
}

export function parseIntent(text: string, data?: Record<string, unknown>): Intent {
  if (data && typeof data.action === 'string') {
    const action = data.action;
    if (action === 'create') {
      const mode = asMode(data.mode) ?? 'solo';
      return { type: 'create', mode, name: asString(data.name) };
    }
    if (action === 'join' && asString(data.room)) return { type: 'join', room: asString(data.room)!, name: asString(data.name) };
    if (action === 'act' && asDir(data.direction)) return { type: 'act', direction: asDir(data.direction)! };
    if (action === 'observe') return { type: 'observe' };
    if (action === 'list') return { type: 'list' };
    if (action === 'ready') return { type: 'ready' };
    if (action === 'start') return { type: 'start' };
    if (action === 'bot') return { type: 'bot', strategy: asStrategy(data.strategy) };
    if (action === 'help') return { type: 'help' };
  }

  const raw = text.trim();
  const lower = raw.toLowerCase();

  const dir = matchDir(raw);
  if (dir) return { type: 'act', direction: dir };

  if (/^(help|帮助|技能|skills?)$/i.test(raw)) return { type: 'help' };
  if (/(list rooms|房间列表|列出房间|有哪些房间)/i.test(raw)) return { type: 'list' };
  if (/(observe|观察|局面|状态|棋盘)/i.test(raw)) return { type: 'observe' };
  if (/(ready|准备)/i.test(raw)) return { type: 'ready' };
  if (/(^start$|开始游戏|开局)/i.test(raw)) return { type: 'start' };

  const join = raw.match(/(?:join|加入)\s*([A-Z0-9]{3,8})/i);
  if (join?.[1]) return { type: 'join', room: join[1].toUpperCase() };

  const bot = raw.match(/bot|召唤|添加.*(agent|机器人|电脑)/i);
  if (bot) {
    const strategy = /coward|保守/.test(lower) ? 'coward' : /random|随机/.test(lower) ? 'random' : 'greedy';
    return { type: 'bot', strategy };
  }

  const created = raw.match(/(?:play|create|创建|开一[局场])\s*(solo|score|battle|单人|比分|对战)/i);
  if (created?.[1]) return { type: 'create', mode: asMode(created[1]) ?? 'solo' };
  if (/(solo|单人跑分|单人)/i.test(raw) && /(play|create|创建|开始)/i.test(raw)) return { type: 'create', mode: 'solo' };
  if (/(score|比分)/i.test(raw) && /(play|create|创建|开始)/i.test(raw)) return { type: 'create', mode: 'score' };
  if (/(battle|对战|pvp)/i.test(raw) && /(play|create|创建|开始)/i.test(raw)) return { type: 'create', mode: 'battle' };

  return { type: 'help' };
}

export function applyIntent(
  manager: GameManager,
  task: AgentTask,
  intent: Intent,
  speakerName: string,
): { task: AgentTask; text: string; observation?: Observation; extra?: unknown } {
  const name = speakerName;

  if (intent.type === 'help') {
    return {
      task,
      text: [
        'SERPENT 蛇场 — Agent 指令',
        'create: play solo | play score | play battle',
        'join: join ABCD',
        'act: up / down / left / right  （上/下/左/右）',
        'observe / list rooms / ready / start / add bot',
        '也可发送 data part: {"action":"act","direction":"left"}',
      ].join('\n'),
    };
  }

  if (intent.type === 'list') {
    const rooms = manager.listRooms();
    return {
      task,
      text: rooms.length
        ? rooms.map((r) => `${r.code}  ${r.mode}  ${r.status}  ${r.players}/${r.maxPlayers}`).join('\n')
        : '当前没有开放房间，可以用 play solo 创建一个。',
      extra: { rooms },
    };
  }

  if (intent.type === 'create') {
    const room = manager.createRoom(
      { id: task.playerId, name, kind: 'agent' },
      { mode: intent.mode },
    );
    room.join({ id: task.playerId, name, kind: 'agent' });
    task.roomCode = room.code;
    task.contextId = room.code;
    if (intent.mode === 'solo') {
      try { room.start(); } catch { /* lobby constraints */ }
    }
    const observation = room.observe(task.playerId);
    task.state = observation.gameOver ? 'completed' : 'input-required';
    return {
      task,
      text: `已创建房间 ${room.code}（${room.mode}）。\n${observationText(observation)}`,
      observation,
    };
  }

  if (intent.type === 'join') {
    const room = manager.joinRoom(intent.room, { id: task.playerId, name, kind: 'agent' });
    task.roomCode = room.code;
    task.contextId = room.code;
    const observation = room.observe(task.playerId);
    task.state = 'input-required';
    return {
      task,
      text: `已加入房间 ${room.code}（${room.mode}）。发送 ready 准备，或等待房主开局。\n${observationText(observation)}`,
      observation,
    };
  }

  const room = task.roomCode ? manager.getRoom(task.roomCode) : undefined;
  if (!room) {
    return { task, text: '你还不在房间里。先发送 play solo / play score / play battle，或 join 房间号。' };
  }

  if (intent.type === 'bot') {
    room.addBot(intent.strategy ?? 'greedy');
    return { task, text: `已在 ${room.code} 添加 ${intent.strategy ?? 'greedy'} bot。`, extra: room.toPublic(task.playerId) };
  }

  if (intent.type === 'ready') {
    room.setReady(task.playerId, true);
    const observation = room.observe(task.playerId);
    return { task, text: `已准备。status=${room.status}\n${observationText(observation)}`, observation };
  }

  if (intent.type === 'start') {
    room.start();
    const observation = room.observe(task.playerId);
    task.state = 'input-required';
    return { task, text: `房间 ${room.code} 开始倒计时。\n${observationText(observation)}`, observation };
  }

  if (intent.type === 'act') {
    manager.act(room.code, task.playerId, intent.direction);
    const observation = room.observe(task.playerId);
    task.state = observation.gameOver ? 'completed' : 'input-required';
    return { task, text: observationText(observation), observation };
  }

  const observation = room.observe(task.playerId);
  task.state = observation.gameOver ? 'completed' : 'input-required';
  return { task, text: observationText(observation), observation };
}

export function upsertTask(input: {
  taskId?: string;
  contextId?: string;
  agentId: string;
  playerId: string;
}): AgentTask {
  if (input.taskId && tasks.has(input.taskId)) return tasks.get(input.taskId)!;
  if (input.contextId) {
    const found = [...tasks.values()].find(
      (t) => t.agentId === input.agentId && t.contextId === input.contextId && t.state !== 'canceled',
    );
    if (found) return found;
  }
  const task: AgentTask = {
    id: input.taskId || randomUUID(),
    contextId: input.contextId || randomUUID(),
    agentId: input.agentId,
    playerId: input.playerId,
    state: 'working',
  };
  tasks.set(task.id, task);
  return task;
}

export function cancelTask(id: string): AgentTask | undefined {
  const task = tasks.get(id);
  if (!task) return undefined;
  task.state = 'canceled';
  return task;
}

export function taskResult(task: AgentTask, text: string, observation?: Observation, extra?: unknown) {
  return {
    jsonrpc: '2.0' as const,
    result: {
      id: task.id,
      contextId: task.contextId,
      kind: 'task',
      status: {
        state: task.state,
        message: {
          role: 'agent',
          messageId: randomUUID(),
          parts: [
            { kind: 'text', text },
            ...(observation || extra
              ? [{ kind: 'data', data: { observation, extra, room: task.roomCode } }]
              : []),
          ],
        },
      },
    },
  };
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function asMode(v: unknown): GameMode | undefined {
  const s = String(v ?? '').toLowerCase();
  if (s === 'solo' || s === '单人' || s === '单人跑分') return 'solo';
  if (s === 'score' || s === '比分') return 'score';
  if (s === 'battle' || s === '对战' || s === 'pvp') return 'battle';
  return undefined;
}

function asDir(v: unknown): Direction | undefined {
  return matchDir(String(v ?? ''));
}

function asStrategy(v: unknown): BotStrategy | undefined {
  const s = String(v ?? '');
  if (s === 'greedy' || s === 'coward' || s === 'random') return s;
  return undefined;
}

function matchDir(raw: string): Direction | undefined {
  const s = raw.trim().toLowerCase();
  if (s === 'up' || s === 'w' || s === '上' || s === '向上') return 'up';
  if (s === 'down' || s === 's' || s === '下' || s === '向下') return 'down';
  if (s === 'left' || s === 'a' || s === '左' || s === '向左') return 'left';
  if (s === 'right' || s === 'd' || s === '右' || s === '向右') return 'right';
  return undefined;
}
