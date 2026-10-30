import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { MatchConfig, ParticipantInput, SimulateResult } from '../types';
import { shutdownPythonHosts } from '../sandbox/python';
import { defaultConfig, dryRun, replayFrames, shutdownRunner, simulate, validateScript } from './index';
import { runSimulation } from './jobs';

after(async () => { await shutdownRunner(); shutdownPythonHosts(); });

function python(code: string, slot = 0): ParticipantInput {
  return { slot, name: `python-${slot}`, team: null, source: { kind: 'script', code, language: 'python' } };
}

function classicScore(maxTicks: number): MatchConfig {
  return { ...defaultConfig('score', { seed: 19, players: 2, maxTicks }),
    width: 28, height: 20, wrap: true, foodCount: 3, ruleset: 'classic', maxHp: null };
}

function stableResult(result: SimulateResult) {
  return { replay: result.replay, codes: result.trace?.codes,
    participants: result.participants.map(({ avgMoveMs: _avg, maxMoveMs: _max, cpuMs: _cpu, ...participant }) => participant) };
}

test('Python 经 worker 试跑：普通 dict/list、init 全局、日志与大写对象方向', async () => {
  const result = await dryRun({ language: 'python', code: `
counter = 0
def init(info):
    global counter
    assert isinstance(info, dict)
    assert isinstance(info["players"], list)
    assert isinstance(info["you"], dict)
    counter = 7
    print("ready")
def move(state):
    assert isinstance(state, dict)
    assert isinstance(state["snakes"], list)
    assert isinstance(state["you"]["body"][0], dict)
    assert "maxHp" in state and "hp" in state["you"]
    assert counter == 7
    print(counter)
    return {"direction": state["legalMoves"][0].upper()}
` });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.legal, true);
  assert.ok(result.direction);
  assert.deepEqual(result.logs, ['ready', '7']);
  assert.ok(result.initMs >= 0 && result.moveMs >= 0);
});

test('Python 检测的语言参数贯通 compile/has-move/场景/模拟且每次检测状态独立', async () => {
  const valid = await validateScript(`
initialized = False
def init(info):
    global initialized
    assert not initialized
    initialized = True
def move(state):
    assert initialized
    return state["legalMoves"][0] if state["legalMoves"] else state["you"]["dir"]
`, 'python');
  assert.equal(valid.ok, true, JSON.stringify(valid.items));
  assert.deepEqual(valid.items.map(({ id }) => id), ['size', 'compile', 'has-move', 'init', 'scenarios',
    'trap', 'solo-sim', 'battle-sim', 'perf']);
  assert.ok(valid.stats);
  assert.equal(valid.items.find(({ id }) => id === 'compile')?.status, 'pass');
  assert.equal(valid.items.find(({ id }) => id === 'scenarios')?.status, 'pass');
  const bad = await validateScript('def move(:\n    pass', 'python');
  assert.equal(bad.ok, false);
  assert.equal(bad.items.find(({ id }) => id === 'compile')?.status, 'fail');
  const missing = await validateScript('value = 1', 'python');
  assert.equal(missing.items.find(({ id }) => id === 'compile')?.status, 'pass');
  assert.equal(missing.items.find(({ id }) => id === 'has-move')?.status, 'fail');
});

test('Python 与 JavaScript 混合对局同 seed 确定、全局状态不跨局且回放一致', async () => {
  const code = `
import random
import time
turns = 0
def init(info):
    assert turns == 0
def move(state):
    global turns
    assert state["tick"] == turns
    assert abs(time.time() - state["tick"] * 0.12) < 1e-9
    assert time.monotonic() == time.perf_counter()
    turns += 1
    direction = random.choice(state["legalMoves"])
    print(turns, time.time(), direction)
    return direction
`;
  const config = { ...classicScore(25), moveTimeoutMs: 1000, initTimeoutMs: 1000 };
  const input = { config, participants: [python(code), { slot: 1, name: 'javascript', team: null,
    source: { kind: 'script' as const, code: 'function move(s){return s.you.dir}' } }] };
  const first = await simulate(input);
  const second = await simulate(input);
  assert.deepEqual(stableResult(second), stableResult(first));
  assert.ok(first.participants.every(({ errors, timeouts }) => errors === 0 && timeouts === 0));
  assert.equal(first.ticks, 25);
  const frames = replayFrames(first.replay);
  assert.equal(frames.length, first.ticks + 1);
  const last = frames.at(-1);
  assert.ok(last);
  assert.deepEqual(last.snakes.map(({ slot, alive, score, length }) => ({ slot, alive, score, length })),
    first.participants.map(({ slot, alive, score, length }) => ({ slot, alive, score, length })));
});

test('同局 Python 参赛者不能读取另一解释器全局', async () => {
  const secret = 'other_participant_only_2971';
  const input = { config: classicScore(5), participants: [python(`
${secret} = "private"
def move(state):
    return state["you"]["dir"]
`), python(`
def move(state):
    assert ${JSON.stringify(secret)} not in globals()
    if isinstance(__builtins__, dict):
        assert ${JSON.stringify(secret)} not in __builtins__
    else:
        assert not hasattr(__builtins__, ${JSON.stringify(secret)})
    return state["you"]["dir"]
`, 1)] };
  const result = await simulate(input);
  assert.equal(result.ticks, 5);
  assert.ok(result.participants.every(({ errors, timeouts, invalidMoves, alive }) =>
    errors === 0 && timeouts === 0 && invalidMoves === 0 && alive), JSON.stringify(result.participants));
});

test('四个 Python 参赛者同时持有解释器时预热池不会申请死锁', { timeout: 30_000 }, async () => {
  const config = { ...defaultConfig('score', { seed: 29, players: 4, maxTicks: 3 }),
    moveTimeoutMs: 1000, initTimeoutMs: 1000 };
  const result = await simulate({ config, participants: Array.from({ length: 4 }, (_, slot) => python(`
owner_slot = None
def init(info):
    global owner_slot
    owner_slot = info["you"]["slot"]
def move(state):
    assert state["you"]["slot"] == owner_slot
    return state["you"]["dir"]
`, slot)) });
  assert.equal(result.ticks, 3);
  assert.deepEqual(result.trace?.codes, ['oooo', 'oooo', 'oooo']);
  assert.ok(result.participants.every(({ errors, timeouts, invalidMoves }) => errors === 0 && timeouts === 0 && invalidMoves === 0),
    JSON.stringify(result.participants));
});

test('Python 普通错误、非法返回及掉头保持方向，第 50 次失败失格', async () => {
  const result = await runSimulation({ config: classicScore(60), participants: [python(`
def move(state):
    if state["tick"] % 2 == 0:
        raise ValueError("保持方向")
    return "not-a-direction"
`), python(`
def move(state):
    return {"up": "down", "down": "up", "left": "right", "right": "left"}[state["you"]["dir"]]
`, 1)] });
  assert.equal(result.ticks, 49);
  assert.ok(result.replay.moves.every((move) => move === 'RL'));
  assert.deepEqual(result.replay.disqualifications,
    [{ tick: 49, slot: 0, phase: 'move' }, { tick: 49, slot: 1, phase: 'move' }]);
  const [first, second] = result.participants;
  assert.ok(first && second);
  assert.equal(first.errors, 25);
  assert.equal(first.invalidMoves, 25);
  assert.equal(second.invalidMoves, 50);
  assert.equal(first.deathReason, 'disqualified');
  assert.equal(second.deathReason, 'disqualified');
  assert.deepEqual(result.trace?.codes.slice(0, 2), ['er', 'ir']);
});

test('Python 中断超时保留该局全局状态并继续下一拍', async () => {
  const result = await runSimulation({ config: { ...defaultConfig('solo', { seed: 8, maxTicks: 2 }), moveTimeoutMs: 20 },
    participants: [python(`
attempts = 0
def move(state):
    global attempts
    attempts += 1
    if attempts == 1:
        while True:
            pass
    assert attempts == 2
    return state["you"]["dir"]
`)] });
  assert.equal(result.ticks, 2, JSON.stringify(result.participants));
  assert.deepEqual(result.trace?.codes, ['t', 'o'], JSON.stringify(result.participants));
  assert.deepEqual(result.replay.moves, ['R', 'R']);
  const participant = result.participants[0];
  assert.ok(participant);
  assert.equal(participant.timeouts, 1);
  assert.equal(participant.errors, 0);
  assert.equal(participant.alive, true);
});

test('Python 累计子进程 CPU 超限即失格，而非宿主等待时间', async () => {
  const cheap = await runSimulation({ config: { ...defaultConfig('solo', { seed: 8, maxTicks: 2 }),
    matchCpuBudgetMs: 100, moveTimeoutMs: 1000 }, participants: [python(`
def move(state):
    return state["you"]["dir"]
`)] });
  assert.equal(cheap.participants[0]?.alive, true, JSON.stringify(cheap.participants));
  assert.ok((cheap.participants[0]?.cpuMs ?? Infinity) < 100);
  const result = await runSimulation({ config: { ...defaultConfig('solo', { seed: 8, maxTicks: 100 }),
    matchCpuBudgetMs: 5, moveTimeoutMs: 1000 }, participants: [python(`
def move(state):
    sum(i * i for i in range(300000))
    return state["you"]["dir"]
`)] });
  const participant = result.participants[0];
  assert.ok(participant);
  assert.equal(participant.deathReason, 'disqualified');
  assert.ok(participant.cpuMs > 5);
  assert.match(participant.firstError ?? '', /CPU/);
  assert.ok(result.ticks < 100);
});

test('Python 内存超限首拍立即失格，记录原因而非等待 50 次失败', async () => {
  const result = await runSimulation({ config: { ...defaultConfig('solo', { seed: 8, maxTicks: 2 }), moveTimeoutMs: 1000 },
    participants: [python(`
def move(state):
    bomb = bytearray(64 * 1024 * 1024)
    return state["you"]["dir"]
`)] });
  const participant = result.participants[0];
  assert.ok(participant);
  assert.equal(participant.deathReason, 'disqualified');
  assert.equal(result.ticks, 0);
  assert.equal(participant.moves, 1);
  assert.match(participant.firstError ?? '', /内存|memory|Memory/);
  assert.deepEqual(result.replay.disqualifications, [{ tick: 0, slot: 0, phase: 'move' }]);
});
