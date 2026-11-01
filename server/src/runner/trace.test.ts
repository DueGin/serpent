import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { ParticipantInput, SimulateResult } from '../types';
import { defaultConfig } from './config';
import type { GameMode, MatchConfig, Replay } from '../types';

/** 冻结的旧版（classic）默认配置：基线哈希证明旧规则对局逐字节不变，不随新默认配置变化。 */
function classicConfig(mode: GameMode, seed: number, maxTicks: number, players: number): MatchConfig {
  return { mode, teams: false, width: mode === 'solo' ? 24 : 28, height: mode === 'solo' ? 16 : 20,
    wrap: mode === 'score', foodCount: mode === 'solo' ? 1 : Math.max(3, Math.min(4, players)), maxTicks,
    targetScore: null, seed, moveTimeoutMs: 50, initTimeoutMs: 500, memoryLimitMB: 32, matchCpuBudgetMs: 30_000,
    ruleset: 'classic', maxHp: null };
}

/**
 * 遥测布局测试需要对局在某个参赛者退出后继续进行：survival-64（64×64、score 不提前结束）
 * 仍是受支持的历史规则，固定使用它，测试意图与当前地图尺寸和结束条件无关。
 */
function continuingConfig(mode: GameMode, opts: Parameters<typeof defaultConfig>[1]): MatchConfig {
  return { ...defaultConfig(mode, opts), width: 64, height: 64, ruleset: 'survival-64' };
}

/** 旧回放的 config 没有 ruleset/maxHp；去掉这两个字段后与旧 runner 的输出逐字节比较。 */
function legacyReplayHash(replay: Replay): string {
  const { ruleset: _ruleset, maxHp: _maxHp, ...config } = replay.config;
  return createHash('sha256').update(JSON.stringify({ ...replay, config })).digest('hex');
}
import { runSimulation } from './jobs';
import { replayFrames } from './replay';

function script(slot: number, code: string, name = `脚本${slot}`): ParticipantInput {
  return { slot, name, team: null, source: { kind: 'script', code } };
}

function traceOf(result: SimulateResult) {
  assert.ok(result.trace);
  assert.equal(result.trace.v, 1);
  assert.equal(result.trace.ms.length, result.trace.codes.length);
  assert.ok(result.trace.codes.length === result.replay.moves.length ||
    result.trace.codes.length === result.replay.moves.length + 1);
  for (const [tick, codes] of result.trace.codes.entries()) {
    assert.equal(codes.length, result.replay.players.length);
    assert.match(codes, /^[oteirb.]+$/);
    const row: Array<number | null> | undefined = result.trace.ms[tick];
    assert.ok(row);
    assert.equal(row.length, result.replay.players.length);
    for (let playerIndex = 0; playerIndex < codes.length; playerIndex++) {
      const elapsed: number | null | undefined = row[playerIndex];
      if (codes[playerIndex] === '.' || codes[playerIndex] === 'b') {
        assert.equal(elapsed, null);
      } else {
        assert.ok(typeof elapsed === 'number' && Number.isFinite(elapsed) && elapsed >= 0);
        assert.ok(Math.abs(elapsed * 100 - Math.round(elapsed * 100)) < 1e-8);
      }
    }
  }
  return result.trace;
}

test('决策遥测区分错误、非法返回、掉头和正常返回，并保持失败时原方向', async () => {
  const result = await runSimulation({
    config: { ...defaultConfig('score', { seed: 7, maxTicks: 1, players: 4 }), moveTimeoutMs: 1000, initTimeoutMs: 1000 },
    participants: [
      script(0, 'function move(){throw Error("错误")}'),
      script(1, 'function move(){return 42}'),
      script(2, 'function move(s){return {up:"down",down:"up",left:"right",right:"left"}[s.you.dir]}'),
      script(3, 'function move(s){return {direction:s.you.dir.toUpperCase()}}'),
    ],
  });
  const trace = traceOf(result);
  assert.deepEqual(trace.codes, ['eiro']);
  assert.deepEqual(result.replay.moves, ['RLRL']);
  assert.deepEqual(result.participants.map(({ timeouts, errors, invalidMoves }) =>
    ({ timeouts, errors, invalidMoves })), [
    { timeouts: 0, errors: 1, invalidMoves: 0 },
    { timeouts: 0, errors: 0, invalidMoves: 1 },
    { timeouts: 0, errors: 0, invalidMoves: 1 },
    { timeouts: 0, errors: 0, invalidMoves: 0 },
  ]);
});

test('无限循环单独触发超时码，不依赖正常脚本能在极短时限内完成', async () => {
  const result = await runSimulation({
    config: { ...defaultConfig('solo', { seed: 7, maxTicks: 2 }), moveTimeoutMs: 2, initTimeoutMs: 1000 },
    participants: [script(0, 'function move(){while(true){}}')],
  });
  assert.deepEqual(traceOf(result).codes, ['t', 't']);
  assert.deepEqual(result.replay.moves, ['R', 'R']);
  const participant = result.participants[0];
  assert.ok(participant);
  assert.equal(participant.timeouts, 2);
  assert.equal(participant.errors, 0);
  assert.equal(participant.invalidMoves, 0);
});

test('正常脚本与内置 bot 遥测按 replay.players 排列，已死者不再决策', async () => {
  const result = await runSimulation({
    config: { ...continuingConfig('score', { seed: 22, maxTicks: 52, players: 2 }), moveTimeoutMs: 1000, initTimeoutMs: 1000 },
    participants: [
      { slot: 1, name: '内置', team: null, source: { kind: 'builtin', bot: 'greedy' } },
      script(0, 'function move(){return false}'),
    ],
  });
  const trace = traceOf(result);
  assert.deepEqual(result.replay.players.map(player => player.slot), [0, 1]);
  assert.equal(trace.codes.length, result.replay.moves.length);
  assert.equal(trace.codes[49], 'ib');
  assert.equal(trace.codes[50], '.b');
  assert.deepEqual(trace.ms[50], [null, null]);
  assert.equal(trace.ms[0]?.[1], null);

  const ok = await runSimulation({ config: defaultConfig('solo', { seed: 1, maxTicks: 2 }),
    participants: [script(0, 'function move(s){return s.you.dir}')] });
  assert.deepEqual(traceOf(ok).codes, ['o', 'o']);
});

test('撞墙死亡后不再记录脚本耗时，死亡轮与下一轮按 tick 对齐', async () => {
  const result = await runSimulation({
    config: { ...continuingConfig('battle', { seed: 9, maxTicks: 6, players: 4 }), moveTimeoutMs: 1000, initTimeoutMs: 1000 },
    participants: [script(0, 'function move(){return "up"}'),
      ...[1, 2, 3].map(slot => script(slot, 'function move(s){return s.you.dir}'))],
  });
  const trace = traceOf(result);
  assert.deepEqual(trace.codes, ['oooo', 'oooo', 'oooo', 'oooo', '.ooo', '.ooo']);
  assert.deepEqual(result.replay.moves, ['ULRL', 'ULRL', 'ULRL', 'ULRL', '.LRL', '.LRL']);
  const participant = result.participants.find(player => player.slot === 0);
  assert.ok(participant);
  assert.equal(participant.deathTick, 4);
  assert.equal(participant.deathReason, 'wall');
  assert.equal(trace.ms[4]?.[0], null);
});

test('失格结束轮仍记录遥测，codes 比 moves 多一条且旧回放逐字节一致', async () => {
  const config = classicConfig('score', 2, 100, 2);
  config.initTimeoutMs = 1000;
  config.moveTimeoutMs = 1000;
  const result = await runSimulation({ config,
    participants: [script(0, 'function move(){return false}', '甲'), script(1, 'function move(){return false}', '乙')] });
  const trace = traceOf(result);
  assert.equal(result.ticks, 49);
  assert.equal(trace.codes.length, 50);
  assert.equal(result.replay.moves.length, 49);
  assert.ok(trace.codes.every(code => code === 'ii'));
  assert.deepEqual(result.replay.disqualifications,
    [{ tick: 49, slot: 0, phase: 'move' }, { tick: 49, slot: 1, phase: 'move' }]);
  assert.equal(replayFrames(result.replay).length, result.ticks + 1);
  // 实际运行加入遥测前的 jobs.ts 得到此摘要，包含第 49 拍失格记录。
  assert.equal(legacyReplayHash(result.replay),
    '99e16c64adf04a3155ea5f82c9187d13804fce52955eccc31baaa3ec6c81739b');
});

test('脚本 RNG 与食物 RNG 的旧回放字节不受遥测影响', async () => {
  const config = classicConfig('battle', 55, 60, 2);
  config.initTimeoutMs = 1000;
  config.moveTimeoutMs = 1000;
  const input = { config, participants: [
    script(0, 'function move(s){return s.legalMoves[Math.floor(Math.random()*s.legalMoves.length)]}', '脚本'),
    { slot: 1, name: '内置', team: null, source: { kind: 'builtin' as const, bot: 'greedy' as const } },
  ] };
  const result = await runSimulation(input);
  // 此摘要来自无 trace 的旧 runner；对手吃到食物，覆盖引擎 RNG 的继续推进。
  assert.equal(legacyReplayHash(result.replay),
    '33deab2ee828b1b027e8522b1abeab77051935955923a264144d6792f2409d18');
  const repeat = await runSimulation(input);
  assert.deepEqual(Buffer.from(JSON.stringify(repeat.replay)), Buffer.from(JSON.stringify(result.replay)));
  assert.deepEqual(traceOf(repeat).codes, traceOf(result).codes);
  assert.ok(replayFrames(result.replay).flatMap(frame => frame.events).some(event => event.type === 'eat'));
});

test('初始化失格不会伪造 move 决策轮', async () => {
  const result = await runSimulation({ config: defaultConfig('solo'),
    participants: [script(0, 'function init(){throw Error("初始化失败")} function move(){return "up"}')] });
  assert.deepEqual(traceOf(result), { v: 1, codes: [], ms: [] });
  assert.equal(result.ticks, 0);
});

test('初始化失格者与不连续 slot 仍按 replay.players 排列，内置与已死耗时为 null', async () => {
  const result = await runSimulation({
    config: { ...continuingConfig('score', { seed: 17, maxTicks: 2, players: 2 }), initTimeoutMs: 1000 },
    participants: [script(3, 'function init(){throw Error("初始化失败")} function move(){return "up"}'),
      { slot: 1, name: '内置', team: null, source: { kind: 'builtin', bot: 'greedy' } }],
  });
  assert.deepEqual(result.replay.players.map(player => player.slot), [1, 3]);
  assert.deepEqual(traceOf(result), { v: 1, codes: ['b.', 'b.'], ms: [[null, null], [null, null]] });
  assert.deepEqual(result.replay.disqualifications, [{ tick: 0, slot: 3, phase: 'init' }]);
});
