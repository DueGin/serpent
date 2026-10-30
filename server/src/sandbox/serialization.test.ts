import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import {
  createSandbox, MAX_SANDBOX_ARRAY_LENGTH, MAX_SANDBOX_RESULT_BYTES, type SandboxOptions,
} from './index';
import type { ScriptState } from '../types';

const options: SandboxOptions = {
  seed: 91, slot: 0, moveTimeoutMs: 1000, initTimeoutMs: 1000, memoryLimitMB: 32,
};
const state = { tick: 0 } as ScriptState;
const exec = promisify(execFile);

async function move(code: string, overrides: Partial<SandboxOptions> = {}) {
  const sandbox = await createSandbox(code, { ...options, ...overrides });
  try { return sandbox.move(state); }
  finally { sandbox.dispose(); }
}

test('sparse array indices cannot expand the sanitized array length', async () => {
  const result = await move(`function move() {
    const a = []; a[3000000] = 1;
    return { direction: 'up', a };
  }`);
  assert.equal(result.error, undefined);
  assert.equal(result.direction, 'up');
  const raw = result.raw as { direction: string; a: unknown[] };
  assert.equal(raw.a.length, MAX_SANDBOX_ARRAY_LENGTH);
  assert.ok(raw.a.every(value => value === null));
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') < 1024);
});

test('dense and nested arrays copy only bounded leading elements without non-index properties', async () => {
  const result = await move(`function move() {
    const a = Array.from({length: 10000}, (_, index) => index);
    a.extra = 'not-an-element';
    return {direction: 'right', a};
  }`);
  assert.equal(result.error, undefined);
  const raw = result.raw as { a: number[] };
  assert.deepEqual(raw.a, Array.from({length: MAX_SANDBOX_ARRAY_LENGTH}, (_, index) => index));
  assert.equal(Object.hasOwn(raw.a, 'extra'), false);
});

test('the serialization budget includes nested string values, key names, UTF-8 and escaping', async () => {
  for (const expression of [
    `'x'.repeat(5000)`,
    `String.fromCharCode(0).repeat(5000)`,
    `String.fromCodePoint(0x1f40d).repeat(2500)`,
    `String.fromCharCode(0xd800).repeat(5000)`,
  ]) {
    const result = await move(`function move() {
      const value = ${expression};
      return {direction: 'up', nested: {a: Array(40).fill(value)}};
    }`);
    assert.equal(result.timeout, false);
    assert.match(result.error ?? '', /65536/);
    assert.equal(result.raw, null);
    assert.equal(result.direction, null);
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') < 1024);
  }
  const keys = await move(`function move() {
    const value = {};
    for (let i = 0; i < 40; i++) value[String.fromCharCode(0).repeat(499) + i] = true;
    return {direction: 'up', value};
  }`);
  assert.match(keys.error ?? '', /65536/);
  assert.equal(keys.raw, null);
});

test('valid payloads below the byte budget retain their normal JSON shape', async () => {
  const result = await move(`function move() {
    return {direction: 'up', nested: {values: Array(12).fill('x'.repeat(5000))}};
  }`);
  assert.equal(result.error, undefined);
  assert.equal(result.direction, 'up');
  const bytes = Buffer.byteLength(JSON.stringify({raw: result.raw}), 'utf8');
  assert.ok(bytes > 60_000 && bytes <= MAX_SANDBOX_RESULT_BYTES);
});

test('timeout and error paths discard raw, including soft deadline overrun after a value was returned', async () => {
  const timeout = await move(`function move() { return {direction: 'up', details: 'x'.repeat(1000)} }`,
    { moveTimeoutMs: Number.MIN_VALUE });
  assert.equal(timeout.timeout, true);
  assert.equal(timeout.raw, null);
  assert.equal(timeout.direction, null);
  const error = await move(`function move() { return {direction: 'up', get detail() { throw Error('bad') }} }`);
  assert.equal(error.error, 'bad');
  assert.equal(error.raw, null);
  assert.equal(error.direction, null);
});

test('real worker dry-run returns bounded sparse and oversized results', { timeout: 20_000 }, async () => {
  const source = resolve(__dirname, '../runner/index.ts');
  const program = `require('tsx/cjs');
    const assert = require('node:assert/strict');
    const runner = require(${JSON.stringify(source)});
    (async () => {
      try {
        const init = runner.listScenarios().find(s => s.id === 'solo-open').init;
        init.limits.moveTimeoutMs = 1000;
        init.limits.initTimeoutMs = 1000;
        const sparse = await runner.dryRun({init, code: "function move(){const a=[];a[3000000]=1;return {direction:'up',a}}"});
        assert.equal(sparse.ok, true);
        assert.equal(sparse.raw.a.length, ${MAX_SANDBOX_ARRAY_LENGTH});
        const large = await runner.dryRun({init, code: "function move(){return {direction:'up',a:{b:Array(40).fill('x'.repeat(5000))}}}"});
        assert.equal(large.ok, false);
        assert.equal(large.raw, null);
        assert.match(large.error, /65536/);
        init.limits.moveTimeoutMs = Number.MIN_VALUE;
        const timeout = await runner.dryRun({init, code: "function move(){return {direction:'up',detail:'x'.repeat(5000)}}"});
        assert.equal(timeout.ok, false);
        assert.equal(timeout.raw, null);
        const sizes = [sparse, large, timeout].map(result => Buffer.byteLength(JSON.stringify(result), 'utf8'));
        assert.ok(sizes.every(size => size < 1024));
        console.log(JSON.stringify({sizes}));
      } finally { await runner.shutdownRunner(); }
    })().catch(error => {console.error(error); process.exitCode = 1});
  `;
  const { stdout } = await exec(process.execPath, ['-e', program], {
    cwd: resolve(__dirname, '../..'), env: { ...process.env, RUNNER_WORKERS: '1' },
    timeout: 15_000, maxBuffer: 32 * 1024,
  });
  assert.match(stdout, /"sizes":\[/);
});
