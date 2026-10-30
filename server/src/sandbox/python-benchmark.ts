import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createSandbox } from './index';
import { pythonHostDiagnostics, shutdownPythonHosts } from './python';
import { runSimulation, runValidation } from '../runner/jobs';
import { defaultConfig } from '../runner/config';

/** Repeatable capacity probe; classic avoids starvation ending before 4000 decisions. */
async function main(): Promise<void> {
  const options = { seed: 319, slot: 0, moveTimeoutMs: 50, initTimeoutMs: 500, memoryLimitMB: 32 };
  const code = 'def move(state):\n    return state["you"]["dir"]';
  let started = performance.now();
  let sandbox = await createSandbox(code, options, 'python');
  console.log('cold', JSON.stringify({ wallMs: performance.now() - started, ...pythonHostDiagnostics() }));
  sandbox.dispose();
  await new Promise(resolveWait => setTimeout(resolveWait, 2000));
  started = performance.now();
  sandbox = await createSandbox(code, options, 'python');
  console.log('warm', JSON.stringify({ wallMs: performance.now() - started, ...pythonHostDiagnostics() }));
  sandbox.dispose();
  shutdownPythonHosts();

  const perimeter = `def move(state):
    x, y = state['you']['head']['x'], state['you']['head']['y']
    direction = state['you']['dir']
    if direction == 'right' and x == state['width'] - 1: return 'down'
    if direction == 'down' and y == state['height'] - 1: return 'left'
    if direction == 'left' and x == 0: return 'up'
    if direction == 'up' and y == 0: return 'right'
    return direction
`;
  const result = await runSimulation({ config: { ...defaultConfig('score', { seed: 319, players: 4, maxTicks: 1000 }),
    ruleset: 'classic', maxHp: null, width: 64, height: 64, wrap: false, foodCount: 4 },
    participants: [0, 1, 2, 3].map(slot => ({ slot, name: 'Python 性能探针', team: null,
      source: { kind: 'script', language: 'python', code: perimeter } })) });
  console.log('match-classic-64', JSON.stringify({ ticks: result.ticks, durationMs: result.durationMs,
    participants: result.participants.map(({ slot, moves, errors, timeouts, cpuMs, avgMoveMs, maxMoveMs }) =>
      ({ slot, moves, errors, timeouts, cpuMs, avgMoveMs, maxMoveMs })) }));
  const report = await runValidation(readFileSync(resolve(__dirname, '../../../examples/scripts/flood-fill.py'), 'utf8'), 'python');
  console.log('validate-flood-fill', JSON.stringify({ ok: report.ok, durationMs: report.durationMs, stats: report.stats }));
}

if (require.main === module) void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Python 性能探针失败');
  process.exitCode = 1;
}).finally(shutdownPythonHosts);
