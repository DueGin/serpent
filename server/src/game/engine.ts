import {
  type CreateGameInput,
  type Direction,
  type GameState,
  type Point,
  type Snake,
  DELTA,
  OPPOSITE,
  pointKey,
  pointsEqual,
} from '../types';

const DEFAULTS = {
  solo: { width: 24, height: 16, tickMs: 120, wrap: false, foodCount: 1, timeLimitMs: null as number | null, targetScore: null as number | null },
  score: { width: 28, height: 20, tickMs: 110, wrap: true, foodCount: 3, timeLimitMs: 60_000, targetScore: 80 },
  battle: { width: 28, height: 20, tickMs: 110, wrap: false, foodCount: 3, timeLimitMs: null, targetScore: null },
};

export function defaultRng(): () => number {
  return Math.random;
}

export function seedRng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function spawnPose(index: number, width: number, height: number): { head: Point; dir: Direction } {
  const poses: Array<{ head: Point; dir: Direction }> = [
    { head: { x: 3, y: 3 }, dir: 'right' },
    { head: { x: width - 4, y: 3 }, dir: 'left' },
    { head: { x: 3, y: height - 4 }, dir: 'right' },
    { head: { x: width - 4, y: height - 4 }, dir: 'left' },
  ];
  return poses[index % poses.length]!;
}

function trailingBody(head: Point, dir: Direction, length: number): Point[] {
  const back = OPPOSITE[dir];
  const body: Point[] = [];
  for (let i = 0; i < length; i++) {
    body.push({
      x: head.x + DELTA[back].x * i,
      y: head.y + DELTA[back].y * i,
    });
  }
  return body;
}

export function occupiedCells(state: GameState, opts?: { ignoreTails?: boolean }): Set<string> {
  const cells = new Set<string>();
  for (const snake of state.snakes) {
    const body = opts?.ignoreTails && snake.body.length > 1
      ? snake.body.slice(0, -1)
      : snake.body;
    for (const p of body) cells.add(pointKey(p));
  }
  for (const f of state.foods) cells.add(pointKey(f));
  return cells;
}

export function emptyCells(state: GameState): Point[] {
  const occ = occupiedCells(state);
  const out: Point[] = [];
  for (let y = 0; y < state.height; y++) {
    for (let x = 0; x < state.width; x++) {
      if (!occ.has(pointKey({ x, y }))) out.push({ x, y });
    }
  }
  return out;
}

export function spawnFood(state: GameState): Point | null {
  const cells = emptyCells(state);
  if (cells.length === 0) return null;
  const idx = Math.floor(state.rng() * cells.length);
  return cells[idx] ?? null;
}

function fillFood(state: GameState): void {
  while (state.foods.length < state.foodCount) {
    const p = spawnFood(state);
    if (!p) break;
    state.foods.push(p);
  }
}

export function createGame(input: CreateGameInput): GameState {
  const d = DEFAULTS[input.mode];
  const width = input.width ?? d.width;
  const height = input.height ?? d.height;
  const snakes: Snake[] = input.players.map((p, i) => {
    const pose = spawnPose(p.spawnIndex ?? i, width, height);
    return {
      id: p.id,
      name: p.name,
      kind: p.kind,
      color: p.color,
      body: trailingBody(pose.head, pose.dir, 3),
      dir: pose.dir,
      pendingDir: null,
      alive: true,
      score: 0,
      kills: 0,
      ready: p.kind === 'agent',
      strategy: p.strategy,
    };
  });

  const state: GameState = {
    mode: input.mode,
    status: 'running',
    width,
    height,
    tickMs: input.tickMs ?? d.tickMs,
    wrap: input.wrap ?? d.wrap,
    tick: 0,
    foods: input.foods ? input.foods.map((f) => ({ ...f })) : [],
    snakes,
    foodCount: input.foodCount ?? Math.max(d.foodCount, snakes.length === 1 ? 1 : Math.min(4, snakes.length)),
    targetScore: input.targetScore === undefined ? d.targetScore : input.targetScore,
    timeLimitMs: input.timeLimitMs === undefined ? d.timeLimitMs : input.timeLimitMs,
    elapsedMs: 0,
    rng: input.rng ?? defaultRng(),
    events: [],
    winners: [],
  };

  if (!input.foods) fillFood(state);
  return state;
}

export function nextCell(
  point: Point,
  dir: Direction,
  width: number,
  height: number,
  wrap: boolean,
): Point | null {
  let x = point.x + DELTA[dir].x;
  let y = point.y + DELTA[dir].y;
  if (wrap) {
    x = (x + width) % width;
    y = (y + height) % height;
    return { x, y };
  }
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  return { x, y };
}

export function resolveDir(snake: Snake): Direction {
  const pending = snake.pendingDir;
  if (pending && pending !== OPPOSITE[snake.dir]) return pending;
  return snake.dir;
}

export function queueDirection(state: GameState, snakeId: string, dir: Direction): boolean {
  const snake = state.snakes.find((s) => s.id === snakeId);
  if (!snake || !snake.alive) return false;
  if (state.status === 'ended' || state.status === 'lobby') return false;
  if (snake.body.length > 1 && dir === OPPOSITE[snake.dir]) return false;
  snake.pendingDir = dir;
  return true;
}

function collideSelfOrOthers(
  snake: Snake,
  nextHead: Point,
  nextBodies: Map<string, Point[]>,
  mode: GameState['mode'],
): { hit: boolean; victimId?: string } {
  for (const [id, body] of nextBodies) {
    const start = id === snake.id ? 1 : 0;
    for (let i = start; i < body.length; i++) {
      const cell = body[i]!;
      if (!pointsEqual(cell, nextHead)) continue;
      if (id === snake.id) return { hit: true };
      if (mode === 'score') continue;
      return { hit: true, victimId: id };
    }
  }
  return { hit: false };
}

export function step(state: GameState, opts?: { elapsedMs?: number }): GameState {
  if (state.status !== 'running') return state;
  state.tick += 1;
  state.elapsedMs = opts?.elapsedMs ?? state.elapsedMs + state.tickMs;
  state.events = [];

  const alive = state.snakes.filter((s) => s.alive);
  const intended = new Map<string, { dir: Direction; head: Point | null }>();

  for (const snake of alive) {
    const dir = resolveDir(snake);
    snake.dir = dir;
    snake.pendingDir = null;
    const head = snake.body[0]!;
    intended.set(snake.id, {
      dir,
      head: nextCell(head, dir, state.width, state.height, state.wrap),
    });
  }

  const nextBodies = new Map<string, Point[]>();
  for (const snake of state.snakes) {
    if (!snake.alive) {
      nextBodies.set(snake.id, snake.body);
      continue;
    }
    const plan = intended.get(snake.id)!;
    if (!plan.head) {
      nextBodies.set(snake.id, snake.body);
      continue;
    }
    const eating = state.foods.some((f) => pointsEqual(f, plan.head!));
    const body = [plan.head, ...snake.body];
    if (!eating) body.pop();
    nextBodies.set(snake.id, body);
  }

  const headsAt = new Map<string, string[]>();
  for (const snake of alive) {
    const head = intended.get(snake.id)?.head;
    if (!head) continue;
    const k = pointKey(head);
    const list = headsAt.get(k) ?? [];
    list.push(snake.id);
    headsAt.set(k, list);
  }

  const dying = new Set<string>();

  for (const snake of alive) {
    const plan = intended.get(snake.id)!;
    if (!plan.head) {
      dying.add(snake.id);
      state.events.push({ tick: state.tick, type: 'die', playerId: snake.id, message: `${snake.name} 撞墙` });
      continue;
    }
    if (state.mode !== 'score') {
      const rivals = headsAt.get(pointKey(plan.head)) ?? [];
      if (rivals.length > 1) {
        dying.add(snake.id);
        state.events.push({
          tick: state.tick,
          type: 'die',
          playerId: snake.id,
          message: `${snake.name} 对撞`,
        });
        continue;
      }
    }
    const hit = collideSelfOrOthers(snake, plan.head, nextBodies, state.mode);
    if (hit.hit) {
      dying.add(snake.id);
      state.events.push({
        tick: state.tick,
        type: 'die',
        playerId: snake.id,
        message: hit.victimId ? `${snake.name} 撞上对手` : `${snake.name} 撞到自己`,
      });
    }
  }

  const eatenKeys = new Set<string>();
  for (const snake of state.snakes) {
    if (!snake.alive) continue;
    if (dying.has(snake.id)) {
      snake.alive = false;
      continue;
    }
    const body = nextBodies.get(snake.id);
    if (!body) continue;
    snake.body = body;
    const head = body[0]!;
    const foodIdx = state.foods.findIndex((f) => pointsEqual(f, head));
    if (foodIdx >= 0) {
      snake.score += 10;
      eatenKeys.add(pointKey(head));
      state.events.push({
        tick: state.tick,
        type: 'eat',
        playerId: snake.id,
        message: `${snake.name} 得分 ${snake.score}`,
      });
    }
  }

  if (eatenKeys.size > 0) {
    state.foods = state.foods.filter((f) => !eatenKeys.has(pointKey(f)));
    fillFood(state);
  }

  maybeFinish(state);
  return state;
}

function maybeFinish(state: GameState): void {
  const living = state.snakes.filter((s) => s.alive);

  if (state.mode === 'solo') {
    if (living.length === 0) {
      finish(state, state.snakes.map((s) => s.id));
    }
    return;
  }

  if (state.mode === 'battle') {
    if (living.length <= 1) {
      if (living.length === 1) {
        living[0]!.kills += 0;
        finish(state, [living[0]!.id]);
      } else {
        const top = maxScoreIds(state.snakes);
        finish(state, top);
      }
    }
    return;
  }

  if (state.targetScore != null) {
    const reached = state.snakes.filter((s) => s.score >= state.targetScore!);
    if (reached.length > 0) {
      const top = Math.max(...reached.map((s) => s.score));
      finish(state, reached.filter((s) => s.score === top).map((s) => s.id));
      return;
    }
  }

  if (state.timeLimitMs != null && state.elapsedMs >= state.timeLimitMs) {
    finish(state, maxScoreIds(state.snakes));
  }
}

function maxScoreIds(snakes: Snake[]): string[] {
  const top = Math.max(0, ...snakes.map((s) => s.score));
  return snakes.filter((s) => s.score === top).map((s) => s.id);
}

function finish(state: GameState, winnerIds: string[]): void {
  state.status = 'ended';
  state.winners = winnerIds;
  const names = state.snakes.filter((s) => winnerIds.includes(s.id)).map((s) => s.name);
  state.events.push({
    tick: state.tick,
    type: 'win',
    message: names.length ? `${names.join('、')} 获胜` : '平局',
  });
}

export function snapshotEvents(state: GameState): GameState['events'] {
  return state.events.slice();
}
