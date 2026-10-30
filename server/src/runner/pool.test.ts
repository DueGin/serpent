import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import type { Worker } from 'node:worker_threads';
import { RunnerBusyError, RunnerPool, RunnerUnavailableError } from './index';

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

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class TestWorker extends EventEmitter {
  job?: { id: number; input: unknown };
  terminated = false;
  constructor(readonly startup: 'ready' | 'fail' | 'hang' = 'ready') {
    super();
    queueMicrotask(() => {
      if (this.terminated) return;
      if (startup === 'ready') this.emit('message', { type: 'runner-ready' });
      if (startup === 'fail') this.emit('error', new Error('missing worker entry'));
    });
  }
  postMessage(job: { id: number; input: unknown }): void { this.job = job; }
  complete(result: unknown = 'done'): void {
    assert.ok(this.job);
    const { id } = this.job;
    this.job = undefined;
    this.emit('message', { id, result });
  }
  async terminate(): Promise<number> { this.terminated = true; return 0; }
  asWorker(): Worker { return this as unknown as Worker; }
}

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

test('pending count and UTF-8 byte ceilings reject immediately and release capacity', async () => {
  const workers: TestWorker[] = [];
  const pool = new RunnerPool({ size: 1, maxPendingJobs: 2, maxPendingBytes: 100, queueTimeoutMs: 1000,
    workerFactory: () => { const worker = new TestWorker(); workers.push(worker); return worker.asWorker(); } });
  try {
    const first = pool.run('validate', 'x'.repeat(40));
    await wait(0);
    const second = pool.run('validate', 'x'.repeat(40));
    await assert.rejects(pool.run('validate', 'x'), (error) => error instanceof RunnerBusyError && error.code === 'RUNNER_BUSY' && error.reason === 'queue_full');
    assert.equal(pool.diagnostics.pendingJobs, 2);
    assert.equal(pool.diagnostics.pendingBytes, 84);
    workers[0]!.complete();
    await first;
    await assert.rejects(pool.run('validate', '汉'.repeat(20)), (error) => error instanceof RunnerBusyError && error.reason === 'queue_bytes');
    assert.equal(pool.diagnostics.pendingJobs, 1);
    assert.equal(pool.diagnostics.pendingBytes, 42);
    workers[0]!.complete();
    await second;
    assert.equal(pool.diagnostics.pendingJobs, 0);
    assert.equal(pool.diagnostics.pendingBytes, 0);
    await assert.rejects(pool.run('validate', 'x'.repeat(100)), (error) => error instanceof RunnerBusyError && error.reason === 'queue_bytes');
  } finally { await pool.shutdown(); }
});

test('waiting jobs expire, clear accounting and timers, without killing an active match', async () => {
  const worker = new TestWorker();
  const pool = new RunnerPool({ size: 1, queueTimeoutMs: 30, jobTimeoutMs: 1000, workerFactory: () => worker.asWorker() });
  try {
    const first = pool.run('validate', 'first');
    await wait(0);
    const queued = pool.run('validate', 'queued');
    await assert.rejects(queued, (error) => error instanceof RunnerBusyError && error.reason === 'queue_timeout');
    assert.equal(pool.diagnostics.queuedJobs, 0);
    assert.equal(pool.diagnostics.pendingJobs, 1);
    assert.equal(worker.terminated, false);
    worker.complete();
    await first;
    await wait(40);
    assert.equal(pool.diagnostics.pendingJobs, 0);
    assert.equal(pool.diagnostics.pendingBytes, 0);
  } finally { await pool.shutdown(); }
});

test('persistent startup failure uses bounded exponential backoff then opens its circuit', async () => {
  const attempts: number[] = [];
  const pool = new RunnerPool({ size: 1, retryBaseMs: 15, retryMaxMs: 25, maxStartupFailures: 3,
    circuitCooldownMs: 50, queueTimeoutMs: 1000,
    workerFactory: () => { attempts.push(Date.now()); return new TestWorker('fail').asWorker(); } });
  try {
    await assert.rejects(pool.run('validate', 'script'), (error) => error instanceof RunnerUnavailableError && error.code === 'RUNNER_UNAVAILABLE' && error.retryAfterMs > 0);
    assert.equal(attempts.length, 3);
    assert.ok(attempts[1]! - attempts[0]! >= 10);
    assert.ok(attempts[2]! - attempts[1]! >= 20);
    await assert.rejects(pool.run('validate', 'script'), RunnerUnavailableError);
    await wait(65);
    assert.equal(attempts.length, 3, 'an empty queue must not probe or rebuild workers');
    assert.equal(pool.diagnostics.retryScheduled, false);
    assert.equal(pool.diagnostics.pendingJobs, 0);
    assert.equal(pool.diagnostics.pendingBytes, 0);
  } finally { await pool.shutdown(); }
});

test('synchronous startup failures are backed off and never recurse without bounds', async () => {
  let attempts = 0;
  const pool = new RunnerPool({ size: 1, retryBaseMs: 5, retryMaxMs: 10, maxStartupFailures: 3,
    workerFactory: () => { attempts++; throw new Error('invalid worker configuration'); } });
  try {
    await assert.rejects(pool.run('validate', 'script'), RunnerUnavailableError);
    assert.equal(attempts, 3);
    assert.equal(pool.diagnostics.workers, 0);
  } finally { await pool.shutdown(); }
});

test('queue expiration cancels pending retries and leaves no idle restart storm', async () => {
  let attempts = 0;
  const pool = new RunnerPool({ size: 1, retryBaseMs: 70, queueTimeoutMs: 20,
    workerFactory: () => { attempts++; return new TestWorker('fail').asWorker(); } });
  try {
    await assert.rejects(pool.run('validate', 'script'), (error) => error instanceof RunnerBusyError && error.reason === 'queue_timeout');
    await wait(90);
    assert.equal(attempts, 1);
    assert.equal(pool.diagnostics.retryScheduled, false);
  } finally { await pool.shutdown(); }
});

test('idle worker crash does not create a replacement until another job arrives', async () => {
  let attempts = 0;
  const workers: TestWorker[] = [];
  const pool = new RunnerPool({ size: 1, retryBaseMs: 10, workerFactory: () => {
    attempts++;
    const worker = new TestWorker(); workers.push(worker); return worker.asWorker();
  } });
  try {
    const first = pool.run('validate', 'one');
    await wait(0);
    workers[0]!.complete();
    await first;
    workers[0]!.emit('error', new Error('idle worker crashed'));
    await wait(30);
    assert.equal(attempts, 1);
    assert.equal(pool.diagnostics.retryScheduled, false);
    const second = pool.run('validate', 'two');
    await wait(0);
    assert.equal(attempts, 2);
    workers[1]!.complete();
    await second;
  } finally { await pool.shutdown(); }
});

test('shutdown clears queued deadlines, startup timers, retries and can safely restart later', async () => {
  let attempts = 0;
  const workers: TestWorker[] = [];
  const pool = new RunnerPool({ size: 1, retryBaseMs: 100, queueTimeoutMs: 1000,
    workerFactory: () => {
      attempts++;
      const worker = new TestWorker(attempts === 1 ? 'fail' : 'ready'); workers.push(worker); return worker.asWorker();
    } });
  const pending = assert.rejects(pool.run('validate', 'script'), /runner shut down/);
  await wait(0);
  assert.equal(pool.diagnostics.retryScheduled, true);
  const a = pool.shutdown();
  assert.equal(a, pool.shutdown());
  await a;
  await pending;
  await wait(120);
  assert.equal(attempts, 1);
  assert.equal(pool.diagnostics.retryScheduled, false);
  assert.equal(pool.diagnostics.pendingJobs, 0);
  assert.equal(pool.diagnostics.pendingBytes, 0);
  const later = pool.run('validate', 'later');
  await wait(0);
  workers[1]!.complete();
  await later;
  await pool.shutdown();
  assert.ok(workers.every((worker) => worker.terminated));
});

test('hung startup is terminated and bounded by startup timeout and failure circuit', async () => {
  const workers: TestWorker[] = [];
  const pool = new RunnerPool({ size: 1, startupTimeoutMs: 15, retryBaseMs: 5, maxStartupFailures: 2,
    workerFactory: () => { const worker = new TestWorker('hang'); workers.push(worker); return worker.asWorker(); } });
  try {
    await assert.rejects(pool.run('validate', 'script'), RunnerUnavailableError);
    assert.equal(workers.length, 2);
    assert.ok(workers.every((worker) => worker.terminated));
    assert.equal(pool.diagnostics.pendingJobs, 0);
  } finally { await pool.shutdown(); }
});

test('a delayed healthy startup closes a circuit opened by parallel startup failures', async () => {
  const workers: TestWorker[] = [];
  const pool = new RunnerPool({ size: 2, maxStartupFailures: 1, circuitCooldownMs: 1000,
    workerFactory: () => {
      const worker = new TestWorker(workers.length === 0 ? 'fail' : 'hang');
      workers.push(worker); return worker.asWorker();
    } });
  try {
    const first = pool.run('validate', 'one');
    const second = pool.run('validate', 'two');
    await Promise.all([assert.rejects(first, RunnerUnavailableError), assert.rejects(second, RunnerUnavailableError)]);
    assert.equal(pool.diagnostics.circuitOpen, true);
    workers[1]!.emit('message', { type: 'runner-ready' });
    assert.equal(pool.diagnostics.circuitOpen, false);
    const later = pool.run('validate', 'later');
    workers[1]!.complete();
    assert.equal(await later, 'done');
  } finally { await pool.shutdown(); }
});

test('positive fractional settings normalize to at least one instead of disabling limits', async () => {
  const worker = new TestWorker();
  const pool = new RunnerPool({ size: 0.5, maxPendingJobs: 0.5, queueTimeoutMs: 1000, workerFactory: () => worker.asWorker() });
  try {
    const first = pool.run('validate', 'one');
    await wait(0);
    assert.equal(pool.diagnostics.workers, 1);
    await assert.rejects(pool.run('validate', 'two'), RunnerBusyError);
    worker.complete();
    await first;
  } finally { await pool.shutdown(); }
});
