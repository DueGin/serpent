/**
 * 示例 Agent：注册 → 创建/加入房间 → 每 tick 观察并行动。
 *
 *   pnpm agent -- --mode solo
 *   pnpm agent -- --mode battle --join ABCD
 *   pnpm agent -- --mode score --strategy coward
 */
import { chooseMove } from '../game/bot';
import type { BotStrategy, Direction, GameMode, GameState, Observation } from '../types';

const BASE = process.env.SERPENT_URL || 'http://localhost:8008';

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0) return process.argv[idx + 1] ?? 'true';
  return fallback;
}

async function json(path: string, init?: RequestInit & { apiKey?: string }) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init?.apiKey) headers['x-agent-api-key'] = init.apiKey;
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) } });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message || res.statusText);
  return body;
}

async function main() {
  const mode = (arg('mode', 'solo') || 'solo') as GameMode;
  const strategy = (arg('strategy', 'greedy') || 'greedy') as BotStrategy;
  const join = arg('join');
  const name = arg('name', `${strategy}-${mode}`) || 'agent';

  const agent = await json('/api/agents/guest', { method: 'POST', body: JSON.stringify({ name }) });
  const apiKey = agent.apiKey as string;
  console.log(`[agent] ${agent.name}  key=${apiKey}`);

  let room = join
    ? await json(`/api/rooms/${join}/join`, { method: 'POST', apiKey, body: JSON.stringify({ name }) })
    : await json('/api/rooms', { method: 'POST', apiKey, body: JSON.stringify({ mode, name }) });

  console.log(`[agent] room ${room.code} ${room.mode}`);

  if (mode !== 'solo' && !join) {
    await json(`/api/rooms/${room.code}/bots`, { method: 'POST', apiKey, body: JSON.stringify({ strategy: 'random' }) });
  }

  await json(`/api/rooms/${room.code}/ready`, { method: 'POST', apiKey, body: '{}' });
  if (room.hostId === agent.id && room.status === 'lobby') {
    try {
      await json(`/api/rooms/${room.code}/start`, { method: 'POST', apiKey, body: '{}' });
    } catch {
      /* need more players */
    }
  }

  let lastTick = -1;
  for (;;) {
    const obs = (await json(`/api/rooms/${room.code}/observe`, { apiKey })) as Observation;
    if (obs.gameOver) {
      console.log(`[agent] game over  score=${obs.you.score} winners=${obs.winners.join(',')}`);
      break;
    }
    if (obs.status !== 'running' || obs.tick === lastTick) {
      await sleep(obs.tickMs / 3 || 40);
      continue;
    }
    lastTick = obs.tick;
    if (!obs.you.alive) {
      await sleep(obs.tickMs);
      continue;
    }
    const fakeState: GameState = {
      mode: obs.mode,
      status: obs.status,
      width: obs.width,
      height: obs.height,
      tickMs: obs.tickMs,
      wrap: obs.wrap,
      tick: obs.tick,
      foods: obs.foods,
      snakes: obs.snakes.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        color: '#fff',
        body: s.body,
        dir: s.dir,
        pendingDir: null,
        alive: s.alive,
        score: s.score,
        kills: 0,
        ready: true,
      })),
      foodCount: obs.foods.length,
      targetScore: obs.targetScore,
      timeLimitMs: obs.remainingMs,
      elapsedMs: 0,
      rng: Math.random,
      events: [],
      winners: obs.winners,
    };
    const direction: Direction = chooseMove(fakeState, obs.you.id, strategy);
    await json(`/api/rooms/${room.code}/act`, {
      method: 'POST',
      apiKey,
      body: JSON.stringify({ direction }),
    });
    process.stdout.write(`\r tick ${obs.tick} ${direction} score=${obs.you.score}   `);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
