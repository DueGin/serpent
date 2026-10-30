/**
 * LLM Agent：把局面发给大模型，解析 up/down/left/right。
 *
 *   pnpm --filter server agent:llm -- --provider teralemo --join ABCD
 *   pnpm --filter server agent:llm -- --provider flux --join ABCD --mode battle
 */
import { chooseMove } from '../game/bot';
import type { Direction, GameMode, GameState, Observation } from '../types';

const GAME = process.env.SERPENT_URL || 'http://localhost:8008';

const PROVIDERS = {
  teralemo: {
    base: process.env.TERALEMO_BASE || 'https://code.teralemo.com/v1',
    model: process.env.TERALEMO_MODEL || 'gpt-5.6-sol',
    protocol: 'chat' as const,
    key: process.env.TERALEMO_KEY || '',
  },
  flux: {
    base: process.env.FLUX_BASE || 'https://flux-code.cc/v1',
    model: process.env.FLUX_MODEL || 'grok-4.7',
    protocol: 'message' as const,
    key: process.env.FLUX_KEY || '',
  },
};

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0) return process.argv[idx + 1] ?? 'true';
  return fallback;
}

async function game(path: string, init?: RequestInit & { apiKey?: string }) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init?.apiKey) headers['x-agent-api-key'] = init.apiKey;
  const res = await fetch(`${GAME}${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message || res.statusText);
  return body;
}

function extractText(protocol: 'chat' | 'message', data: any): string {
  if (protocol === 'chat') {
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((p: any) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
    }
    return '';
  }
  const parts = data?.content;
  if (typeof parts === 'string') return parts;
  if (Array.isArray(parts)) {
    return parts.filter((p: any) => p?.type === 'text' || p?.text).map((p: any) => p.text ?? '').join('');
  }
  return data?.choices?.[0]?.message?.content ?? '';
}

function parseDir(text: string): Direction | null {
  const m = text.toLowerCase().match(/\b(up|down|left|right)\b/)
    || text.match(/(向上|向下|向左|向右|上|下|左|右)/);
  if (!m) return null;
  const v = m[1];
  if (v === 'up' || v === '上' || v === '向上') return 'up';
  if (v === 'down' || v === '下' || v === '向下') return 'down';
  if (v === 'left' || v === '左' || v === '向左') return 'left';
  if (v === 'right' || v === '右' || v === '向右') return 'right';
  return null;
}

async function llmMove(
  provider: keyof typeof PROVIDERS,
  key: string,
  obs: Observation,
): Promise<Direction | null> {
  const cfg = PROVIDERS[provider];
  const prompt = [
    'You are a snake. Reply with exactly one word: up, down, left or right.',
    `mode=${obs.mode} tick=${obs.tick} score=${obs.you.score} wrap=${obs.wrap}`,
    `you=${obs.you.head ? `${obs.you.head.x},${obs.you.head.y}` : 'dead'} dir=${obs.you.dir}`,
    `legal=${obs.legalMoves.join(',')}`,
    `foods=${obs.foods.map((f) => `${f.x},${f.y}`).join(' ') || 'none'}`,
    'grid H=you h=enemy *=food:',
    obs.grid,
  ].join('\n');

  const url = cfg.protocol === 'chat' ? `${cfg.base}/chat/completions` : `${cfg.base}/messages`;
  const body = cfg.protocol === 'chat'
    ? {
      model: cfg.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 16,
      temperature: 0,
    }
    : {
      model: cfg.model,
      max_tokens: 64,
      messages: [{ role: 'user', content: prompt }],
    };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data).slice(0, 300));
  const text = extractText(cfg.protocol, data).trim();
  const dir = parseDir(text);
  console.log(`[llm ${provider}] raw=${JSON.stringify(text).slice(0, 80)} -> ${dir ?? 'unparsed'}`);
  return dir;
}

function asState(obs: Observation): GameState {
  return {
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
}

async function main() {
  const provider = (arg('provider', 'teralemo') || 'teralemo') as keyof typeof PROVIDERS;
  if (!PROVIDERS[provider]) throw new Error(`unknown provider ${provider}`);
  const key = arg('key') || PROVIDERS[provider].key;
  if (!key) throw new Error(`missing API key for ${provider}`);
  const mode = (arg('mode', 'battle') || 'battle') as GameMode;
  const join = arg('join');
  const name = (arg('name') || `${provider}`.slice(0, 16));

  const agent = await game('/api/agents/guest', { method: 'POST', body: JSON.stringify({ name }) });
  console.log(`[llm] registered ${agent.name} provider=${provider} model=${PROVIDERS[provider].model}`);

  let room = join
    ? await game(`/api/rooms/${join}/join`, { method: 'POST', apiKey: agent.apiKey, body: JSON.stringify({ name }) })
    : await game('/api/rooms', { method: 'POST', apiKey: agent.apiKey, body: JSON.stringify({ mode, name }) });
  console.log(`[llm] room ${room.code} ${room.mode} status=${room.status}`);

  await game(`/api/rooms/${room.code}/ready`, { method: 'POST', apiKey: agent.apiKey, body: '{}' });
  if (!join && room.hostId === agent.id && room.status === 'lobby') {
    try {
      await game(`/api/rooms/${room.code}/start`, { method: 'POST', apiKey: agent.apiKey, body: '{}' });
    } catch {
      /* waiting for more players */
    }
  }

  let lastTick = -1;
  let inflight: Promise<Direction | null> | null = null;
  let latest: Direction | null = null;

  for (;;) {
    const obs = (await game(`/api/rooms/${room.code}/observe`, { apiKey: agent.apiKey })) as Observation;
    if (obs.gameOver) {
      console.log(`[llm] over score=${obs.you.score} winners=${obs.winners.join(',')}`);
      break;
    }
    if (obs.status !== 'running' || !obs.you.alive || obs.tick === lastTick) {
      await new Promise((r) => setTimeout(r, 40));
      continue;
    }
    lastTick = obs.tick;

    if (!inflight) {
      inflight = llmMove(provider, key, obs)
        .catch((err) => {
          console.error(`[llm ${provider}]`, err instanceof Error ? err.message : err);
          return null;
        })
        .finally(() => { inflight = null; });
      inflight.then((d) => { if (d) latest = d; }).catch(() => {});
    }

    const fallback = chooseMove(asState(obs), obs.you.id, 'greedy');
    const direction = (latest && obs.legalMoves.includes(latest)) ? latest : fallback;
    await game(`/api/rooms/${room.code}/act`, {
      method: 'POST',
      apiKey: agent.apiKey,
      body: JSON.stringify({ direction }),
    });
    process.stdout.write(`\r[${provider}] tick ${obs.tick} ${direction} score=${obs.you.score}   `);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
