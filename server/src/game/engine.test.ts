import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGame, queueDirection, seedRng, step } from './engine';
import { chooseMove } from './bot';
import { observe } from './observe';
import type { CreatePlayerInput } from '../types';

function player(id: string, extra?: Partial<CreatePlayerInput>): CreatePlayerInput {
  return { id, name: id, kind: 'human', color: '#fff', ...extra };
}

describe('solo scoring', () => {
  it('grows and scores when eating food', () => {
    const state = createGame({
      mode: 'solo',
      width: 12,
      height: 8,
      players: [player('p1')],
      foods: [{ x: 4, y: 3 }],
      rng: seedRng(1),
    });
    const snake = state.snakes[0]!;
    assert.equal(snake.body[0]?.x, 3);
    assert.equal(snake.body[0]?.y, 3);
    assert.equal(snake.body.length, 3);
    step(state);
    assert.equal(state.snakes[0]!.score, 10);
    assert.equal(state.snakes[0]!.body.length, 4);
    assert.ok(state.foods.length >= 1);
  });

  it('dies on wall and ends the game', () => {
    const state = createGame({
      mode: 'solo',
      width: 8,
      height: 8,
      players: [player('p1')],
      foods: [{ x: 6, y: 6 }],
      rng: seedRng(1),
    });
    queueDirection(state, 'p1', 'up');
    step(state); // y=2
    queueDirection(state, 'p1', 'up');
    step(state); // y=1
    queueDirection(state, 'p1', 'up');
    step(state); // y=0
    queueDirection(state, 'p1', 'up');
    step(state); // wall
    assert.equal(state.snakes[0]!.alive, false);
    assert.equal(state.status, 'ended');
  });

  it('rejects 180 degree reverse', () => {
    const state = createGame({
      mode: 'solo',
      width: 12,
      height: 8,
      players: [player('p1')],
      foods: [{ x: 10, y: 3 }],
      rng: seedRng(1),
    });
    assert.equal(queueDirection(state, 'p1', 'left'), false);
    assert.equal(queueDirection(state, 'p1', 'up'), true);
  });
});

describe('score race', () => {
  it('wraps through walls and ignores other snakes', () => {
    const state = createGame({
      mode: 'score',
      width: 10,
      height: 8,
      wrap: true,
      timeLimitMs: 60_000,
      targetScore: 80,
      players: [player('a', { spawnIndex: 0 }), player('b', { spawnIndex: 1 })],
      foods: [{ x: 0, y: 0 }],
      rng: seedRng(2),
    });
    const a = state.snakes[0]!;
    a.body = [{ x: 0, y: 3 }, { x: 1, y: 3 }, { x: 2, y: 3 }];
    a.dir = 'left';
    const b = state.snakes[1]!;
    b.body = [{ x: 0, y: 3 }, { x: 9, y: 3 }, { x: 8, y: 3 }];
    b.dir = 'right';
    step(state);
    assert.equal(state.snakes[0]!.alive, true);
    assert.equal(state.snakes[1]!.alive, true);
    assert.equal(state.snakes[0]!.body[0]?.x, 9);
  });

  it('ends when target score is reached', () => {
    const state = createGame({
      mode: 'score',
      width: 12,
      height: 8,
      targetScore: 10,
      timeLimitMs: 60_000,
      players: [player('p1')],
      foods: [{ x: 4, y: 3 }],
      rng: seedRng(1),
    });
    step(state);
    assert.equal(state.status, 'ended');
    assert.deepEqual(state.winners, ['p1']);
  });

  it('ends on time limit with highest score', () => {
    const state = createGame({
      mode: 'score',
      width: 12,
      height: 8,
      targetScore: null,
      timeLimitMs: 120,
      tickMs: 120,
      players: [player('a'), player('b', { spawnIndex: 1 })],
      foods: [{ x: 0, y: 0 }],
      rng: seedRng(3),
    });
    state.snakes[0]!.score = 30;
    state.snakes[1]!.score = 10;
    step(state);
    assert.equal(state.status, 'ended');
    assert.deepEqual(state.winners, ['a']);
  });
});

describe('battle', () => {
  it('kills both snakes on head-to-head collision', () => {
    const state = createGame({
      mode: 'battle',
      width: 12,
      height: 8,
      wrap: false,
      players: [player('a'), player('b', { spawnIndex: 1 })],
      foods: [{ x: 0, y: 7 }],
      rng: seedRng(4),
    });
    const a = state.snakes[0]!;
    const b = state.snakes[1]!;
    a.body = [{ x: 4, y: 4 }, { x: 3, y: 4 }, { x: 2, y: 4 }];
    a.dir = 'right';
    b.body = [{ x: 6, y: 4 }, { x: 7, y: 4 }, { x: 8, y: 4 }];
    b.dir = 'left';
    step(state);
    assert.equal(a.alive, false);
    assert.equal(b.alive, false);
    assert.equal(state.status, 'ended');
  });

  it('awards win to the last living snake', () => {
    const state = createGame({
      mode: 'battle',
      width: 12,
      height: 8,
      players: [player('a'), player('b', { spawnIndex: 1 })],
      foods: [{ x: 0, y: 7 }],
      rng: seedRng(5),
    });
    const b = state.snakes[1]!;
    b.body = [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 2 }];
    b.dir = 'up';
    step(state);
    assert.equal(b.alive, false);
    assert.equal(state.snakes[0]!.alive, true);
    assert.equal(state.status, 'ended');
    assert.deepEqual(state.winners, ['a']);
  });
});

describe('agent observation', () => {
  it('marks the acting snake as H and lists legal moves', () => {
    const state = createGame({
      mode: 'solo',
      width: 10,
      height: 6,
      players: [player('bot', { kind: 'agent' })],
      foods: [{ x: 5, y: 3 }],
      rng: seedRng(6),
    });
    const obs = observe(state, 'bot');
    assert.equal(obs.protocol, 'serpent-v1');
    assert.ok(obs.grid.includes('H'));
    assert.ok(obs.legalMoves.includes('right'));
    assert.ok(!obs.legalMoves.includes('left'));
    const move = chooseMove(state, 'bot', 'greedy');
    assert.equal(move, 'right');
  });
});
