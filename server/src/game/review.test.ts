import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import type { DecisionTrace, Direction, GameMode, MatchConfig, ParticipantInput, Point, Replay } from '../types';
import { createGame, type GameState } from './engine';
import { buildMatchReview, reviewMetrics, reviewOptions } from './review';
import { defaultConfig } from '../runner/config';
import { frameState, replayFrames, walkReplay } from '../runner/replay';

function config(mode: GameMode = 'solo', extra: Partial<MatchConfig> = {}): MatchConfig {
  return { ...defaultConfig(mode, { seed: 1, maxTicks: 100 }), width: 8, height: 8, foodCount: 0, ...extra };
}

function players(count: number, teams = false): ParticipantInput[] {
  return Array.from({ length: count }, (_, slot) => ({
    slot, name: `蛇${slot}`, team: teams ? slot % 2 : null, source: { kind: 'builtin', bot: 'greedy' },
  }));
}

function replayFor(moves: string[], mode: GameMode = 'solo', extra: Partial<MatchConfig> = {}, count = mode === 'solo' ? 1 : 2): Replay {
  const settings = config(mode, extra);
  return { v: 1, engine: 'serpent-engine-2', config: settings,
    players: players(count, settings.teams).map(({ slot, name, team }) => ({ slot, name, team, color: '#ffffff' })), moves };
}

function pose(game: GameState, slot: number, body: Point[], dir: Direction) {
  const snake = game.snakes.find((item) => item.slot === slot);
  assert.ok(snake);
  snake.body = body; snake.dir = dir; snake.pendingDir = null;
  return snake;
}

test('review metrics count reachable space, safe directions, nearest food and vacating tails', () => {
  const game = createGame({ config: config(), participants: players(1), foods: [{ x: 5, y: 3 }] });
  assert.deepEqual(reviewMetrics(game, 0), { space: 62, safeMoves: 3, foodDist: 2 });
  const snake = pose(game, 0, [
    { x: 3, y: 3 }, { x: 3, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 3 },
  ], 'right');
  assert.equal(reviewMetrics(game, 0).safeMoves, 2);
  const options = reviewOptions(game, replayFor(['R']), 0);
  const right = options.find((option) => option.dir === 'right');
  assert.ok(right);
  assert.equal(right.death, null);
  assert.equal(right.space, 61);
  snake.alive = false;
  assert.deepEqual(reviewMetrics(game, 0), { space: 0, safeMoves: 0, foodDist: null });
  assert.deepEqual(reviewOptions(game, replayFor(['R']), 0), []);
});

test('closed pockets have no reachable food, space or safe direction', () => {
  const game = createGame({ config: config(), participants: players(1), foods: [{ x: 7, y: 7 }] });
  pose(game, 0, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: 0, y: 2 }], 'up');
  assert.deepEqual(reviewMetrics(game, 0), { space: 0, safeMoves: 0, foodDist: null });
  assert.deepEqual(reviewOptions(game, replayFor(['U']), 0).map(({ dir, legal, death, space }) => ({ dir, legal, death, space })), [
    { dir: 'up', legal: false, death: 'wall', space: 0 },
    { dir: 'left', legal: false, death: 'wall', space: 0 },
    { dir: 'right', legal: true, death: 'self', space: 0 },
  ]);
});

test('counterfactual options use engine deaths and resulting space without mutating source game', () => {
  const game = createGame({ config: config(), participants: players(1), foods: [] });
  pose(game, 0, [{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }], 'left');
  const before = JSON.stringify({ ...game, rng: null });
  const options = reviewOptions(game, replayFor(['L']), 0);
  assert.deepEqual(options, [
    { dir: 'up', legal: true, death: null, space: 62, chosen: false },
    { dir: 'down', legal: true, death: null, space: 62, chosen: false },
    { dir: 'left', legal: false, death: 'wall', space: 0, chosen: true },
  ]);
  assert.equal(JSON.stringify({ ...game, rng: null }), before);
});

test('score wraps for BFS and options while other living snakes do not block', () => {
  const settings = config('score');
  const game = createGame({ config: settings, participants: players(2), foods: [{ x: 7, y: 3 }] });
  pose(game, 0, [{ x: 0, y: 3 }, { x: 1, y: 3 }, { x: 2, y: 3 }], 'left');
  pose(game, 1, [{ x: 7, y: 3 }, { x: 7, y: 4 }, { x: 7, y: 5 }], 'up');
  assert.deepEqual(reviewMetrics(game, 0), { space: 62, safeMoves: 3, foodDist: 1 });
  const left = reviewOptions(game, replayFor(['LU'], 'score'), 0).find((option) => option.dir === 'left');
  assert.deepEqual(left, { dir: 'left', legal: true, death: null, space: 61, chosen: true });
});

test('battle ignores teammates and historical dead bodies in all metrics and options', () => {
  const settings = config('battle', { teams: true });
  const game = createGame({ config: settings, participants: players(4, true), foods: [{ x: 4, y: 3 }] });
  pose(game, 0, [{ x: 3, y: 3 }, { x: 2, y: 3 }, { x: 1, y: 3 }], 'right');
  const enemy = pose(game, 1, [{ x: 3, y: 2 }, { x: 3, y: 1 }, { x: 3, y: 0 }], 'right');
  pose(game, 2, [{ x: 4, y: 3 }, { x: 4, y: 4 }, { x: 4, y: 5 }], 'up');
  const other = game.snakes.find((snake) => snake.slot === 3);
  assert.ok(other); other.alive = false;
  assert.equal(reviewMetrics(game, 0).safeMoves, 2);
  enemy.alive = false;
  assert.deepEqual(reviewMetrics(game, 0), { space: 62, safeMoves: 3, foodDist: 1 });
  const option = reviewOptions(game, replayFor(['R.U.'], 'battle', { teams: true }, 4), 0).find((item) => item.dir === 'right');
  assert.equal(option?.death, null);
  assert.equal(option?.space, 61);
});

test('wall death points to a safe alternative and emits a deterministic risky move', () => {
  const replay = replayFor(['U', 'U', 'U', 'U']);
  const { review, reviewTicks } = buildMatchReview({ matchId: 5, kind: 'test', replay });
  const participant = review.participants[0];
  assert.ok(participant?.death);
  assert.equal(participant.death.tick, 4);
  assert.equal(participant.death.decisionTick, 3);
  assert.equal(participant.death.reason, 'wall');
  assert.equal(participant.death.hadSafeAlternative, true);
  assert.equal(participant.death.trappedSince, null);
  assert.equal(participant.stats.riskyMoves, 1);
  assert.deepEqual(review.moments.filter((moment) => moment.kind === 'risky_move').map((moment) => moment.tick), [3]);
  assert.equal(reviewTicks.get(0)?.[4], null);
  assert.match(review.advice[0] ?? '', /第 3 拍/);
  assert.equal(review.hasTrace, false);
  assert.ok(review.series?.every((line) => line.decision.every((code) => code === null) && line.moveMs.every((ms) => ms === null)));
  assert.equal(participant.stats.decisions, 0);
});

test('low-space and trapped segments keep their first tick and explain later self death', () => {
  const encoded = 'UULLULDDDDRDRRRRUULDLUUURURDRDDDDDDLLLUUURULLLLURUURRRRRRDDDDDDLLLLLLLDRRRRRRRU';
  const replay = replayFor([...encoded], 'solo', { seed: 0, foodCount: 4, maxTicks: 300 });
  const { review } = buildMatchReview({ matchId: 6, kind: 'test', replay });
  const participant = review.participants[0];
  assert.ok(participant?.death);
  assert.equal(participant.death.tick, 79);
  assert.equal(participant.death.reason, 'self');
  assert.equal(participant.death.trappedSince, 71);
  assert.equal(participant.death.hadSafeAlternative, false);
  assert.equal(participant.stats.lowSpaceTicks, 8);
  assert.deepEqual(participant.death.lastTicks.map((tick) => tick.space), [7, 6, 5, 4, 3, 2, 1, 0]);
  assert.deepEqual(review.moments.filter((moment) => moment.kind === 'low_space').map((moment) => moment.tick), [71]);
  assert.deepEqual(review.moments.filter((moment) => moment.kind === 'trapped').map((moment) => moment.tick), [78]);
  assert.ok(review.advice.some((advice) => advice.includes('第 71 拍') && advice.includes('8 拍后死亡')));
});

test('trappedSince resets after escaping an earlier low-space segment', () => {
  const encoded = 'UULLULDDDDDDDRRRURRUUULLULUULDDDDLDDRRDLLURRRULLLUUUURURRDDRDDRUUUURRDDLUR';
  const replay = replayFor([...encoded], 'solo', { seed: 17, foodCount: 4, maxTicks: 300 });
  const { review } = buildMatchReview({ matchId: 12, kind: 'test', replay });
  const participant = review.participants[0];
  assert.ok(participant?.death);
  assert.equal(participant.death.tick, 74);
  assert.equal(participant.death.trappedSince, 73);
  assert.equal(participant.death.hadSafeAlternative, false);
  assert.equal(participant.stats.lowSpaceTicks, 2);
  assert.deepEqual(review.moments.filter((moment) => moment.kind === 'low_space').map((moment) => moment.tick), [40, 73]);
  assert.ok(review.advice.some((advice) => advice.includes('第 73 拍') && advice.includes('1 拍后死亡')));
});

test('head swaps identify the other snake, and body collisions identify their killer', () => {
  const head = buildMatchReview({ matchId: 7, kind: 'test', replay: replayFor(['RL', 'RL', 'RL'], 'battle', { width: 12 }) }).review;
  assert.deepEqual(head.participants.map((participant) => [participant.deathReason, participant.death?.killerSlot]), [['head', 1], ['head', 0]]);
  const snake = buildMatchReview({ matchId: 8, kind: 'test', replay: replayFor(['RU', 'RL', 'RL', 'UL'], 'battle', { width: 12 }) }).review;
  assert.equal(snake.participants[0]?.death?.reason, 'snake');
  assert.equal(snake.participants[0]?.death?.killerSlot, 1);
  assert.equal(snake.participants[1]?.kills, 1);
  assert.ok(snake.moments.some((moment) => moment.kind === 'kill' && moment.slot === 1 && moment.tick === 4));
  const sameCell = buildMatchReview({ matchId: 13, kind: 'test', replay: replayFor(['RL', 'RL'], 'battle', { width: 11 }) }).review;
  assert.deepEqual(sameCell.participants.map((participant) => [participant.deathReason, participant.death?.killerSlot]), [['head', 1], ['head', 0]]);
  const wallKiller = buildMatchReview({ matchId: 14, kind: 'test',
    replay: replayFor(['RU', 'RR', 'UU', 'RL', 'RU', 'UL', 'UU'], 'battle', { width: 12 }) }).review;
  assert.deepEqual(wallKiller.participants.map((participant) => [participant.deathReason, participant.death?.killerSlot]), [['snake', 1], ['wall', null]]);
  assert.equal(wallKiller.participants[1]?.kills, 1);
});

test('trace counts include the final disqualification round and compress consecutive warnings', () => {
  const replay = replayFor(['RL', 'RL'], 'score', { maxTicks: 100 });
  replay.disqualifications = [{ tick: 2, slot: 0, phase: 'move' }, { tick: 2, slot: 1, phase: 'move' }];
  const trace: DecisionTrace = { v: 1, codes: ['ob', 'tb', 'tb'], ms: [[1, null], [2, null], [49, null]] };
  const { review, reviewTicks } = buildMatchReview({ matchId: 9, kind: 'test', replay, trace,
    participants: [{ slot: 0, scriptId: 99, agentId: 10, version: 4 }] });
  const participant = review.participants[0];
  assert.ok(participant);
  assert.equal(review.hasTrace, true);
  assert.equal(participant.scriptId, 99);
  assert.equal(participant.stats.decisions, 3);
  assert.equal(participant.stats.ok, 1);
  assert.equal(participant.stats.timeouts, 2);
  assert.equal(participant.stats.avgMoveMs, 52 / 3);
  assert.equal(participant.stats.p95MoveMs, 49);
  assert.equal(participant.stats.maxMoveMs, 49);
  assert.equal(participant.death?.decisionTick, 2);
  assert.equal(participant.death?.decision, null);
  assert.equal(reviewTicks.get(0)?.[2], null);
  assert.deepEqual(review.series?.[0]?.decision, ['ok', 'timeout', 'timeout']);
  const warnings = review.moments.filter((moment) => moment.kind === 'timeout');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]?.message ?? '', /连续 2 次/);
  assert.ok(review.moments.some((moment) => moment.kind === 'slow_move' && moment.tick === 2));
  assert.ok(review.moments.some((moment) => moment.kind === 'death' && moment.slot === 0));
  assert.ok(review.moments.some((moment) => moment.kind === 'disqualified' && moment.slot === 0));
  assert.equal(review.participants[1]?.stats.avgMoveMs, null);
  assert.equal('logs' in participant, false);
  assert.equal('firstError' in participant, false);
});

test('move disqualification retains its trace round while later dead frames stay empty', () => {
  const replay = replayFor(['RL', '.L', '.L'], 'score', { maxTicks: 3 });
  replay.disqualifications = [{ tick: 1, slot: 0, phase: 'move' }];
  const trace: DecisionTrace = { v: 1, codes: ['ib', 'rb', '.b'], ms: [[1, null], [2, null], [null, null]] };
  const { review, reviewTicks } = buildMatchReview({ matchId: 15, kind: 'test', replay, trace });
  const participant = review.participants[0];
  assert.ok(participant?.death);
  assert.equal(participant.death.tick, 1);
  assert.equal(participant.death.decisionTick, 1);
  assert.equal(participant.death.decision, null);
  assert.equal(participant.death.hadSafeAlternative, false);
  assert.equal(participant.death.killerSlot, null);
  assert.equal(participant.stats.decisions, 2);
  assert.equal(participant.stats.invalid, 1);
  assert.equal(participant.stats.reverses, 1);
  assert.deepEqual(review.series?.[0]?.decision, ['invalid', 'reverse', null, null]);
  assert.deepEqual(review.series?.[0]?.moveMs, [1, 2, null, null]);
  assert.deepEqual(review.series?.[0]?.move, ['right', null, null, null]);
  assert.equal(reviewTicks.get(0)?.filter(Boolean).length, 1);
  assert.equal(review.moments.filter((moment) => moment.slot === 0 && moment.kind === 'disqualified').length, 1);
  assert.equal(review.moments.filter((moment) => moment.slot === 0 && moment.kind === 'death').length, 1);
});

test('init disqualification has no decision and retains empty live metrics', () => {
  const replay = replayFor([]);
  replay.disqualifications = [{ tick: 0, slot: 0, phase: 'init' }];
  const { review } = buildMatchReview({ matchId: 10, kind: 'test', replay, trace: { v: 1, codes: [], ms: [] } });
  const participant = review.participants[0];
  assert.equal(participant?.death?.decision, null);
  assert.equal(participant?.stats.avgSpace, 0);
  assert.equal(participant?.stats.minSpace, 0);
  assert.equal(participant?.stats.decisions, 0);
});

test('incremental replay callbacks preserve all existing frame and viewer semantics', () => {
  const replay = replayFor(['RL', 'RL'], 'score', { maxTicks: 2 });
  replay.disqualifications = [{ tick: 1, slot: 0, phase: 'move' }];
  replay.moves[1] = '.L';
  const frames = replayFrames(replay);
  const ticks: number[] = [];
  const states = new Set<GameState>();
  walkReplay(replay, (game) => { ticks.push(game.tick); states.add(game); });
  assert.deepEqual(ticks, [0, 1, 2]);
  assert.equal(states.size, 1);
  for (const frame of frames) {
    const state = frameState(replay, frame.tick, 0).state;
    assert.deepEqual(state.foods, frame.foods);
    assert.deepEqual(state.snakes.map(({ slot, body, dir, alive, score, length }) => ({ slot, body, dir, alive, score, length })), frame.snakes);
  }
  assert.equal(frames[1]?.snakes[0]?.alive, false);
  assert.equal(frames[1]?.events.filter((event) => event.type === 'die').length, 1);
  assert.throws(() => walkReplay(replay, () => {}, 3), RangeError);
});

test('1000-tick four-player battle review stays within the synchronous analysis budget', (context) => {
  const cycle = ['RLRL', 'DUDU', 'LRLR', 'UDUD'];
  const replay = replayFor(Array.from({ length: 1000 }, (_, tick) => cycle[tick % 4]), 'battle',
    { width: 28, height: 20, maxTicks: 1000, foodCount: 0 }, 4);
  const start = performance.now();
  const { review, reviewTicks } = buildMatchReview({ matchId: 11, kind: 'test', replay });
  const elapsed = performance.now() - start;
  context.diagnostic(`1000 拍 4 人 battle 整局复盘实测 ${elapsed.toFixed(2)}ms`);
  assert.equal(review.ticks, 1000);
  assert.ok(review.participants.every((participant) => participant.alive));
  assert.equal(review.series?.[0]?.space.length, 1001);
  assert.equal(reviewTicks.get(3)?.filter(Boolean).length, 1000);
  assert.ok(elapsed < 1500, `整局复盘耗时 ${elapsed.toFixed(2)}ms`);
});
