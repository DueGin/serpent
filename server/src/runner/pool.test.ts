import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const exec = promisify(execFile);
const server = resolve(__dirname, '../..');
const source = join(server, 'src/runner/index.ts');

async function child(program: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
  const { stdout } = await exec(process.execPath, ['-e', program], {
    cwd: server,
    env: { ...process.env, RUNNER_WORKERS: '1', ...extraEnv },
    timeout: 20_000,
    maxBuffer: 512 * 1024,
  });
  return stdout;
}

const prelude = `require('tsx/cjs'); const assert = require('node:assert/strict');`;
const valid = { code: 'function move(s) { return s.legalMoves[0] }', scenario: 'solo-open' };

test('worker hard timeout rejects its job and replacement accepts the next job', { timeout: 20_000 }, async () => {
  const output = await child(`${prelude}
    const runner = require(${JSON.stringify(source)});
    (async () => {
      try {
        const config = runner.defaultConfig('solo', {maxTicks: 2});
        config.initTimeoutMs = 5000;
        await assert.rejects(runner.simulate({ config, participants: [{slot: 0, name: 'loop', team: null,
          source: {kind: 'script', code: 'while (true) {}'}}]}), /job timed out/);
        const result = await runner.dryRun(${JSON.stringify(valid)});
        assert.equal(result.ok, true);
        console.log('recovered-timeout');
      } finally { await runner.shutdownRunner(); }
    })().catch(e => { console.error(e); process.exitCode = 1; });`, { RUNNER_JOB_TIMEOUT_MS: '1500' });
  assert.match(output, /recovered-timeout/);
});

test('unexpected worker exit rejects only its active job and rebuilds the slot', { timeout: 20_000 }, async () => {
  const output = await child(`${prelude}
    const {Worker} = require('node:worker_threads');
    const send = Worker.prototype.postMessage;
    let first = true;
    Worker.prototype.postMessage = function(...args) {
      if (first) { first = false; void this.terminate(); return; }
      return send.apply(this, args);
    };
    const runner = require(${JSON.stringify(source)});
    (async () => {
      try {
        await assert.rejects(runner.dryRun(${JSON.stringify(valid)}), /worker exited/);
        assert.equal((await runner.dryRun(${JSON.stringify(valid)})).ok, true);
        console.log('recovered-crash');
      } finally { await runner.shutdownRunner(); }
    })().catch(e => { console.error(e); process.exitCode = 1; });`);
  assert.match(output, /recovered-crash/);
});

test('tsc emitted CommonJS starts its JavaScript worker without tsx', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'serpent-runner-build-'));
  try {
    await exec(process.execPath, [require.resolve('typescript/bin/tsc'),
      '--target', 'ES2022', '--module', 'CommonJS', '--moduleResolution', 'node',
      '--strict', '--esModuleInterop', '--skipLibCheck', '--types', 'node',
      '--rootDir', join(server, 'src'), '--outDir', directory, source, join(server, 'src/runner/worker.ts'),
    ], { cwd: server, timeout: 20_000 });
    const output = await child(`const runner = require(${JSON.stringify(join(directory, 'runner/index.js'))});
      (async () => {
        try {
          const result = await runner.dryRun(${JSON.stringify(valid)});
          require('node:assert/strict').equal(result.ok, true);
          console.log('compiled-worker-ok');
        } finally { await runner.shutdownRunner(); }
      })().catch(e => { console.error(e); process.exitCode = 1; });`, {
      NODE_PATH: [join(server, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(require('node:path').delimiter),
    });
    assert.match(output, /compiled-worker-ok/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
