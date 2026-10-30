import type {
  MatchParticipantDTO, MatchReviewDTO, ReviewDeath, ReviewMoment, ReviewOption,
  ReviewParticipantStats, ReviewSeries, ReviewTick,
} from '../api-types';
import {
  type DecisionCode, type DecisionTrace, type Direction, type MatchKind, type Replay,
  DIRECTIONS, OPPOSITE, pointsEqual,
} from '../types';
import {
  type GameState, type Snake, nextCell, queueDirection, rankResults, seedRng, step,
} from './engine';
import { legalMoves } from './observe';
import { walkReplay } from '../runner/replay';

export type ReviewInputParticipant = Pick<MatchParticipantDTO, 'slot'> &
  Partial<Pick<MatchParticipantDTO, 'agentId' | 'scriptId' | 'version' | 'builtin'>>;

export interface MatchReviewInput {
  matchId: number;
  kind: MatchKind;
  replay: Replay;
  trace?: DecisionTrace;
  participants?: ReviewInputParticipant[];
}

export interface MatchReviewAnalysis {
  review: MatchReviewDTO;
  reviewTicks: Map<number, Array<ReviewTick | null>>;
  adviceBySlot: Map<number, string[]>;
}

export interface ReviewMetrics { space: number; safeMoves: number; foodDist: number | null }

const SYMBOLS: Readonly<Record<string, Direction>> = { U: 'up', D: 'down', L: 'left', R: 'right' };
const CODES: Readonly<Record<string, DecisionCode>> = {
  o: 'ok', t: 'timeout', e: 'error', i: 'invalid', r: 'reverse', b: 'builtin',
};
const REASONS = { wall: '撞墙', self: '撞到自己', snake: '撞上对手身体', head: '头部对撞', starve: '生命值耗尽', disqualified: '失格' };
const FAILURE_LABELS = { timeout: '超时', error: '报错', invalid: '非法返回', reverse: '掉头' };
type FailureKind = keyof typeof FAILURE_LABELS;

function directionAt(replay: Replay, tick: number, playerIndex: number): Direction | null {
  const symbol = replay.moves[tick]?.[playerIndex];
  return symbol === undefined ? null : SYMBOLS[symbol] ?? null;
}

function decisionAt(trace: DecisionTrace | undefined, tick: number, index: number): DecisionCode | null {
  const code = trace?.codes[tick]?.[index];
  return code === undefined ? null : CODES[code] ?? null;
}

function elapsedAt(trace: DecisionTrace | undefined, tick: number, index: number): number | null {
  const elapsed = trace?.ms[tick]?.[index];
  return elapsed !== undefined && elapsed !== null && Number.isFinite(elapsed) ? elapsed : null;
}

function cloneGame(game: GameState): GameState {
  return {
    ...game, config: { ...game.config }, foods: game.foods.map((food) => ({ ...food })),
    snakes: game.snakes.map((snake) => ({ ...snake, body: snake.body.map((point) => ({ ...point })) })),
    rng: seedRng(0), events: [], winners: [...game.winners],
  };
}

/** Reuses board-sized buffers across all frames and counterfactual steps. */
class MetricWorkspace {
  private readonly neighbors: Int32Array;
  private readonly blocked: Uint8Array;
  private readonly foods: Uint8Array;
  private readonly visited: Uint32Array;
  private readonly queue: Int32Array;
  private readonly distances: Int32Array;
  private generation = 0;

  constructor(private readonly width: number, height: number, wrap: boolean) {
    const area = width * height;
    this.neighbors = new Int32Array(area * 4).fill(-1);
    this.blocked = new Uint8Array(area);
    this.foods = new Uint8Array(area);
    this.visited = new Uint32Array(area);
    this.queue = new Int32Array(area);
    this.distances = new Int32Array(area);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        DIRECTIONS.forEach((dir, index) => {
          const next = nextCell({ x, y }, dir, width, height, wrap);
          if (next) this.neighbors[(y * width + x) * 4 + index] = next.y * width + next.x;
        });
      }
    }
  }

  metrics(game: GameState, snake: Snake): ReviewMetrics {
    const head = snake.body[0];
    if (!snake.alive || !head) return { space: 0, safeMoves: 0, foodDist: null };
    this.blocked.fill(0);
    this.foods.fill(0);
    for (const other of game.snakes) {
      if (!other.alive || (other.slot !== snake.slot &&
        (game.mode !== 'battle' || (game.teams && snake.team === other.team)))) continue;
      for (let index = 0; index < other.body.length - 1; index++) {
        const part = other.body[index];
        this.blocked[part.y * this.width + part.x] = 1;
      }
    }
    for (const food of game.foods) this.foods[food.y * this.width + food.x] = 1;
    const start = head.y * this.width + head.x;
    let safeMoves = 0;
    for (let index = 0; index < DIRECTIONS.length; index++) {
      if (DIRECTIONS[index] === OPPOSITE[snake.dir]) continue;
      const neighbor = this.neighbors[start * 4 + index];
      if (neighbor >= 0 && this.blocked[neighbor] === 0) safeMoves++;
    }
    this.generation++;
    if (this.generation >= 0xffffffff) { this.visited.fill(0); this.generation = 1; }
    const generation = this.generation;
    this.queue[0] = start;
    this.distances[start] = 0;
    this.visited[start] = generation;
    let read = 0, count = 1;
    let foodDist: number | null = this.foods[start] ? 0 : null;
    while (read < count) {
      const cell = this.queue[read++];
      const distance = this.distances[cell] + 1;
      for (let index = cell * 4; index < cell * 4 + 4; index++) {
        const neighbor = this.neighbors[index];
        if (neighbor < 0 || this.blocked[neighbor] || this.visited[neighbor] === generation) continue;
        this.visited[neighbor] = generation;
        this.distances[neighbor] = distance;
        this.queue[count++] = neighbor;
        if (foodDist === null && this.foods[neighbor]) foodDist = distance;
      }
    }
    return { space: count - 1, safeMoves, foodDist };
  }
}

export function reviewMetrics(game: GameState, slot: number): ReviewMetrics {
  const snake = game.snakes.find((item) => item.slot === slot);
  if (!snake) throw new RangeError('未知复盘选手');
  return new MetricWorkspace(game.width, game.height, game.wrap).metrics(game, snake);
}

function optionsFor(game: GameState, replay: Replay, playerIndex: number, workspace: MetricWorkspace): ReviewOption[] {
  const player = replay.players[playerIndex];
  if (!player) return [];
  const snake = game.snakes.find((item) => item.slot === player.slot);
  if (!snake?.alive || !replay.moves[game.tick]) return [];
  const legal = legalMoves(game, snake.slot);
  const applied = directionAt(replay, game.tick, playerIndex);
  return DIRECTIONS.filter((dir) => dir !== OPPOSITE[snake.dir]).map((dir) => {
    const hypothetical = cloneGame(game);
    replay.players.forEach((other, index) => {
      const direction = other.slot === snake.slot ? dir : directionAt(replay, game.tick, index);
      if (direction) queueDirection(hypothetical, other.slot, direction);
    });
    step(hypothetical);
    const result = hypothetical.snakes.find((item) => item.slot === snake.slot);
    return { dir, legal: legal.includes(dir), death: result?.deathReason ?? null,
      space: result ? workspace.metrics(hypothetical, result).space : 0, chosen: dir === applied };
  });
}

export function reviewOptions(game: GameState, replay: Replay, slot: number): ReviewOption[] {
  return optionsFor(game, replay, replay.players.findIndex((player) => player.slot === slot),
    new MetricWorkspace(game.width, game.height, game.wrap));
}

function emptySeries(slot: number): ReviewSeries {
  return { slot, score: [], length: [], alive: [], hp: [], space: [], safeMoves: [], foodDist: [],
    decision: [], moveMs: [], move: [] };
}

function emptyStats(): ReviewParticipantStats {
  return { survivalTicks: 0, decisions: 0, ok: 0, timeouts: 0, errors: 0, invalid: 0, reverses: 0,
    avgMoveMs: null, p95MoveMs: null, maxMoveMs: null, foods: 0, ticksPerFood: null,
    avgSpace: 0, minSpace: 0, lowSpaceTicks: 0, riskyMoves: 0, avgFoodDist: null, minHp: null, lowHpTicks: 0 };
}

/**
 * Survival-64 considers a snake to be starving when it is both low on health
 * and unable to reach food before its remaining health runs out.  Keep the
 * classic hunger heuristic below separate so old replays retain their
 * historical review output.
 */
function isStarving(game: GameState, snake: Snake, foodDist: number | null): boolean {
  if (game.config.maxHp === null || snake.hp === null) return false;
  return snake.alive && snake.hp <= 25 && (foodDist === null || foodDist >= snake.hp);
}

function isRisky(options: ReviewOption[], length: number): boolean {
  const chosen = options.find((option) => option.chosen);
  return Boolean(chosen && (chosen.death !== null || chosen.space < length) &&
    options.some((option) => option.legal && option.death === null && option.space >= length));
}

function killerFor(before: GameState | undefined, snake: Snake, replay: Replay): number | null {
  if (!before || (snake.deathReason !== 'snake' && snake.deathReason !== 'head')) return null;
  const victim = before.snakes.find((other) => other.slot === snake.slot);
  if (!victim?.body[0]) return null;
  const headFor = (other: Snake) => {
    const index = replay.players.findIndex((player) => player.slot === other.slot);
    const dir = directionAt(replay, before.tick, index) ?? other.dir;
    const head = other.body[0];
    return head ? nextCell(head, dir, before.width, before.height, before.wrap) : null;
  };
  const target = headFor(victim);
  if (!target) return null;
  for (const other of before.snakes) {
    if (!other.alive || other.slot === victim.slot || (before.teams && other.team === victim.team)) continue;
    const head = headFor(other);
    if (snake.deathReason === 'head') {
      const oldHead = other.body[0];
      if (head && (pointsEqual(head, target) || (oldHead && pointsEqual(head, victim.body[0]) && pointsEqual(oldHead, target)))) return other.slot;
    } else {
      const eating = head && before.foods.some((food) => pointsEqual(food, head));
      const body = head ? [head, ...other.body].slice(0, other.body.length + (eating ? 1 : 0)) : other.body;
      if (body.some((part) => pointsEqual(part, target))) return other.slot;
    }
  }
  return null;
}

function clippedMoments(moments: ReviewMoment[]): ReviewMoment[] {
  if (moments.length <= 400) return moments.sort((a, b) => a.tick - b.tick);
  const priority = (moment: ReviewMoment) => moment.severity === 'critical' ? 0 : moment.severity === 'warn' ? 1 : moment.kind === 'eat' ? 3 : 2;
  return moments.map((moment, index) => ({ moment, index })).sort((a, b) =>
    priority(a.moment) - priority(b.moment) || a.index - b.index).slice(0, 400)
    .map(({ moment }) => moment).sort((a, b) => a.tick - b.tick);
}

export function buildMatchReview(input: MatchReviewInput): MatchReviewAnalysis {
  const { replay, trace } = input;
  const workspace = new MetricWorkspace(replay.config.width, replay.config.height, replay.config.wrap);
  const series = replay.players.map((player) => emptySeries(player.slot));
  const stats = replay.players.map(() => emptyStats());
  const reviewTicks = new Map<number, Array<ReviewTick | null>>(replay.players.map((player) => [player.slot, []]));
  const deaths = new Map<number, ReviewDeath>();
  const moments: ReviewMoment[] = [];
  const lowStarts = new Map<number, number>();
  const trapped = new Set<number>();
  const lastFood = new Map<number, number>();
  const starving = new Set<number>();
  const starvationContext = new Map<number, { hp: number | null; foodDist: number | null; lastFood: number | null }>();
  const slowCounts = new Map<number, number>();
  let previous: GameState | undefined;
  const final = walkReplay(replay, (game) => {
    for (const event of game.events) {
      if (event.type === 'eat' && event.slot !== undefined) {
        lastFood.set(event.slot, game.tick);
        starving.delete(event.slot);
      }
    }
    replay.players.forEach((player, index) => {
      const snake = game.snakes.find((item) => item.slot === player.slot);
      if (!snake) throw new Error('复盘缺少选手');
      const line = series[index];
      const stat = stats[index];
      const metrics = workspace.metrics(game, snake);
      const decision = decisionAt(trace, game.tick, index);
      const moveMs = decision === null ? null : elapsedAt(trace, game.tick, index);
      const applied = directionAt(replay, game.tick, index);
      line.score.push(snake.score); line.length.push(snake.body.length); line.alive.push(snake.alive ? 1 : 0); line.hp.push(snake.hp);
      line.space.push(metrics.space); line.safeMoves.push(metrics.safeMoves); line.foodDist.push(metrics.foodDist);
      line.decision.push(decision); line.moveMs.push(moveMs); line.move.push(applied);
      if (snake.alive && snake.hp !== null) {
        stat.minHp = stat.minHp === null ? snake.hp : Math.min(stat.minHp, snake.hp);
        if (snake.hp <= 25) stat.lowHpTicks++;
      }
      const options = snake.alive && applied !== null ? optionsFor(game, replay, index, workspace) : [];
      const tickReview: ReviewTick | null = options.length ? { tick: game.tick, slot: snake.slot, decision, moveMs, applied, options } : null;
      reviewTicks.get(snake.slot)?.push(tickReview);
      const fastLimit = game.config.moveTimeoutMs * 0.8;
      if (moveMs !== null && moveMs > fastLimit && (slowCounts.get(snake.slot) ?? 0) < 10) {
        slowCounts.set(snake.slot, (slowCounts.get(snake.slot) ?? 0) + 1);
        moments.push({ tick: game.tick, slot: snake.slot, kind: 'slow_move', severity: 'warn',
          message: `第 ${game.tick} 拍，${snake.name} 决策耗时 ${moveMs}ms，超过 ${fastLimit}ms 阈值（上限 ${game.config.moveTimeoutMs}ms）。` });
      }
      if (snake.alive) {
        if (metrics.space < snake.body.length) {
          stat.lowSpaceTicks++;
          if (!lowStarts.has(snake.slot)) {
            lowStarts.set(snake.slot, game.tick);
            moments.push({ tick: game.tick, slot: snake.slot, kind: 'low_space', severity: 'warn',
              message: `第 ${game.tick} 拍，${snake.name} 可达空间 ${metrics.space} 格，小于身长 ${snake.body.length}。` });
          }
        } else lowStarts.delete(snake.slot);
        if (metrics.safeMoves === 0) {
          if (!trapped.has(snake.slot)) moments.push({ tick: game.tick, slot: snake.slot, kind: 'trapped', severity: 'critical',
            message: `第 ${game.tick} 拍，${snake.name} 安全方向为 0 个，身长 ${snake.body.length}。` });
          trapped.add(snake.slot);
        } else trapped.delete(snake.slot);
        if (isRisky(options, snake.body.length)) {
          stat.riskyMoves++;
          const chosen = options.find((option) => option.chosen);
          const safe = options.find((option) => option.legal && option.death === null && option.space >= snake.body.length);
          if (chosen && safe) moments.push({ tick: game.tick, slot: snake.slot, kind: 'risky_move', severity: 'warn',
            message: `第 ${game.tick} 拍，${snake.name} 选择 ${chosen.dir} 后${chosen.death ? REASONS[chosen.death] : `仅剩 ${chosen.space} 格空间`}；${safe.dir} 可达 ${safe.space} 格，身长 ${snake.body.length}。` });
        }
        if (game.config.maxHp !== null) {
          const lowHealth = isStarving(game, snake, metrics.foodDist);
          if (lowHealth) {
            if (!starving.has(snake.slot)) moments.push({ tick: game.tick, slot: snake.slot, kind: 'starving', severity: 'warn',
              message: `第 ${game.tick} 拍，${snake.name} 生命值仅 ${snake.hp}，最近食物${metrics.foodDist === null ? '不可达' : `距离 ${metrics.foodDist} 步`}，可能在进食前耗尽。` });
            starving.add(snake.slot);
          } else starving.delete(snake.slot);
        } else {
          const hungerTicks = game.tick - (lastFood.get(snake.slot) ?? 0);
          if ((game.mode === 'solo' || game.mode === 'score') && hungerTicks > 2 * (game.width + game.height) && metrics.foodDist !== null) {
            if (!starving.has(snake.slot)) moments.push({ tick: game.tick, slot: snake.slot, kind: 'starving', severity: 'info',
              message: `第 ${game.tick} 拍，${snake.name} 已 ${hungerTicks} 拍未吃食物，最近食物距离 ${metrics.foodDist} 步。` });
            starving.add(snake.slot);
          } else starving.delete(snake.slot);
        }
      }
      if (!snake.alive && snake.deathTick === game.tick && !deaths.has(snake.slot) && snake.deathReason) {
        const decisionTick = snake.deathReason === 'disqualified' ? game.tick : game.tick - 1;
        const lastDecision = reviewTicks.get(snake.slot)?.[decisionTick] ?? null;
        const death: ReviewDeath = { tick: game.tick, reason: snake.deathReason, decisionTick,
          decision: lastDecision, hadSafeAlternative: Boolean(lastDecision?.options.some((option) => !option.chosen && option.legal && option.death === null)),
          trappedSince: lowStarts.get(snake.slot) ?? null, killerSlot: killerFor(previous, snake, replay),
          lastTicks: [] };
        if (snake.deathReason === 'starve') {
          starvationContext.set(snake.slot, {
            hp: line.hp[game.tick] ?? line.hp[game.tick - 1] ?? snake.hp,
            foodDist: line.foodDist[game.tick - 1] ?? null,
            lastFood: lastFood.has(snake.slot) ? lastFood.get(snake.slot)! : null,
          });
        }
        for (let tick = Math.max(0, game.tick - 8); tick < game.tick; tick++) {
          death.lastTicks.push({ tick, space: line.space[tick], safeMoves: line.safeMoves[tick], move: line.move[tick] });
        }
        deaths.set(snake.slot, death);
        moments.push({ tick: game.tick, slot: snake.slot, kind: 'death', severity: 'critical',
          message: `第 ${game.tick} 拍，${snake.name} ${REASONS[snake.deathReason]}，最终分数 ${snake.score}，身长 ${snake.body.length}。` });
        if (snake.deathReason === 'disqualified') moments.push({ tick: game.tick, slot: snake.slot, kind: 'disqualified', severity: 'critical',
          message: `第 ${game.tick} 拍，${snake.name} 失格，存活 ${game.tick} 拍，最终身长 ${snake.body.length}。` });
      }
    });
    for (const event of game.events) {
      if (event.type === 'eat' && event.slot !== undefined) {
        const index = replay.players.findIndex((player) => player.slot === event.slot);
        const snake = game.snakes.find((item) => item.slot === event.slot);
        if (index >= 0 && snake) {
          stats[index].foods++;
          lastFood.set(snake.slot, game.tick); starving.delete(snake.slot);
          moments.push({ tick: game.tick, slot: snake.slot, kind: 'eat', severity: 'info',
            message: `第 ${game.tick} 拍，${snake.name} 吃到第 ${stats[index].foods} 个食物，分数 ${snake.score}，身长 ${snake.body.length}。` });
        }
      }
      if (event.type === 'win') {
        for (const id of game.winners) {
          const snake = game.snakes.find((item) => item.id === id);
          if (snake) moments.push({ tick: game.tick, slot: snake.slot, kind: 'win', severity: 'info',
            message: `第 ${game.tick} 拍，${snake.name} 获胜，分数 ${snake.score}，身长 ${snake.body.length}。` });
        }
      }
    }
    for (const snake of game.snakes) {
      const old = previous?.snakes.find((item) => item.slot === snake.slot);
      const added = snake.kills - (old?.kills ?? 0);
      if (added > 0) moments.push({ tick: game.tick, slot: snake.slot, kind: 'kill', severity: 'info',
        message: `第 ${game.tick} 拍，${snake.name} 击杀 ${added} 条蛇，累计击杀 ${snake.kills}。` });
    }
    previous = cloneGame(game);
  });

  const adviceBySlot = new Map<number, string[]>();
  const ranks = new Map(rankResults(final).map((item) => [item.slot, item.rank]));
  const participants = replay.players.map((player, index) => {
    const snake = final.snakes.find((item) => item.slot === player.slot);
    if (!snake) throw new Error('复盘缺少最终选手');
    const line = series[index], stat = stats[index];
    const times: number[] = [], spaces: number[] = [], foodDistances: number[] = [];
    line.decision.forEach((code, tick) => {
      if (code !== null) stat.decisions++;
      if (code === 'ok') stat.ok++;
      if (code === 'timeout') stat.timeouts++;
      if (code === 'error') stat.errors++;
      if (code === 'invalid') stat.invalid++;
      if (code === 'reverse') stat.reverses++;
      const elapsed = line.moveMs[tick];
      if (elapsed !== null) times.push(elapsed);
      if (line.alive[tick]) {
        spaces.push(line.space[tick]);
        const distance = line.foodDist[tick];
        if (distance !== null) foodDistances.push(distance);
      }
    });
    times.sort((a, b) => a - b);
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    stat.survivalTicks = snake.deathTick ?? final.tick;
    stat.ticksPerFood = stat.foods ? stat.survivalTicks / stat.foods : null;
    stat.avgSpace = spaces.length ? mean(spaces) : 0;
    stat.minSpace = spaces.length ? Math.min(...spaces) : 0;
    stat.avgFoodDist = foodDistances.length ? mean(foodDistances) : null;
    stat.avgMoveMs = times.length ? mean(times) : null;
    stat.p95MoveMs = times.length ? times[Math.max(0, Math.ceil(times.length * 0.95) - 1)] : null;
    stat.maxMoveMs = times.length ? times[times.length - 1] : null;
    const advice: string[] = [];
    const death = deaths.get(snake.slot) ?? null;
    if (death?.hadSafeAlternative) {
      const alternative = death.decision?.options.find((option) => !option.chosen && option.legal && option.death === null);
      const chosen = death.decision?.options.find((option) => option.chosen);
      if (alternative && chosen) advice.push(`第 ${death.decisionTick} 拍，${snake.name} 选择 ${chosen.dir} 后${REASONS[death.reason]}，而 ${alternative.dir} 安全且可达 ${alternative.space} 格。建议对每个候选方向做 flood fill，优先选择可达空间不小于身长 ${snake.body.length} 的方向。`);
    }
    if (death?.trappedSince !== null && death?.trappedSince !== undefined && death.trappedSince < death.tick) {
      const minimum = Math.min(...line.space.slice(death.trappedSince, death.tick));
      advice.push(`从第 ${death.trappedSince} 拍起，${snake.name} 可达空间一直小于身长，最少 ${minimum} 格，被困 ${death.tick - death.trappedSince} 拍后死亡。追食物前先确认吃完后仍有退路。`);
    }
    if (death?.reason === 'starve') {
      const context = starvationContext.get(snake.slot);
      const hp = context?.hp ?? snake.hp;
      const food = context?.foodDist;
      const last = context?.lastFood;
      const foodText = food === null || food === undefined ? '最近食物不可达' : `最近食物距离 ${food} 步`;
      const lastText = last === null || last === undefined ? '本局尚未进食' : `上次进食在第 ${last} 拍`;
      advice.push(`${snake.name} 在第 ${death.tick} 拍生命值耗尽（${hp ?? 0} HP，${foodText}，${lastText}）。建议在生命值降至 25 前规划安全食物路径，必要时优先选择可达食物而非追求更大空间。`);
    }
    const fixes: Record<FailureKind, string> = { timeout: '减少搜索节点并设置计算预算', error: '检查空值和边界，并用 try/catch 处理预期异常', invalid: '确保同步返回 up、down、left、right 四个方向字符串之一', reverse: '过滤 OPPOSITE[you.dir]，避免 180 度掉头' };
    for (const kind of Object.keys(FAILURE_LABELS) as FailureKind[]) {
      const first = line.decision.indexOf(kind);
      if (first < 0) continue;
      let count = 0;
      for (let tick = first; tick < line.decision.length; tick++) {
        if (line.decision[tick] !== kind) continue;
        count++;
        if (tick > 0 && line.decision[tick - 1] === kind) continue;
        let end = tick + 1;
        while (line.decision[end] === kind) end++;
        moments.push({ tick, slot: snake.slot, kind, severity: 'warn',
          message: `第 ${tick} 拍，${snake.name} 开始连续 ${end - tick} 次${FAILURE_LABELS[kind]}，末拍 ${end - 1}。` });
      }
      advice.push(`${snake.name} 首次在第 ${first} 拍${FAILURE_LABELS[kind]}，全局共 ${count} 次；建议${fixes[kind]}。`);
    }
    if (stat.p95MoveMs !== null && stat.p95MoveMs > replay.config.moveTimeoutMs * 0.8) {
      const tick = line.moveMs.findIndex((value) => value !== null && value > replay.config.moveTimeoutMs * 0.8);
      advice.push(`${snake.name} 从第 ${tick} 拍出现慢决策，P95 耗时 ${stat.p95MoveMs}ms，接近 ${replay.config.moveTimeoutMs}ms 上限。建议限制搜索深度并复用棋盘缓冲区。`);
    }
    if (stat.riskyMoves > 0) {
      const first = moments.find((moment) => moment.slot === snake.slot && moment.kind === 'risky_move');
      advice.push(`${snake.name} 共 ${stat.riskyMoves} 次风险决策，首次在第 ${first?.tick ?? 0} 拍。建议先排除立即死亡和空间小于身长 ${snake.body.length} 的候选方向。`);
    }
    if (stat.ticksPerFood !== null && stat.ticksPerFood > 2 * (replay.config.width + replay.config.height)) {
      advice.push(`截至第 ${stat.survivalTicks} 拍，${snake.name} 仅吃到 ${stat.foods} 个食物，平均 ${stat.ticksPerFood.toFixed(1)} 拍一个。建议使用 BFS 追踪可达食物，并保持安全退路。`);
    }
    adviceBySlot.set(snake.slot, advice.slice(0, 8));
    const metadata = input.participants?.find((item) => item.slot === snake.slot);
    return { slot: snake.slot, name: player.name, color: player.color, team: player.team,
      agentId: metadata?.agentId ?? null, scriptId: metadata?.scriptId ?? null,
      version: metadata?.version ?? null, builtin: metadata?.builtin ?? null,
      rank: ranks.get(snake.slot) ?? null, score: snake.score, length: snake.body.length, alive: snake.alive,
      deathTick: snake.deathTick, deathReason: snake.deathReason, kills: snake.kills, stats: stat, death };
  });
  const advice = [...adviceBySlot.values()].flat().slice(0, 8);
  return { reviewTicks, adviceBySlot, review: {
    matchId: input.matchId, kind: input.kind, mode: replay.config.mode, teams: replay.config.teams,
    ticks: final.tick, endReason: final.endReason, winners: final.winners.map((id) => Number(id.slice(1))),
    winnerTeam: final.winnerTeam, config: { ...replay.config }, hasTrace: trace !== undefined,
    participants, moments: clippedMoments(moments), advice, series, seriesRange: { from: 0, to: final.tick },
  } };
}
