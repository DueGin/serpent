import {
  type DeathReason,
  type Direction,
  type EndReason,
  type MatchConfig,
  type ParticipantInput,
  type Point,
  DELTA,
  OPPOSITE,
  pointKey,
  pointsEqual,
} from '../types';

export const ENGINE_VERSION = 'serpent-engine-2';

export interface Snake {
  id: string;
  slot: number;
  name: string;
  team: number | null;
  body: Point[];
  dir: Direction;
  pendingDir: Direction | null;
  alive: boolean;
  score: number;
  kills: number;
  deathTick: number | null;
  deathReason: DeathReason | null;
}

export interface GameEvent {
  tick: number;
  type: 'eat' | 'die' | 'win';
  slot?: number;
  message: string;
}

export interface GameState {
  config: MatchConfig;
  mode: MatchConfig['mode'];
  teams: boolean;
  status: 'running' | 'ended';
  width: number;
  height: number;
  wrap: boolean;
  tick: number;
  maxTicks: number;
  targetScore: number | null;
  foods: Point[];
  snakes: Snake[];
  foodCount: number;
  rng: () => number;
  events: GameEvent[];
  winners: string[];
  winnerTeam: number | null;
  endReason: EndReason | null;
}

export interface CreateGameInput {
  config: MatchConfig;
  participants: ParticipantInput[];
  foods?: Point[];
}

export function seedRng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function spawnPose(slot: number, width: number, height: number): { head: Point; dir: Direction } {
  const points: Point[] = [
    { x: 3, y: 3 }, { x: width - 4, y: 3 },
    { x: 3, y: height - 4 }, { x: width - 4, y: height - 4 },
  ];
  return { head: points[slot]!, dir: slot % 2 === 0 ? 'right' : 'left' };
}

export function createGame({ config, participants, foods }: CreateGameInput): GameState {
  if (!['solo', 'score', 'battle'].includes(config.mode)) throw new Error('Invalid game mode');
  if (!participants.length || participants.length > 4 ||
      (config.mode === 'solo' ? participants.length !== 1 : participants.length < 2)) {
    throw new Error('Invalid number of participants');
  }
  if (config.teams && (config.mode === 'solo' || participants.length !== 4)) {
    throw new Error('Team games require four participants in score or battle mode');
  }
  if (!Number.isInteger(config.width) || !Number.isInteger(config.height) ||
      config.width < 8 || config.height < 8 || config.width > 256 || config.height > 256 ||
      !Number.isInteger(config.maxTicks) || config.maxTicks < 1 || config.maxTicks > 1_000_000 ||
      !Number.isInteger(config.foodCount) || config.foodCount < 0 || config.foodCount > 4 ||
      !Number.isInteger(config.seed) || config.seed < 0 || config.seed > 0xffffffff ||
      (config.targetScore !== null && (!Number.isFinite(config.targetScore) || config.targetScore <= 0))) {
    throw new Error('Invalid game dimensions or limits');
  }
  config = { ...config };
  const slots = new Set<number>();
  const snakes = participants.map((p) => {
    if (!Number.isInteger(p.slot) || p.slot < 0 || p.slot > 3 || slots.has(p.slot) ||
        (config.teams && p.team !== p.slot % 2) || (!config.teams && p.team !== null)) {
      throw new Error('Invalid participant slot or team');
    }
    slots.add(p.slot);
    const pose = spawnPose(p.slot, config.width, config.height);
    return {
      id: `s${p.slot}`,
      slot: p.slot,
      name: p.name,
      team: p.team,
      body: Array.from({ length: 3 }, (_, i) => ({
        x: pose.head.x + DELTA[OPPOSITE[pose.dir]].x * i,
        y: pose.head.y + DELTA[OPPOSITE[pose.dir]].y * i,
      })),
      dir: pose.dir,
      pendingDir: null,
      alive: true,
      score: 0,
      kills: 0,
      deathTick: null,
      deathReason: null,
    } satisfies Snake;
  }).sort((a, b) => a.slot - b.slot);
  const state: GameState = {
    config, mode: config.mode, teams: config.teams, status: 'running',
    width: config.width, height: config.height, wrap: config.wrap,
    tick: 0, maxTicks: config.maxTicks, targetScore: config.targetScore,
    foods: foods ? foods.map((p) => ({ ...p })) : [], snakes,
    foodCount: config.foodCount, rng: seedRng(config.seed),
    events: [], winners: [], winnerTeam: null, endReason: null,
  };
  if (!foods) fillFood(state);
  return state;
}

export function nextCell(point: Point, dir: Direction, width: number, height: number, wrap: boolean): Point | null {
  let x = point.x + DELTA[dir].x;
  let y = point.y + DELTA[dir].y;
  if (wrap) {
    x = (x + width) % width;
    y = (y + height) % height;
  }
  return x < 0 || y < 0 || x >= width || y >= height ? null : { x, y };
}

export function occupiedCells(state: GameState): Set<string> {
  const occupied = new Set(state.foods.map(pointKey));
  for (const snake of state.snakes) {
    if (!snake.alive) continue;
    for (const point of snake.body) occupied.add(pointKey(point));
  }
  return occupied;
}

export function emptyCells(state: GameState): Point[] {
  const occupied = occupiedCells(state);
  const cells: Point[] = [];
  for (let y = 0; y < state.height; y++) {
    for (let x = 0; x < state.width; x++) {
      if (!occupied.has(`${x},${y}`)) cells.push({ x, y });
    }
  }
  return cells;
}

export function spawnFood(state: GameState): Point | null {
  const cells = emptyCells(state);
  return cells.length ? cells[Math.floor(state.rng() * cells.length)]! : null;
}

function fillFood(state: GameState): void {
  while (state.foods.length < state.foodCount) {
    const food = spawnFood(state);
    if (!food) break;
    state.foods.push(food);
  }
}

export function resolveDir(snake: Snake): Direction {
  return snake.pendingDir && snake.pendingDir !== OPPOSITE[snake.dir] ? snake.pendingDir : snake.dir;
}

export function queueDirection(state: GameState, id: string | number, dir: Direction): boolean {
  const snake = typeof id === 'number' ? state.snakes.find((s) => s.slot === id) : state.snakes.find((s) => s.id === id);
  if (state.status !== 'running' || !snake?.alive || !Object.hasOwn(DELTA, dir) ||
      (snake.body.length > 1 && dir === OPPOSITE[snake.dir])) return false;
  snake.pendingDir = dir;
  return true;
}

function kill(state: GameState, snake: Snake, reason: DeathReason): void {
  if (!snake.alive) return;
  snake.alive = false;
  snake.deathTick = state.tick;
  snake.deathReason = reason;
  const labels: Record<DeathReason, string> = {
    wall: '撞墙', self: '撞到自己', snake: '撞上对手', head: '对撞', disqualified: '失格',
  };
  state.events.push({ tick: state.tick, type: 'die', slot: snake.slot, message: `${snake.name} ${labels[reason]}` });
}

export function disqualify(state: GameState, slot: number, opts?: { deferEnd?: boolean }): void {
  const snake = state.snakes.find((s) => s.slot === slot);
  if (state.status !== 'running' || !snake?.alive) return;
  kill(state, snake, 'disqualified');
  if (!opts?.deferEnd) evaluateEnd(state);
}

export function step(state: GameState): GameState {
  if (state.status !== 'running') return state;
  state.tick++;
  state.events = [];
  const alive = state.snakes.filter((snake) => snake.alive);
  const nextHeads = new Map<number, Point | null>();
  const nextBodies = new Map<number, Point[]>();
  for (const snake of alive) {
    snake.dir = resolveDir(snake);
    snake.pendingDir = null;
    const head = nextCell(snake.body[0]!, snake.dir, state.width, state.height, state.wrap);
    nextHeads.set(snake.slot, head);
    if (!head) continue;
    const eating = state.foods.some((food) => pointsEqual(food, head));
    const body = [head, ...snake.body];
    if (!eating) body.pop();
    nextBodies.set(snake.slot, body);
  }
  const deaths = new Map<number, { reason: DeathReason; killer?: number }>();
  for (const snake of alive) {
    const head = nextHeads.get(snake.slot);
    if (!head) {
      deaths.set(snake.slot, { reason: 'wall' });
      continue;
    }
    if (state.mode === 'battle') {
      const opposingHead = alive.some((other) => other.slot !== snake.slot &&
        (!state.teams || snake.team !== other.team) &&
        ((nextHeads.get(other.slot) && pointsEqual(nextHeads.get(other.slot)!, head)) ||
          (nextHeads.get(other.slot) && pointsEqual(nextHeads.get(other.slot)!, snake.body[0]!) &&
            pointsEqual(other.body[0]!, head))));
      if (opposingHead) {
        deaths.set(snake.slot, { reason: 'head' });
        continue;
      }
    }
    const ownBody = nextBodies.get(snake.slot) ?? [];
    if (ownBody.slice(1).some((part) => pointsEqual(part, head))) {
      deaths.set(snake.slot, { reason: 'self' });
      continue;
    }
    if (state.mode === 'battle') {
      for (const other of alive) {
        if (other.slot === snake.slot || (state.teams && snake.team === other.team)) continue;
        if ((nextBodies.get(other.slot) ?? other.body).some((part) => pointsEqual(part, head))) {
          deaths.set(snake.slot, { reason: 'snake', killer: other.slot });
          break;
        }
      }
    }
  }
  for (const snake of alive) {
    const death = deaths.get(snake.slot);
    if (death) {
      kill(state, snake, death.reason);
      if (death.killer !== undefined) state.snakes.find((s) => s.slot === death.killer)!.kills++;
      continue;
    }
    snake.body = nextBodies.get(snake.slot)!;
  }
  const eaten = new Set<string>();
  for (const snake of alive) {
    if (!snake.alive) continue;
    const head = snake.body[0]!;
    if (!state.foods.some((food) => pointsEqual(food, head))) continue;
    snake.score += 10;
    eaten.add(pointKey(head));
    state.events.push({ tick: state.tick, type: 'eat', slot: snake.slot, message: `${snake.name} 得分 ${snake.score}` });
  }
  if (eaten.size) {
    state.foods = state.foods.filter((food) => !eaten.has(pointKey(food)));
    fillFood(state);
  }
  evaluateEnd(state);
  return state;
}

function finish(state: GameState, reason: EndReason, winnerSlots: number[], winnerTeam: number | null = null): void {
  state.status = 'ended';
  state.endReason = reason;
  state.winnerTeam = winnerTeam;
  state.winners = winnerSlots.map((slot) => `s${slot}`);
  const names = state.snakes.filter((snake) => winnerSlots.includes(snake.slot)).map((snake) => snake.name);
  state.events.push({ tick: state.tick, type: 'win', message: names.length ? `${names.join('、')} 获胜` : '平局' });
}

export function evaluateEnd(state: GameState): void {
  if (state.status === 'ended') return;
  const living = state.snakes.filter((snake) => snake.alive);
  if (state.mode === 'solo') {
    if (!living.length) finish(state, 'all_dead', []);
    else if (state.tick >= state.maxTicks) finish(state, 'max_ticks', [living[0]!.slot]);
    return;
  }
  if (state.teams) {
    if (state.mode === 'battle') {
      const teams = new Set(living.map((snake) => snake.team));
      if (!teams.size) {
        finish(state, 'all_dead', []);
        return;
      }
      if (teams.size === 1) {
        const winnerTeam = [...teams][0]!;
        finish(state, 'last_alive', state.snakes.filter((snake) => snake.team === winnerTeam).map((snake) => snake.slot), winnerTeam);
        return;
      }
    } else if (!living.length) {
      const totals = [0, 1].map((team) => state.snakes.filter((snake) => snake.team === team).reduce((sum, snake) => sum + snake.score, 0));
      finishTeamScore(state, totals, 'all_dead');
      return;
    }
    if (state.mode === 'score' && state.targetScore !== null) {
      if (state.snakes.some((snake) => snake.score >= state.targetScore!)) {
        const totals = [0, 1].map((team) => state.snakes.filter((snake) => snake.team === team).reduce((sum, snake) => sum + snake.score, 0));
        finishTeamScore(state, totals, 'target_score');
        return;
      }
    }
    if (state.tick >= state.maxTicks) {
      if (state.mode === 'score') {
        const totals = [0, 1].map((team) => state.snakes.filter((snake) => snake.team === team).reduce((sum, snake) => sum + snake.score, 0));
        finishTeamScore(state, totals, 'max_ticks');
      } else {
        const aliveCounts = [0, 1].map((team) => living.filter((snake) => snake.team === team).length);
        const lengths = [0, 1].map((team) => state.snakes.filter((snake) => snake.team === team).reduce((sum, snake) => sum + snake.body.length, 0));
        const comparison = aliveCounts[0]! - aliveCounts[1]! || lengths[0]! - lengths[1]!;
        const team = comparison === 0 ? null : comparison > 0 ? 0 : 1;
        finish(state, 'max_ticks', state.snakes.filter((snake) => team === null || snake.team === team).map((snake) => snake.slot), team);
      }
    }
    return;
  }
  if (state.mode === 'battle') {
    if (living.length <= 1) {
      finish(state, living.length ? 'last_alive' : 'all_dead', living.map((snake) => snake.slot));
      return;
    }
    if (state.tick >= state.maxTicks) {
      const bestLength = Math.max(...living.map((snake) => snake.body.length));
      const bestScore = Math.max(...living.filter((snake) => snake.body.length === bestLength).map((snake) => snake.score));
      finish(state, 'max_ticks', living.filter((snake) => snake.body.length === bestLength && snake.score === bestScore).map((snake) => snake.slot));
    }
    return;
  }
  if (state.targetScore !== null && state.snakes.some((snake) => snake.score >= state.targetScore!)) {
    finishTopScore(state, 'target_score');
  } else if (!living.length) {
    finishTopScore(state, 'all_dead');
  } else if (state.tick >= state.maxTicks) {
    finishTopScore(state, 'max_ticks');
  }
}

function finishTopScore(state: GameState, reason: EndReason): void {
  const highest = Math.max(...state.snakes.map((snake) => snake.score));
  finish(state, reason, state.snakes.filter((snake) => snake.score === highest).map((snake) => snake.slot));
}

function finishTeamScore(state: GameState, totals: number[], reason: EndReason): void {
  const team = totals[0] === totals[1] ? null : totals[0]! > totals[1]! ? 0 : 1;
  finish(state, reason, state.snakes.filter((snake) => team === null || snake.team === team).map((snake) => snake.slot), team);
}

export function rankResults(state: GameState): Array<{ slot: number; rank: number }> {
  if (state.mode === 'solo') return state.snakes.map((snake) => ({ slot: snake.slot, rank: 1 }));
  if (state.teams) {
    const winners = new Set(state.winners);
    return state.snakes.map((snake) => ({ slot: snake.slot, rank: state.winnerTeam === null ? 1 : winners.has(snake.id) ? 1 : 3 }));
  }
  const order = [...state.snakes].sort((a, b) => {
    if (state.mode === 'score') return b.score - a.score || a.slot - b.slot;
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    return a.alive ? b.body.length - a.body.length || b.score - a.score || a.slot - b.slot
      : (b.deathTick ?? -1) - (a.deathTick ?? -1) || a.slot - b.slot;
  });
  const same = (a: Snake, b: Snake): boolean => state.mode === 'score' ? a.score === b.score :
    a.alive === b.alive && (a.alive ? a.body.length === b.body.length && a.score === b.score : a.deathTick === b.deathTick);
  const ranks = new Map<number, number>();
  order.forEach((snake, index) => ranks.set(snake.slot, index && same(order[index - 1]!, snake) ? ranks.get(order[index - 1]!.slot)! : index + 1));
  return state.snakes.map((snake) => ({ slot: snake.slot, rank: ranks.get(snake.slot)! }));
}
