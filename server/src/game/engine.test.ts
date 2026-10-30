import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GameMode, MatchConfig, ParticipantInput, Point } from '../types';
import {
  type GameState, createGame, disqualify, evaluateEnd, occupiedCells,
  queueDirection, rankResults, seedRng, step,
} from './engine';
import { chooseMove } from './bot';
import { asciiGrid, buildInitInfo, buildScriptState, legalMoves } from './observe';

function config(mode: GameMode = 'solo', opts: Partial<MatchConfig> = {}): MatchConfig {
  return {
    mode, teams: false, width: 24, height: 16, wrap: mode === 'score',
    foodCount: mode === 'solo' ? 1 : 3, maxTicks: mode === 'solo' ? 1500 : mode === 'score' ? 500 : 1000,
    targetScore: null, seed: 12345, moveTimeoutMs: 50, initTimeoutMs: 500,
    memoryLimitMB: 32, matchCpuBudgetMs: 30000, ...opts,
  };
}

function players(count: number, teams = false): ParticipantInput[] {
  return Array.from({ length: count }, (_, slot) => ({
    slot, name: `snake-${slot}`, team: teams ? slot % 2 : null,
    source: { kind: 'builtin', bot: 'greedy' },
  }));
}

function game(mode: GameMode = 'solo', opts: Partial<MatchConfig> = {}, foods: Point[] = [{ x: 20, y: 12 }]): GameState {
  return createGame({ config: config(mode, opts), participants: players(mode === 'solo' ? 1 : opts.teams ? 4 : 2, opts.teams), foods });
}

function pose(state: GameState, slot: number, body: Point[], dir: 'up' | 'down' | 'left' | 'right') {
  const snake = state.snakes.find((entry) => entry.slot === slot)!;
  snake.body = body;
  snake.dir = dir;
  snake.pendingDir = null;
  return snake;
}

function snapshot(state: GameState) {
  return { tick: state.tick, status: state.status, foods: state.foods,
    snakes: state.snakes, winners: state.winners, endReason: state.endReason, ranks: rankResults(state) };
}

describe('seeded game creation and input boundaries', () => {
  it('spawns every slot with the documented body and independent config', () => {
    const inputConfig = config('battle');
    const state = createGame({ config: inputConfig, participants: players(4), foods: [] });
    assert.deepEqual(state.snakes.map((snake) => [snake.slot, snake.body[0], snake.dir, snake.body.length]), [
      [0, { x: 3, y: 3 }, 'right', 3], [1, { x: 20, y: 3 }, 'left', 3],
      [2, { x: 3, y: 12 }, 'right', 3], [3, { x: 20, y: 12 }, 'left', 3],
    ]);
    inputConfig.seed = 8;
    inputConfig.moveTimeoutMs = 7;
    assert.equal(state.config.seed, 12345);
    assert.equal(buildInitInfo(state, 0).limits.moveTimeoutMs, 50);
  });

  it('rejects invalid teams, slots, participant counts, and unreasonable limits', () => {
    assert.throws(() => createGame({ config: config('solo', { teams: true }), participants: players(4, true) }));
    assert.throws(() => createGame({ config: config('battle', { teams: true }), participants: players(2, true) }));
    const wrongTeams = players(4, true); wrongTeams[2]!.team = 1;
    assert.throws(() => createGame({ config: config('battle', { teams: true }), participants: wrongTeams }));
    const duplicateSlots = players(2); duplicateSlots[1]!.slot = 0;
    assert.throws(() => createGame({ config: config('battle'), participants: duplicateSlots }));
    assert.throws(() => createGame({ config: config('score'), participants: players(1) }));
    for (const options of [{ width: Infinity }, { maxTicks: -1 }, { maxTicks: NaN }, { foodCount: 1e9 }, { seed: -1 }]) {
      assert.throws(() => createGame({ config: config('solo', options), participants: players(1) }));
    }
  });

  it('spawns deterministic food without overlapping living bodies', () => {
    const input = { config: config('battle', { foodCount: 4 }), participants: players(4) };
    const first = createGame(input);
    const second = createGame(input);
    assert.deepEqual(first.foods, second.foods);
    assert.equal(new Set(first.foods.map((food) => `${food.x},${food.y}`)).size, 4);
    assert.ok(first.foods.every((food) => !first.snakes.some((snake) => snake.body.some((part) => part.x === food.x && part.y === food.y))));
    const rng1 = seedRng(0), rng2 = seedRng(0);
    assert.deepEqual(Array.from({ length: 20 }, rng1), Array.from({ length: 20 }, rng2));
  });
});

describe('tick movement and solo rules', () => {
  it('grows one cell and scores ten per food', () => {
    const state = game('solo', {}, [{ x: 4, y: 3 }]);
    step(state);
    assert.equal(state.tick, 1);
    assert.equal(state.snakes[0]!.score, 10);
    assert.equal(state.snakes[0]!.body.length, 4);
    assert.equal(state.foods.length, 1);
    assert.equal(state.events[0]!.type, 'eat');
  });

  it('falls back to the current direction for rejected reversals or malformed input', () => {
    const state = game();
    assert.equal(queueDirection(state, 's0', 'left'), false);
    assert.equal(queueDirection(state, 's0', 'nope' as never), false);
    assert.equal(queueDirection(state, 'missing', 'up'), false);
    assert.equal(queueDirection(state, 's0', 'up'), true);
    assert.equal(queueDirection(state, 's0', 'left'), false);
    step(state);
    assert.deepEqual(state.snakes[0]!.body[0], { x: 3, y: 2 });
  });

  it('records wall death and leaves the death position available for observation', () => {
    const state = game();
    const snake = pose(state, 0, [{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }], 'left');
    step(state);
    assert.equal(snake.alive, false);
    assert.equal(snake.deathReason, 'wall');
    assert.equal(snake.deathTick, 1);
    assert.deepEqual(snake.body[0], { x: 0, y: 1 });
    assert.equal(state.endReason, 'all_dead');
    assert.deepEqual(rankResults(state), [{ slot: 0, rank: 1 }]);
    assert.deepEqual(state.winners, []);
    step(state);
    assert.equal(state.tick, 1);
    assert.equal(queueDirection(state, 0, 'up'), false);
  });

  it('records self collision but permits moving into the vacating tail', () => {
    const blocked = game();
    pose(blocked, 0, [{ x: 3, y: 3 }, { x: 3, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 3 }, { x: 5, y: 3 }], 'right');
    step(blocked);
    assert.equal(blocked.snakes[0]!.deathReason, 'self');
    const open = game();
    pose(open, 0, [{ x: 3, y: 3 }, { x: 3, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 3 }], 'right');
    step(open);
    assert.equal(open.snakes[0]!.alive, true);
    assert.deepEqual(open.snakes[0]!.body[0], { x: 4, y: 3 });
  });

  it('ends on maxTicks, never wall time', () => {
    const state = game('solo', { maxTicks: 2 });
    step(state); assert.equal(state.status, 'running');
    step(state); assert.equal(state.status, 'ended');
    assert.equal(state.endReason, 'max_ticks');
    assert.deepEqual(state.winners, ['s0']);
  });
});

describe('score mode', () => {
  it('wraps edges, ignores rivals, and still checks self collision', () => {
    const state = game('score');
    const a = pose(state, 0, [{ x: 0, y: 3 }, { x: 1, y: 3 }, { x: 2, y: 3 }], 'left');
    pose(state, 1, [{ x: 23, y: 2 }, { x: 23, y: 3 }, { x: 23, y: 4 }], 'up');
    step(state);
    assert.equal(a.alive, true);
    assert.deepEqual(a.body[0], { x: 23, y: 3 });
    const self = game('score');
    pose(self, 0, [{ x: 3, y: 3 }, { x: 3, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 3 }, { x: 5, y: 3 }], 'right');
    step(self);
    assert.equal(self.snakes[0]!.deathReason, 'self');
    assert.equal(self.status, 'running');
  });

  it('ends on targetScore or maxTicks and ties share rank', () => {
    const target = game('score', { targetScore: 10 }, [{ x: 4, y: 3 }]);
    step(target);
    assert.equal(target.endReason, 'target_score');
    assert.deepEqual(target.winners, ['s0']);
    assert.deepEqual(rankResults(target), [{ slot: 0, rank: 1 }, { slot: 1, rank: 2 }]);
    const tie = game('score', { maxTicks: 1 });
    step(tie);
    assert.equal(tie.endReason, 'max_ticks');
    assert.deepEqual(tie.winners, ['s0', 's1']);
    assert.deepEqual(rankResults(tie), [{ slot: 0, rank: 1 }, { slot: 1, rank: 1 }]);
  });

  it('ends when every snake dies and scores remain the ranking criterion', () => {
    const state = game('score');
    state.snakes[0]!.score = 10;
    disqualify(state, 0, { deferEnd: true });
    disqualify(state, 1, { deferEnd: true });
    evaluateEnd(state);
    assert.equal(state.endReason, 'all_dead');
    assert.deepEqual(state.winners, ['s0']);
    assert.deepEqual(rankResults(state), [{ slot: 0, rank: 1 }, { slot: 1, rank: 2 }]);
  });

  it('lets multiple snakes collect the same food on the same tick', () => {
    const state = game('score', {}, [{ x: 5, y: 5 }]);
    pose(state, 0, [{ x: 4, y: 5 }, { x: 3, y: 5 }, { x: 2, y: 5 }], 'right');
    pose(state, 1, [{ x: 6, y: 5 }, { x: 7, y: 5 }, { x: 8, y: 5 }], 'left');
    step(state);
    assert.deepEqual(state.snakes.map((snake) => [snake.score, snake.body.length]), [[10, 4], [10, 4]]);
  });
});

describe('battle collisions, kills, and ranking', () => {
  it('kills both same-cell or exchanged heads without awarding kills', () => {
    for (const distance of [1, 2]) {
      const state = game('battle');
      pose(state, 0, [{ x: 4, y: 5 }, { x: 3, y: 5 }, { x: 2, y: 5 }], 'right');
      pose(state, 1, [{ x: 4 + distance, y: 5 }, { x: 5 + distance, y: 5 }, { x: 6 + distance, y: 5 }], 'left');
      step(state);
      assert.deepEqual(state.snakes.map((snake) => [snake.alive, snake.deathReason, snake.kills]), [[false, 'head', 0], [false, 'head', 0]]);
      assert.equal(state.endReason, 'all_dead');
      assert.deepEqual(state.winners, []);
      assert.deepEqual(rankResults(state), [{ slot: 0, rank: 1 }, { slot: 1, rank: 1 }]);
    }
  });

  it('credits a body collision kill and awards the last living snake', () => {
    const state = game('battle');
    const a = pose(state, 0, [{ x: 4, y: 5 }, { x: 3, y: 5 }, { x: 2, y: 5 }], 'right');
    const b = pose(state, 1, [{ x: 5, y: 4 }, { x: 5, y: 5 }, { x: 5, y: 6 }], 'up');
    step(state);
    assert.equal(a.deathReason, 'snake');
    assert.equal(b.kills, 1);
    assert.equal(b.alive, true);
    assert.equal(state.endReason, 'last_alive');
    assert.deepEqual(state.winners, ['s1']);
  });

  it('ignores bodies from previous deaths for collision and food placement', () => {
    const state = createGame({ config: config('battle'), participants: players(3), foods: [] });
    const corpse = pose(state, 1, [{ x: 5, y: 4 }, { x: 5, y: 5 }, { x: 5, y: 6 }], 'up');
    disqualify(state, 1);
    pose(state, 0, [{ x: 4, y: 5 }, { x: 3, y: 5 }, { x: 2, y: 5 }], 'right');
    assert.ok(!occupiedCells(state).has('5,5'));
    step(state);
    assert.equal(state.snakes[0]!.alive, true);
    assert.equal(corpse.deathReason, 'disqualified');
    assert.deepEqual(corpse.body[0], { x: 5, y: 4 });
  });

  it('ranks survivors before dead, length before score, dead by tick with ties', () => {
    const state = createGame({ config: config('battle'), participants: players(4), foods: [] });
    state.snakes[0]!.alive = false; state.snakes[0]!.deathTick = 2;
    state.snakes[1]!.alive = false; state.snakes[1]!.deathTick = 4;
    state.snakes[2]!.body.push({ x: 0, y: 0 });
    state.snakes[3]!.score = 100;
    assert.deepEqual(rankResults(state), [{ slot: 0, rank: 4 }, { slot: 1, rank: 3 }, { slot: 2, rank: 1 }, { slot: 3, rank: 2 }]);
    state.snakes[0]!.deathTick = 4;
    assert.deepEqual(rankResults(state).slice(0, 2), [{ slot: 0, rank: 3 }, { slot: 1, rank: 3 }]);
  });

  it('selects maxTicks winners by length then score', () => {
    const state = game('battle', { maxTicks: 1 });
    state.snakes[0]!.score = 10;
    step(state);
    assert.equal(state.endReason, 'max_ticks');
    assert.deepEqual(state.winners, ['s0']);
  });

  it('batch disqualification handles simultaneous init failure without early finish', () => {
    const state = game('battle');
    disqualify(state, 0, { deferEnd: true });
    disqualify(state, 1, { deferEnd: true });
    evaluateEnd(state);
    assert.equal(state.tick, 0);
    assert.equal(state.endReason, 'all_dead');
    assert.deepEqual(state.winners, []);
    assert.deepEqual(state.snakes.map((snake) => snake.deathReason), ['disqualified', 'disqualified']);
  });
});

describe('2v2 team rules', () => {
  it('passes through team mates, including exchanged and same-cell heads', () => {
    for (const distance of [1, 2]) {
      const state = game('battle', { teams: true });
      pose(state, 0, [{ x: 4, y: 5 }, { x: 3, y: 5 }, { x: 2, y: 5 }], 'right');
      pose(state, 2, [{ x: 4 + distance, y: 5 }, { x: 5 + distance, y: 5 }, { x: 6 + distance, y: 5 }], 'left');
      step(state);
      assert.equal(state.snakes[0]!.alive, true);
      assert.equal(state.snakes[2]!.alive, true);
      assert.equal(state.status, 'running');
    }
  });

  it('continues after one casualty but ends after a whole opposing team dies', () => {
    const state = game('battle', { teams: true });
    disqualify(state, 1);
    assert.equal(state.status, 'running');
    disqualify(state, 3);
    assert.equal(state.endReason, 'last_alive');
    assert.equal(state.winnerTeam, 0);
    assert.deepEqual(state.winners, ['s0', 's2']);
    assert.deepEqual(rankResults(state), [{ slot: 0, rank: 1 }, { slot: 1, rank: 3 }, { slot: 2, rank: 1 }, { slot: 3, rank: 3 }]);
  });

  it('draws when every team is eliminated on the same tick', () => {
    const state = game('battle', { teams: true });
    for (const slot of [0, 1, 2, 3]) disqualify(state, slot, { deferEnd: true });
    evaluateEnd(state);
    assert.equal(state.endReason, 'all_dead');
    assert.equal(state.winnerTeam, null);
    assert.deepEqual(state.winners, []);
  });

  it('compares alive counts first, then total team length at maxTicks', () => {
    const state = game('battle', { teams: true, maxTicks: 1 });
    disqualify(state, 1);
    state.snakes[3]!.body.push(...Array.from({ length: 5 }, () => ({ x: 20, y: 10 })));
    step(state);
    assert.equal(state.winnerTeam, 0);
    const length = game('battle', { teams: true, maxTicks: 1 });
    length.snakes[0]!.body.push({ x: 0, y: 0 });
    step(length);
    assert.equal(length.winnerTeam, 0);
  });

  it('uses team total score for winners but an individual score triggers the target', () => {
    const state = game('score', { teams: true, maxTicks: 1 });
    state.snakes[0]!.score = 10;
    state.snakes[2]!.score = 20;
    state.snakes[1]!.score = 25;
    step(state);
    assert.equal(state.winnerTeam, 0);
    assert.deepEqual(state.winners, ['s0', 's2']);
    const target = game('score', { teams: true, targetScore: 10 });
    target.snakes[0]!.score = 5;
    target.snakes[2]!.score = 5;
    evaluateEnd(target);
    assert.equal(target.status, 'running');
    target.snakes[1]!.score = 10;
    target.snakes[0]!.score = 9;
    evaluateEnd(target);
    assert.equal(target.endReason, 'target_score');
    assert.equal(target.winnerTeam, 0);
  });
});

describe('script observation and builtin RNG isolation', () => {
  it('provides detached complete script and init state, including dead snakes', () => {
    const state = game('battle');
    const init = buildInitInfo(state, 's0');
    const obs = buildScriptState(state, 0);
    assert.equal(init.protocol, 'serpent-script-v1');
    assert.equal(obs.protocol, 'serpent-script-v1');
    assert.equal(obs.you.id, 's0');
    assert.equal(obs.remainingTicks, 1000);
    assert.deepEqual(obs.legalMoves, ['up', 'down', 'right']);
    obs.you.body[0]!.x = 99;
    obs.foods[0]!.x = 99;
    assert.equal(state.snakes[0]!.body[0]!.x, 3);
    assert.equal(state.foods[0]!.x, 20);
    disqualify(state, 1);
    const after = buildScriptState(state, 0);
    assert.equal(after.snakes.length, 2);
    assert.equal(after.snakes[1]!.alive, false);
    assert.equal(after.snakes[1]!.body.length, 3);
    assert.deepEqual(legalMoves(state, 1), []);
    assert.throws(() => buildScriptState(state, 'missing'));
  });

  it('legalMoves removes reverse and walls, but not potential collisions', () => {
    const state = game();
    pose(state, 0, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], 'left');
    assert.deepEqual(legalMoves(state, 0), ['down']);
    const wrap = game('score');
    pose(wrap, 0, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], 'left');
    assert.deepEqual(legalMoves(wrap, 0), ['up', 'down', 'left']);
  });

  it('renders walls, food, viewer priority, and no dead-body obstacle', () => {
    const state = game('battle', { teams: true }, [{ x: 8, y: 8 }]);
    state.snakes[2]!.body = state.snakes[0]!.body.map((point) => ({ ...point }));
    assert.ok(asciiGrid(state, 0).includes('BBH'));
    assert.ok(asciiGrid(state, 0).startsWith('#'.repeat(26)));
    assert.ok(asciiGrid(state, 0).includes('*'));
    disqualify(state, 1);
    assert.equal(asciiGrid(state, 0).split('\n')[4]![21], '.');
    assert.equal(asciiGrid(game('score'), 0).split('\n').length, 16);
  });

  it('random builtin is deterministic without consuming the food RNG', () => {
    const a = game(), b = game();
    for (let count = 0; count < 10; count++) {
      assert.equal(chooseMove(a, 0, 'random'), chooseMove(b, 0, 'random'));
      a.tick++; b.tick++;
    }
    for (let count = 0; count < 10; count++) chooseMove(a, 0, 'random');
    assert.equal(a.rng(), b.rng());
  });

  it('greedy follows food and ignores team mates as obstacles', () => {
    const state = game('battle', { teams: true }, [{ x: 8, y: 3 }]);
    pose(state, 2, [{ x: 4, y: 2 }, { x: 4, y: 3 }, { x: 4, y: 4 }], 'up');
    assert.equal(chooseMove(state, 0, 'greedy'), 'right');
    assert.equal(chooseMove(game('solo', {}, [{ x: 3, y: 2 }]), 0, 'greedy'), 'up');
  });

  it('is deterministic with repeated builtin simulations and many food refills', () => {
    const run = () => {
      const state = createGame({ config: config('score', { maxTicks: 400 }), participants: players(4) });
      while (state.status === 'running') {
        for (const snake of state.snakes) queueDirection(state, snake.slot, chooseMove(state, snake.slot, snake.slot === 3 ? 'random' : 'greedy'));
        step(state);
      }
      return snapshot(state);
    };
    assert.deepEqual(run(), run());
  });
});
