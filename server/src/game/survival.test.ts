import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GameMode, Point } from '../types';
import { defaultConfig } from '../runner/config';
import { createGame, queueDirection, step, type GameState } from './engine';
import { asciiGrid } from './observe';

function game(mode: GameMode = 'battle', count = mode === 'solo' ? 1 : 2, teams = false, foods?: Point[]): GameState {
  return createGame({ config: defaultConfig(mode, { players: count, teams, seed: 41, maxTicks: 200 }),
    participants: Array.from({ length: count }, (_, slot) => ({ slot, name: `蛇${slot}`, team: teams ? slot % 2 : null,
      source: { kind: 'builtin' as const, bot: 'greedy' as const } })), foods });
}
function pose(state: GameState, slot: number, body: Point[], dir: 'up' | 'down' | 'left' | 'right') {
  const snake = state.snakes[slot];
  assert.ok(snake);
  snake.body = body; snake.dir = dir;
  return snake;
}
function line(x: number, y: number, length: number, dir: -1 | 1): Point[] {
  return Array.from({ length }, (_, index) => ({ x: x + index * dir, y }));
}

test('survival defaults use a bounded 64x64 board and four food per participant', () => {
  for (const mode of ['solo', 'score', 'battle'] as const) for (const count of mode === 'solo' ? [1] : [2, 3, 4]) {
    const state = game(mode, count);
    assert.equal(state.width, 64); assert.equal(state.height, 64); assert.equal(state.wrap, false);
    assert.equal(state.foods.length, count * 4);
    assert.equal(state.config.maxHp, 100);
    assert.ok(asciiGrid(state, 0).split('\n').every((row) => row.length === 66));
  }
  const score = game('score', 2, false, []);
  const victim = pose(score, 0, [{ x: 0, y: 20 }, { x: 1, y: 20 }, { x: 2, y: 20 }], 'left');
  step(score);
  assert.equal(victim.deathReason, 'wall');
  assert.deepEqual(victim.body[0], { x: 0, y: 20 });
});

test('food consumption grows the body, scores ten, restores hp and refills to capacity', () => {
  const state = game('solo', 1);
  state.foods = [{ x: 11, y: 10 }, { x: 30, y: 20 }, { x: 31, y: 20 }, { x: 32, y: 20 }];
  const snake = pose(state, 0, line(10, 10, 3, -1), 'right'); snake.hp = 2;
  step(state);
  assert.equal(snake.score, 10); assert.equal(snake.body.length, 4); assert.equal(snake.hp, 100);
  assert.equal(state.foods.length, 4); assert.ok(!state.foods.some((food) => food.x === 11 && food.y === 10));
});

test('health decreases only for collision survivors, starves on tick 100, and retains its last value on collision death', () => {
  const hungry = game('solo', 1, false, []);
  const snake = pose(hungry, 0, [{ x: 30, y: 30 }, { x: 29, y: 30 }, { x: 28, y: 30 }], 'up');
  for (let i = 0; i < 99; i++) {
    queueDirection(hungry, 0, (['right', 'down', 'left', 'up'] as const)[i % 4]!);
    step(hungry);
  }
  assert.equal(snake.hp, 1); assert.equal(snake.alive, true);
  queueDirection(hungry, 0, 'up'); step(hungry);
  assert.equal(snake.hp, 0); assert.equal(snake.deathTick, 100); assert.equal(snake.deathReason, 'starve');
  assert.match(hungry.events.find((event) => event.type === 'die')?.message ?? '', /生命值耗尽/);

  const collision = game('solo', 1, false, []);
  const doomed = pose(collision, 0, [{ x: 0, y: 4 }, { x: 1, y: 4 }, { x: 2, y: 4 }], 'left'); doomed.hp = 1;
  step(collision);
  assert.equal(doomed.hp, 1); assert.equal(doomed.deathReason, 'wall');
});

test('same-cell and swapped head collisions compare pre-move length and protect the longer winner', () => {
  for (const distance of [1, 2]) for (const [aLength, bLength] of [[3, 3], [4, 3], [3, 4]]) {
    const state = game('battle', 2, false, []);
    const a = pose(state, 0, line(10, 10, aLength, -1), 'right');
    const b = pose(state, 1, line(10 + distance, 10, bLength, 1), 'left');
    step(state);
    if (aLength === bLength) {
      assert.equal(a.deathReason, 'head'); assert.equal(b.deathReason, 'head');
      assert.equal(a.kills + b.kills, 0);
    } else {
      const winner = aLength > bLength ? a : b, loser = aLength > bLength ? b : a;
      assert.equal(winner.alive, true); assert.equal(winner.kills, 1);
      assert.equal(loser.deathReason, 'head');
    }
  }
});

test('three heads in one cell leave only a unique longest snake alive; tied longest all die', () => {
  for (const tie of [false, true]) {
    const state = game('battle', 3, false, []);
    const a = pose(state, 0, line(10, 10, 5, -1), 'right');
    const b = pose(state, 1, line(12, 10, tie ? 5 : 4, 1), 'left');
    const c = pose(state, 2, [{ x: 11, y: 9 }, { x: 11, y: 8 }, { x: 11, y: 7 }], 'down');
    step(state);
    assert.deepEqual([a.alive, b.alive, c.alive], tie ? [false, false, false] : [true, false, false]);
    assert.equal(a.kills, tie ? 0 : 2);
  }
});

test('body collisions and kills apply to score as well as battle, while teammates pass through and do not duel', () => {
  for (const mode of ['score', 'battle'] as const) {
    const state = game(mode, 2, false, []);
    const a = pose(state, 0, line(10, 10, 3, -1), 'right');
    const b = pose(state, 1, [{ x: 11, y: 9 }, { x: 11, y: 10 }, { x: 11, y: 11 }], 'up');
    step(state);
    assert.equal(a.deathReason, 'snake'); assert.equal(b.kills, 1); assert.equal(b.alive, true);
  }
  for (const mode of ['score', 'battle'] as const) for (const distance of [1, 2]) {
    const state = game(mode, 4, true, []);
    const a = pose(state, 0, line(10, 10, 3, -1), 'right');
    const mate = pose(state, 2, line(10 + distance, 10, 3, 1), 'left');
    step(state);
    assert.equal(a.alive, true); assert.equal(mate.alive, true);
  }
});

test('a boundary casualty uses its old body this tick, then ceases to block on later ticks', () => {
  const state = game('score', 3, false, []);
  const victim = pose(state, 0, [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }], 'right');
  const wall = pose(state, 1, [{ x: 0, y: 10 }, { x: 10, y: 10 }, { x: 11, y: 10 }], 'left');
  pose(state, 2, [{ x: 40, y: 40 }, { x: 39, y: 40 }, { x: 38, y: 40 }], 'right');
  step(state);
  assert.equal(wall.deathReason, 'wall');
  assert.equal(victim.deathReason, 'snake');
  assert.equal(wall.kills, 1);
  const next = pose(state, 2, [{ x: 9, y: 10 }, { x: 8, y: 10 }, { x: 7, y: 10 }], 'right');
  step(state);
  assert.equal(next.alive, true);
  assert.deepEqual(next.body[0], { x: 10, y: 10 });
});

test('score head contests and same-cell teammates follow survival collision rules', () => {
  const score = game('score', 2, false, []);
  const longer = pose(score, 0, line(10, 10, 4, -1), 'right');
  const shorter = pose(score, 1, line(12, 10, 3, 1), 'left');
  step(score);
  assert.equal(longer.alive, true);
  assert.equal(shorter.deathReason, 'head');
  assert.equal(longer.kills, 1);

  const team = game('battle', 4, true, []);
  const a = pose(team, 0, line(10, 10, 3, -1), 'right');
  const mate = pose(team, 2, [{ x: 11, y: 9 }, { x: 11, y: 8 }, { x: 11, y: 7 }], 'down');
  pose(team, 1, [{ x: 30, y: 10 }, { x: 31, y: 10 }, { x: 32, y: 10 }], 'left');
  pose(team, 3, [{ x: 30, y: 30 }, { x: 31, y: 30 }, { x: 32, y: 30 }], 'left');
  step(team);
  assert.equal(a.alive, true); assert.equal(mate.alive, true);
  assert.deepEqual(a.body[0], mate.body[0]);
});
