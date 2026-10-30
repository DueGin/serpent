import { performance } from 'node:perf_hooks';
import {
  type CheckItem, type CheckReport, type Direction, type DryRunInput, type DryRunResult,
  type InitInfo, type ParticipantResult, type Replay, type ScriptState,
  type SimulateInput, type SimulateResult, COLORS, OPPOSITE,
} from '../types';
import { createGame, disqualify, evaluateEnd, queueDirection, rankResults, step } from '../game/engine';
import { chooseMove } from '../game/bot';
import { buildInitInfo, buildScriptState } from '../game/observe';
import { createSandbox, inspectScript, SandboxError, type SandboxCallResult, type ScriptSandbox } from '../sandbox';
import { defaultConfig, ENGINE_VERSION } from './config';
import { listScenarios } from './scenarios';

const encode: Record<Direction, string> = { up: 'U', down: 'D', left: 'L', right: 'R' };
const CHECKS = ['size', 'compile', 'has-move', 'init', 'scenarios', 'trap', 'solo-sim', 'battle-sim', 'perf'] as const;
const LABELS: Record<typeof CHECKS[number], string> = {
  size: '代码大小', compile: '编译与加载', 'has-move': 'move 接口', init: '初始化',
  scenarios: '场景检测', trap: '唯一出口', 'solo-sim': '单人迷你模拟',
  'battle-sim': '对战迷你模拟', perf: '执行耗时',
};

type Stats = ParticipantResult & { consecutive: number; moveMs: number };

function message(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 1000); }
function round(value: number): number { return Math.round(value * 1000) / 1000; }
function firstError(stats: Stats, text: string): void { stats.firstError ??= text.slice(0, 1000); }
function cpuClock(): number {
  const usage = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : process.cpuUsage();
  return (usage.user + usage.system) / 1000;
}

function assertLimits(input: SimulateInput): void {
  const { config, participants } = input;
  if (!['solo', 'score', 'battle'].includes(config.mode)) throw new Error('Invalid game mode');
  for (const field of ['moveTimeoutMs', 'initTimeoutMs', 'memoryLimitMB', 'matchCpuBudgetMs'] as const) {
    if (!Number.isFinite(config[field]) || config[field] <= 0) throw new Error(`Invalid ${field}`);
  }
  if (!Number.isInteger(config.seed) || config.seed < 0 || config.seed > 0xffffffff) throw new Error('Invalid seed');
  if (config.maxTicks > 100_000 || config.width > 256 || config.height > 256 || config.foodCount > config.width * config.height) {
    throw new Error('Match dimensions or ticks exceed runner safety limit');
  }
  if (config.mode !== 'solo' && participants.length < 2) throw new Error('Multiplayer matches need at least two participants');
  for (const participant of participants) {
    if (participant.source.kind === 'builtin' && !['greedy', 'coward', 'random'].includes(participant.source.bot)) throw new Error('Invalid builtin bot');
    if (!['builtin', 'script'].includes(participant.source.kind)) throw new Error('Invalid participant source');
  }
}

export async function runSimulation(input: SimulateInput): Promise<SimulateResult> {
  assertLimits(input);
  const started = performance.now();
  const participants = [...input.participants].sort((a, b) => a.slot - b.slot);
  const state = createGame({ config: input.config, participants });
  const captureLogs = input.captureLogs !== false;
  const sandboxes = new Map<number, ScriptSandbox>();
  const stats = new Map<number, Stats>(participants.map((participant) => [participant.slot, {
    slot: participant.slot, rank: 1, score: 0, length: 3, alive: true,
    deathTick: null, deathReason: null, kills: 0, moves: 0,
    timeouts: 0, errors: 0, invalidMoves: 0, avgMoveMs: 0, maxMoveMs: 0, cpuMs: 0,
    ...(captureLogs ? { logs: [] } : {}), consecutive: 0, moveMs: 0,
  }]));
  const replay: Replay = {
    v: 1, engine: ENGINE_VERSION, config: { ...input.config },
    players: participants.map((participant) => ({ slot: participant.slot, name: participant.name,
      team: participant.team, color: COLORS[participant.slot]! })),
    moves: [],
  };
  const kill = (slot: number, phase: 'init' | 'move') => {
    replay.disqualifications ??= [];
    replay.disqualifications.push({ tick: state.tick, slot, phase });
    disqualify(state, slot, { deferEnd: true });
  };
  const logs = (slot: number) => {
    const lines = sandboxes.get(slot)?.drainLogs() ?? [];
    if (captureLogs) stats.get(slot)!.logs!.push(...lines.map((text) => ({ tick: state.tick, text })));
  };
  const failed = (stat: Stats, result: SandboxCallResult, phase: 'init' | 'move') => {
    if (result.timeout) {
      stat.timeouts++;
      firstError(stat, result.error ?? `${phase}() 超时`);
    } else {
      stat.errors++;
      firstError(stat, result.error ?? `${phase}() 失败`);
    }
    stat.consecutive++;
  };
  try {
    for (const participant of participants) {
      if (participant.source.kind !== 'script') continue;
      const stat = stats.get(participant.slot)!;
      const compileStart = cpuClock();
      try {
        const sandbox = await createSandbox(participant.source.code, {
          seed: input.config.seed, slot: participant.slot,
          moveTimeoutMs: input.config.moveTimeoutMs, initTimeoutMs: input.config.initTimeoutMs,
          memoryLimitMB: input.config.memoryLimitMB,
        });
        sandboxes.set(participant.slot, sandbox);
        if (!sandbox.hasMove) throw new Error('move() 未定义');
        const result = sandbox.init(buildInitInfo(state, participant.slot));
        stat.cpuMs += cpuClock() - compileStart;
        logs(participant.slot);
        if (result.error || result.timeout) { failed(stat, result, 'init'); kill(participant.slot, 'init'); }
        else if (stat.cpuMs > input.config.matchCpuBudgetMs) { firstError(stat, '累计 CPU 预算已耗尽'); kill(participant.slot, 'init'); }
      } catch (error) {
        if (error instanceof SandboxError && error.timeout) stat.timeouts++;
        else stat.errors++;
        stat.cpuMs += cpuClock() - compileStart;
        firstError(stat, message(error));
        logs(participant.slot);
        kill(participant.slot, 'init');
      }
    }
    evaluateEnd(state);
    while (state.status === 'running') {
      const choices = new Map<number, Direction>();
      const alive = state.snakes.filter((snake) => snake.alive);
      // Every participant sees the same pre-tick world, including when a peer
      // is disqualified by its decision during this tick.
      const observations = new Map(alive.map((snake) => [snake.slot, buildScriptState(state, snake.slot)]));
      const pendingDisqualifications: number[] = [];
      for (const snake of alive) {
        const stat = stats.get(snake.slot)!;
        const participant = participants.find((candidate) => candidate.slot === snake.slot)!;
        if (participant.source.kind === 'builtin') {
          choices.set(snake.slot, chooseMove(state, snake.slot, participant.source.bot));
          stat.moves++;
          continue;
        }
        const sandbox = sandboxes.get(snake.slot)!;
        const cpuStarted = cpuClock();
        const result = sandbox.move(observations.get(snake.slot)!);
        stat.moves++;
        stat.moveMs += result.elapsedMs;
        stat.maxMoveMs = Math.max(stat.maxMoveMs, result.elapsedMs);
        stat.cpuMs += cpuClock() - cpuStarted;
        logs(snake.slot);
        let direction = snake.dir;
        if (result.error || result.timeout) failed(stat, result, 'move');
        else if (!result.direction || result.direction === OPPOSITE[snake.dir]) {
          stat.invalidMoves++;
          stat.consecutive++;
          firstError(stat, result.direction ? '禁止 180 度掉头' : 'move() 返回非法方向');
        } else { direction = result.direction; stat.consecutive = 0; }
        if (stat.consecutive >= 50 || stat.cpuMs > input.config.matchCpuBudgetMs) {
          if (stat.cpuMs > input.config.matchCpuBudgetMs) firstError(stat, '累计 CPU 预算已耗尽');
          pendingDisqualifications.push(snake.slot);
        } else choices.set(snake.slot, direction);
      }
      for (const slot of pendingDisqualifications) kill(slot, 'move');
      evaluateEnd(state);
      if (state.status !== 'running') break;
      const encoded = participants.map((participant) => {
        const snake = state.snakes.find((entry) => entry.slot === participant.slot)!;
        if (!snake.alive) return '.';
        const direction = choices.get(participant.slot) ?? snake.dir;
        queueDirection(state, participant.slot, direction);
        return encode[direction];
      }).join('');
      replay.moves.push(encoded);
      step(state);
    }
    const ranks = new Map(rankResults(state).map(({ slot, rank }) => [slot, rank]));
    return {
      ticks: state.tick, endReason: state.endReason!, winners: state.winners.map((id) => Number(id.slice(1))),
      winnerTeam: state.winnerTeam,
      participants: state.snakes.map((snake) => {
        const { consecutive: _consecutive, moveMs, ...stat } = stats.get(snake.slot)!;
        return { ...stat, rank: ranks.get(snake.slot)!, score: snake.score, length: snake.body.length,
          alive: snake.alive, deathTick: snake.deathTick, deathReason: snake.deathReason, kills: snake.kills,
          avgMoveMs: round(stat.moves ? moveMs / stat.moves : 0), maxMoveMs: round(stat.maxMoveMs), cpuMs: round(stat.cpuMs) };
      }),
      replay, durationMs: round(performance.now() - started),
    };
  } finally {
    for (const sandbox of sandboxes.values()) sandbox.dispose();
  }
}

function deriveInit(state: ScriptState): InitInfo {
  return {
    protocol: 'serpent-script-v1', mode: state.mode, teams: state.teams,
    width: state.width, height: state.height, wrap: state.wrap,
    maxTicks: state.maxTicks, targetScore: state.targetScore,
    you: { id: state.you.id, slot: state.you.slot, team: state.you.team },
    players: state.snakes.map(({ id, slot, name, team }) => ({ id, slot, name, team })),
    limits: { moveTimeoutMs: 50, initTimeoutMs: 500, memoryLimitMB: 32 },
  };
}

export async function runDryRun(input: DryRunInput): Promise<DryRunResult> {
  let sandbox: ScriptSandbox | undefined;
  const output: DryRunResult = { ok: false, direction: null, raw: null, legal: false, logs: [], initMs: 0, moveMs: 0 };
  try {
    if (typeof input.code !== 'string') throw new Error('缺少脚本代码');
    const scenario = listScenarios().find((item) => item.id === (input.scenario ?? 'solo-open'));
    if (!input.state && !scenario) throw new Error('未知试跑场景');
    const state = input.state ?? scenario!.state;
    const info = input.init ?? (input.state ? deriveInit(state) : scenario!.init);
    if (!state.you?.alive || !state.you.body.length || !Array.isArray(state.legalMoves)) throw new Error('试跑 state 无效或蛇已死亡');
    if (info.you.slot !== state.you.slot) throw new Error('试跑 init 与 state 的选手不一致');
    sandbox = await createSandbox(input.code, {
      seed: 12345, slot: state.you.slot,
      moveTimeoutMs: info.limits.moveTimeoutMs, initTimeoutMs: info.limits.initTimeoutMs,
      memoryLimitMB: info.limits.memoryLimitMB,
    });
    const init = sandbox.init(info);
    output.initMs = round(init.elapsedMs);
    if (init.error || init.timeout) throw new Error(init.error ?? 'init() 超时');
    const move = sandbox.move(state);
    output.moveMs = round(move.elapsedMs);
    output.raw = move.raw;
    output.direction = move.direction;
    output.legal = Boolean(move.direction && state.legalMoves.includes(move.direction));
    output.ok = !move.error && !move.timeout && output.legal;
    if (!output.ok) output.error = move.error ?? (move.timeout ? 'move() 超时' : move.direction ? '返回方向不在 legalMoves 中' : 'move() 返回非法方向');
  } catch (error) { output.error = message(error); }
  finally { output.logs = sandbox?.drainLogs() ?? []; sandbox?.dispose(); }
  return output;
}

export async function runValidation(code: string): Promise<CheckReport> {
  const started = performance.now();
  const items: CheckItem[] = [];
  const add = (id: typeof CHECKS[number], status: CheckItem['status'], detail?: string) => {
    items.push({ id, label: LABELS[id], status, ...(detail ? { detail } : {}) });
  };
  const finish = (stats?: CheckReport['stats']): CheckReport => {
    for (const id of CHECKS) if (!items.some((item) => item.id === id)) add(id, 'warn', '前置检测未通过，已跳过');
    return { ok: !items.some((item) => item.status === 'fail'), items,
      ...(stats ? { stats } : {}), checkedAt: Date.now(), durationMs: round(performance.now() - started) };
  };
  if (typeof code !== 'string') { add('size', 'fail', '脚本必须是字符串'); return finish(); }
  const bytes = Buffer.byteLength(code, 'utf8');
  add('size', bytes <= 65_536 ? 'pass' : 'fail', `${bytes} / 65536 字节`);
  if (bytes > 65_536) return finish();
  const inspection = await inspectScript(code);
  add('compile', inspection.compile ? 'pass' : 'fail', inspection.error);
  add('has-move', inspection.hasMove ? 'pass' : 'fail', inspection.hasMove ? undefined : '必须定义同步 move(state)');
  if (!inspection.compile || !inspection.hasMove) return finish();
  const scenarios = listScenarios();
  const runs: DryRunResult[] = [];
  for (const scenario of scenarios) {
    const run = await runDryRun({ code, scenario: scenario.id });
    runs.push(run);
  }
  // init can throw arbitrary text, so detect independently of its message.
  let initError: string | undefined;
  if (inspection.hasInit) {
    let sandbox: ScriptSandbox | undefined;
    try {
      sandbox = await createSandbox(code, { seed: 1, slot: 0, moveTimeoutMs: 50, initTimeoutMs: 500, memoryLimitMB: 32 });
      const init = sandbox.init(scenarios[0]!.init);
      if (init.error || init.timeout) initError = init.error ?? 'init() 超时';
    } catch (error) { initError = message(error); }
    finally { sandbox?.dispose(); }
  }
  add('init', initError ? 'fail' : 'pass', initError ?? (inspection.hasInit ? undefined : '未定义 init，允许跳过'));
  const failures = runs.map((run, i) => !run.ok ? `${scenarios[i]!.id}: ${run.error ?? '非法方向'}` : null).filter(Boolean);
  add('scenarios', failures.length ? 'fail' : 'pass', failures.length ? failures.join('; ').slice(0, 1500) : `${scenarios.length} 个场景全部通过`);
  const trap = runs[scenarios.findIndex((scenario) => scenario.id === 'trap-one-exit')]!;
  add('trap', trap.ok && trap.direction === 'right' ? 'pass' : 'warn', trap.direction === 'right' ? undefined : '唯一安全出口为 right');
  if (initError || failures.length) return finish();
  const soloScores: number[] = [], soloTicks: number[] = [];
  let wins = 0, moveTime = 0, moveCount = 0, maxMove = Math.max(...runs.map((run) => run.moveMs));
  for (const seed of [103, 271, 997]) {
    const solo = await runSimulation({ config: defaultConfig('solo', { seed, maxTicks: 100 }),
      participants: [{ slot: 0, name: '检测脚本', team: null, source: { kind: 'script', code } }], captureLogs: false });
    const player = solo.participants[0]!;
    soloScores.push(player.score); soloTicks.push(solo.ticks);
    moveTime += player.avgMoveMs * player.moves; moveCount += player.moves; maxMove = Math.max(maxMove, player.maxMoveMs);
    const battle = await runSimulation({ config: defaultConfig('battle', { seed, players: 2, maxTicks: 100 }),
      participants: [{ slot: 0, name: '检测脚本', team: null, source: { kind: 'script', code } },
        { slot: 1, name: '贪心对手', team: null, source: { kind: 'builtin', bot: 'greedy' } }], captureLogs: false });
    if (battle.winners.includes(0)) wins += 1 / Math.max(1, battle.winners.length);
    const fighter = battle.participants[0]!;
    moveTime += fighter.avgMoveMs * fighter.moves; moveCount += fighter.moves; maxMove = Math.max(maxMove, fighter.maxMoveMs);
  }
  const stats: NonNullable<CheckReport['stats']> = {
    soloAvgScore: round(soloScores.reduce((a, b) => a + b, 0) / 3), soloAvgTicks: round(soloTicks.reduce((a, b) => a + b, 0) / 3),
    battleWinRateVsGreedy: round(wins / 3), avgMoveMs: round(moveCount ? moveTime / moveCount : 0), maxMoveMs: round(maxMove),
  };
  add('solo-sim', stats.soloAvgScore > 0 ? 'pass' : 'warn', `3 局平均 ${stats.soloAvgScore} 分、${stats.soloAvgTicks} tick`);
  add('battle-sim', wins > 0 ? 'pass' : 'warn', `对贪心脚本 3 局胜率 ${round(stats.battleWinRateVsGreedy * 100)}%`);
  add('perf', stats.avgMoveMs > 20 ? 'warn' : 'pass', `平均 ${stats.avgMoveMs}ms，最大 ${stats.maxMoveMs}ms`);
  return finish(stats);
}
