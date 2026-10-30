import { chooseMove } from '../game/bot';
import type { AgentRow } from '../db';
import type { Direction, GameState, Observation } from '../types';
import type { Room } from '../game/room';
import { completeLlm, observationPrompt, parseDir } from './llm-client';

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

export function startBoundAgent(room: Room, playerId: string, agent: AgentRow): () => void {
  const abort = new AbortController();
  void loop(room, playerId, agent, abort.signal);
  return () => abort.abort();
}

async function loop(room: Room, playerId: string, agent: AgentRow, signal: AbortSignal): Promise<void> {
  let lastTick = -1;
  let inflight: Promise<Direction | null> | null = null;
  let latest: Direction | null = null;

  while (!signal.aborted) {
    if (room.status === 'ended') break;
    const obs = room.observe(playerId);
    if (obs.gameOver) break;
    if (obs.status !== 'running' || !obs.you.alive || obs.tick === lastTick) {
      await sleep(40, signal);
      continue;
    }
    lastTick = obs.tick;

    if (!inflight) {
      inflight = completeLlm({
        protocol: agent.protocol,
        baseUrl: agent.base_url,
        model: agent.model,
        apiKey: agent.api_key,
        systemPrompt: agent.system_prompt,
        userPrompt: observationPrompt(obs),
      })
        .then((text) => parseDir(text))
        .catch((err) => {
          console.error(`[runner ${agent.name}]`, err instanceof Error ? err.message : err);
          return null;
        })
        .finally(() => { inflight = null; });
      inflight.then((d) => { if (d) latest = d; }).catch(() => {});
    }

    const fallback = chooseMove(asState(obs), obs.you.id, 'greedy');
    const direction = (latest && obs.legalMoves.includes(latest)) ? latest : fallback;
    room.act(playerId, direction);
    await sleep(Math.max(20, Math.floor(obs.tickMs / 3)), signal);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
