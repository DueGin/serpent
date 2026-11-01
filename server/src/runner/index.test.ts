import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
  defaultConfig, dryRun, frameState, listScenarios, replayFrames, shutdownRunner,
  simulate, validateScript,
} from './index';
import type { ParticipantInput, SimulateResult } from '../types';
import { createGame, queueDirection, step } from '../game/engine';
import type { GameMode, MatchConfig } from '../types';

function classicConfig(mode: GameMode, seed: number, maxTicks: number, players: number): MatchConfig {
  return { ...defaultConfig(mode, { seed, maxTicks, players }), width: mode === 'solo' ? 24 : 28,
    height: mode === 'solo' ? 16 : 20, wrap: mode === 'score',
    foodCount: mode === 'solo' ? 1 : Math.max(3, Math.min(4, players)), ruleset: 'classic', maxHp: null };
}

process.env.RUNNER_WORKERS ??= '2';
after(async () => { await shutdownRunner(); });

const safeScript = `
  var turn = 0;
  function init(info) { console.log('init', info.you.slot); }
  function move(state) {
    var d = state.legalMoves[Math.floor(Math.random() * state.legalMoves.length)];
    console.log(state.tick, Date.now(), d);
    turn++;
    return { direction: d.toUpperCase(), turn: turn };
  }
`;
function script(code: string, slot = 0): ParticipantInput {
  return { slot, name: `script-${slot}`, team: null, source: { kind: 'script', code } };
}
const greedy: ParticipantInput = { slot: 1, name: 'greedy', team: null, source: { kind: 'builtin', bot: 'greedy' } };
function deterministic(result: SimulateResult) {
  return { ...result, durationMs: 0,
    trace: result.trace ? { ...result.trace, ms: result.trace.ms.map(row => row.map(() => null)) } : undefined,
    participants: result.participants.map((entry) => ({
    ...entry, avgMoveMs: 0, maxMoveMs: 0, cpuMs: 0,
  })) };
}
function assertReplay(result: SimulateResult): void {
  const frames = replayFrames(result.replay);
  assert.equal(frames.length, result.ticks + 1);
  const last = frames.at(-1)!;
  for (const participant of result.participants) {
    const snake = last.snakes.find((entry) => entry.slot === participant.slot)!;
    assert.equal(snake.score, participant.score);
    assert.equal(snake.length, participant.length);
    assert.equal(snake.alive, participant.alive);
  }
  for (const frame of frames) {
    const observed = frameState(result.replay, frame.tick, result.participants[0]!.slot).state;
    assert.deepEqual(observed.foods, frame.foods);
    assert.deepEqual(observed.snakes.map(({ slot, body, dir, alive, score, length, hp }) => ({ slot, body, dir, alive, score, length, hp })), frame.snakes);
  }
}

test('default config obeys tick modes and teams', () => {
  assert.equal(defaultConfig('solo').maxTicks, 1500);
  assert.equal(defaultConfig('score').maxTicks, 500);
  assert.equal(defaultConfig('battle').maxTicks, 1000);
  assert.equal(defaultConfig('score').wrap, false);
  assert.equal(defaultConfig('score').width, 16);
  assert.equal(defaultConfig('solo').height, 16);
  assert.equal(defaultConfig('battle', { teams: true }).width, 32);
  assert.equal(defaultConfig('battle').ruleset, 'survival');
  assert.equal(defaultConfig('solo').maxHp, 100);
  assert.equal(defaultConfig('battle', { players: 2 }).foodCount, 8);
  assert.equal(defaultConfig('battle', { teams: true }).foodCount, 16);
  assert.throws(() => defaultConfig('solo', { teams: true }));
});

test('listScenarios returns eight independent, complete states', () => {
  const scenarios = listScenarios();
  assert.ok(scenarios.length >= 8);
  assert.equal(new Set(scenarios.map((scenario) => scenario.id)).size, scenarios.length);
  scenarios[0]!.state.you.body[0]!.x = -100;
  assert.notEqual(listScenarios()[0]!.state.you.body[0]!.x, -100);
  const edge = scenarios.find((scenario) => scenario.id === 'edge-wall')!;
  assert.ok(!edge.state.legalMoves.includes('left'));
  assert.equal(edge.state.width, 16);
  assert.equal(scenarios.find((scenario) => scenario.id === 'low-hp-food')?.state.you.hp, 6);
  const trap = scenarios.find((scenario) => scenario.id === 'trap-one-exit')!;
  for (const direction of trap.state.legalMoves) {
    const game = createGame({ config: defaultConfig('solo'), participants: [script('')], foods: trap.state.foods });
    game.snakes[0]!.body = trap.state.you.body.map((point) => ({ ...point }));
    game.snakes[0]!.dir = trap.state.you.dir;
    queueDirection(game, 0, direction);
    step(game);
    assert.equal(game.snakes[0]!.alive, direction === 'right');
  }
});

test('tsx worker runs dryRun, init, object/uppercase directions, logs, and persistent globals', async () => {
  const result = await dryRun({ code: `let count = 0; exports.init = () => { count = 7; console.log('ready'); }; exports.move = () => { console.log(count); return {direction: 'UP'}; };` });
  assert.equal(result.ok, true);
  assert.equal(result.direction, 'up');
  assert.deepEqual(result.logs, ['ready', '7']);
  const bad = await dryRun({ code: 'function move(){return "left"}' });
  assert.equal(bad.ok, false);
  assert.equal(bad.legal, false);
  assert.equal((await dryRun({ code: 'function move(){return "up"}', scenario: 'missing' })).ok, false);
});

test('same seed and scripts produce identical game results and replays', async () => {
  const config = defaultConfig('battle', { seed: 55, maxTicks: 60, players: 2 });
  // This checks deterministic game decisions, not the host scheduler's load.
  config.moveTimeoutMs = 1000;
  config.initTimeoutMs = 1000;
  const input = { config, participants: [script(safeScript), greedy] };
  const a = await simulate(input);
  const b = await simulate(input);
  assert.deepEqual(deterministic(a), deterministic(b));
  assertReplay(a);
  assert.equal(a.replay.players[0]!.slot, 0);
  assert.equal(a.replay.moves.length, a.ticks);
  assert.throws(() => frameState(a.replay, -1, 0));
  assert.throws(() => frameState(a.replay, 0, 3));
});

test('init failures disqualify all participants atomically at tick zero and replay', async () => {
  const result = await simulate({ config: defaultConfig('battle', { seed: 1, players: 2 }),
    participants: [script('function init(){throw Error("bad init")} function move(){return "up"}'), script('function init(){throw Error("also bad")} function move(){return "down"}', 1)] });
  assert.equal(result.ticks, 0);
  assert.equal(result.endReason, 'all_dead');
  assert.deepEqual(result.winners, []);
  assert.ok(result.participants.every((participant) => participant.deathReason === 'disqualified'));
  assertReplay(result);
});

test('fifty consecutive invalid decisions keep direction then disqualify without advancing a tick', async () => {
  const result = await simulate({ config: classicConfig('score', 2, 100, 2), participants: [
    script('function move(){return "NOT_A_MOVE"}'), script('function move(){return false}', 1),
  ] });
  assert.equal(result.ticks, 49);
  assert.ok(result.participants.every((participant) => participant.invalidMoves === 50));
  assert.ok(result.participants.every((participant) => participant.deathReason === 'disqualified'));
  assert.ok(result.replay.moves.every((move) => move === 'RL'));
  for (const participant of result.participants) {
    assert.equal(participant.deathTick, 49);
    const frames = replayFrames(result.replay);
    assert.equal(frames[48]!.snakes[participant.slot]!.alive, true);
    assert.equal(frames[49]!.snakes[participant.slot]!.alive, false);
    assert.equal(frames[49]!.events.filter((event) => event.type === 'die' && event.slot === participant.slot).length, 1);
    assert.equal(frameState(result.replay, participant.deathTick!, participant.slot).state.you.alive, false);
  }
  assertReplay(result);
});

test('mid-match disqualification preserves replay with surviving participants', async () => {
  // survival-64 keeps a score match running after one participant leaves, which is what this
  // replay test needs; the current ruleset would end a two-player match at the disqualification.
  const result = await simulate({ config: { ...defaultConfig('score', { seed: 22, maxTicks: 70, players: 2 }),
    width: 64, height: 64, ruleset: 'survival-64' }, participants: [
    script('function move(){return "invalid"}'), greedy,
  ], captureLogs: false });
  assert.equal(result.participants[0]!.deathReason, 'disqualified');
  assert.equal(result.participants[0]!.logs, undefined);
  const deathTick = result.participants[0]!.deathTick!;
  const frames = replayFrames(result.replay);
  assert.equal(deathTick, 49);
  assert.ok(result.ticks > deathTick);
  assert.equal(frames[deathTick - 1]!.snakes[0]!.alive, true);
  assert.equal(frames[deathTick]!.snakes[0]!.alive, false);
  assert.equal(frameState(result.replay, deathTick, 0).state.you.alive, false);
  assert.equal(frames[deathTick]!.events.filter((event) => event.type === 'die' && event.slot === 0).length, 1);
  assert.equal(frames[deathTick + 1]!.events.some((event) => event.type === 'die' && event.slot === 0), false);
  assert.ok(result.replay.moves.slice(49).every((move) => move[0] === '.'));
  assert.equal(replayFrames(result.replay).flatMap((frame) => frame.events)
    .filter((event) => event.type === 'die' && event.slot === 0).length, 1);
  assertReplay(result);
});

test('tick-zero move disqualifications use the same frame semantics as init failures', () => {
  const config = defaultConfig('score', { seed: 22, maxTicks: 1, players: 2 });
  const replay = {
    v: 1 as const, engine: 'serpent-engine-2', config,
    players: [0, 1].map((slot) => ({ slot, name: `s${slot}`, team: null, color: '#ffffff' })),
    moves: ['.L'], disqualifications: [{ tick: 0, slot: 0, phase: 'move' as const }],
  };
  const frames = replayFrames(replay);
  assert.equal(frames[0]!.snakes[0]!.alive, false);
  assert.equal(frameState(replay, 0, 0).state.you.alive, false);
  assert.equal(frames[0]!.events.filter((event) => event.type === 'die' && event.slot === 0).length, 1);
  assert.equal(frames[1]!.events.some((event) => event.type === 'die' && event.slot === 0), false);
});

test('timeouts keep heading and count separately before consecutive failure disqualification', async () => {
  const result = await simulate({ config: { ...classicConfig('score', 3, 60, 2), moveTimeoutMs: 1 },
    participants: [script('function move(){while(true){}}'), script('function move(){while(true){}}', 1)] });
  assert.equal(result.ticks, 49);
  assert.ok(result.replay.moves.every((move) => move === 'RL'));
  assert.ok(result.participants.every((participant) => participant.timeouts === 50 && participant.errors === 0));
  assertReplay(result);
});

test('CPU budgets disqualify without allowing an unbounded match', async () => {
  const matchCpuBudgetMs = 1;
  // survival-64 keeps the match going after the first disqualification, so both scripts must
  // individually hit the budget; the current ruleset would end it with the first one.
  const result = await simulate({ config: { ...defaultConfig('score', { seed: 4, maxTicks: 100, players: 2 }),
    width: 64, height: 64, ruleset: 'survival-64', matchCpuBudgetMs, initTimeoutMs: 1000, moveTimeoutMs: 1000 },
    participants: [script('function move(s){for(let i=0;i<10000;i++) Math.random();return s.you.dir;}'),
      script('function move(s){for(let i=0;i<10000;i++) Math.random();return s.you.dir;}', 1)] });
  assert.ok(result.participants.every((participant) => participant.deathReason === 'disqualified'));
  assert.ok(result.participants.every((participant) => participant.cpuMs > matchCpuBudgetMs));
  for (const participant of result.participants) {
    if (participant.errors + participant.timeouts + participant.invalidMoves === 0) {
      assert.ok(participant.firstError?.includes('CPU'));
    }
  }
  assert.ok(result.ticks < 100);
  assertReplay(result);
});

test('successful decisions reset the consecutive failure counter', async () => {
  const code = 'function move(s){return s.tick%49===48?s.you.dir:"invalid"}';
  const result = await simulate({ config: classicConfig('score', 6, 100, 2),
    participants: [script(code), script(code, 1)] });
  assert.equal(result.endReason, 'max_ticks');
  assert.ok(result.participants.every((participant) => participant.invalidMoves === 98 && participant.alive));
  assertReplay(result);
});

test('team scripts get fixed slot teams and replay identically', async () => {
  const participants: ParticipantInput[] = Array.from({ length: 4 }, (_, slot) => ({
    ...script(`function move(s){if(s.you.team!==s.you.slot%2) throw Error('team'); return s.you.dir}`, slot), team: slot % 2,
  }));
  const result = await simulate({ config: defaultConfig('battle', { teams: true, seed: 5, maxTicks: 10 }), participants });
  assert.equal(result.ticks, 10);
  assert.equal(result.endReason, 'max_ticks');
  assert.ok(result.participants.every((participant) => participant.errors === 0));
  assertReplay(result);
});

test('validate reports fixed check ids and distinguishes compile, move, init, scenario failures', async () => {
  const ids = ['size', 'compile', 'has-move', 'init', 'scenarios', 'trap', 'solo-sim', 'battle-sim', 'perf'];
  const good = await validateScript('function move(s){return s.legalMoves[0]}');
  assert.equal(good.ok, true);
  assert.deepEqual(good.items.map((item) => item.id), ids);
  assert.ok(good.stats);
  const badCompile = await validateScript('function {');
  assert.equal(badCompile.ok, false);
  assert.equal(badCompile.items.find((item) => item.id === 'compile')!.status, 'fail');
  const missing = await validateScript('var value = 1;');
  assert.equal(missing.items.find((item) => item.id === 'has-move')!.status, 'fail');
  const badInit = await validateScript('function init(){throw Error("bang")} function move(){return "up"}');
  assert.equal(badInit.items.find((item) => item.id === 'init')!.status, 'fail');
  const badMove = await validateScript('function move(){return "left"}');
  assert.equal(badMove.items.find((item) => item.id === 'scenarios')!.status, 'fail');
  const big = await validateScript(' '.repeat(65_537));
  assert.equal(big.items.find((item) => item.id === 'size')!.status, 'fail');
});

test('untrusted scripts cannot access host process, require, or escape VM constructors', async () => {
  for (const code of [
    'function move(){return process.exit()}',
    'function move(){return require("node:fs")}',
    `function move(){return this.constructor.constructor('return process')()}`,
    'function move(){while(true){}}',
    'function move(){function f(){return f()} return f()}',
    'function move(){var values=[];while(true){values.push(new Array(65536).fill(123))}}',
    'function move(){Array.prototype.push=null; Object.prototype.poison=true; throw Error("local only")}',
  ]) {
    const result = await dryRun({ code });
    assert.equal(result.ok, false, code);
    assert.ok(result.error, code);
  }
  assert.equal(({} as { poison?: unknown }).poison, undefined);
  assert.deepEqual(([] as number[]).concat([1, 2]), [1, 2]);
  assert.equal((await dryRun({ code: 'function move(){return "up"}' })).ok, true);
});
