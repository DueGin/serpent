import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSandbox, inspectScript, type SandboxOptions } from './index';
import type { InitInfo, ScriptState } from '../types';

const options: SandboxOptions = {
  seed: 8132,
  slot: 1,
  moveTimeoutMs: 500,
  initTimeoutMs: 1000,
  memoryLimitMB: 16,
};

const info = {
  protocol: 'serpent-script-v1', mode: 'solo', teams: false, width: 24, height: 16,
  wrap: false, maxTicks: 100, targetScore: null,
  you: { id: 's0', slot: 0, team: null },
  players: [{ id: 's0', slot: 0, name: 'Test', team: null }],
  limits: { moveTimeoutMs: options.moveTimeoutMs, initTimeoutMs: options.initTimeoutMs, memoryLimitMB: 16 },
} satisfies InitInfo;

function state(tick = 0): ScriptState {
  return {
    ...info, tick, remainingTicks: 100 - tick,
    you: { id: 's0', slot: 0, name: 'Test', team: null, head: { x: 3, y: 3 },
      body: [{ x: 3, y: 3 }], dir: 'right', length: 1, score: 0, alive: true },
    snakes: [], foods: [], legalMoves: ['up', 'down', 'right'],
  };
}

test('exports, persistent state, raw directions and argument isolation', async () => {
  const code = `exports.init = function(info) { globalThis.counter = 0; info.you.id = 'bad'; };
    exports.move = function(s) { counter++; s.you.body[0].x=999; console.log(counter); return {direction: counter === 1 ? 'UP' : 'RIGHT'}; }`;
  const script = await createSandbox(code, options);
  const original = state();
  try {
    assert.equal(script.hasInit, true);
    assert.equal(script.hasMove, true);
    assert.equal(script.init(info).error, undefined);
    assert.equal(info.you.id, 's0');
    assert.equal(script.move(original).direction, 'up');
    assert.equal(script.move(original).direction, 'right');
    assert.equal(original.you.body[0].x, 3);
    assert.deepEqual(script.drainLogs(), ['1', '2']);
  } finally { script.dispose(); }
});

test('same seed/slot produces repeatable random and deterministic Date', async () => {
  const code = `function move(s) { console.log(Math.random(), Date.now(), new Date().getTime()); return 'right' }`;
  const a = await createSandbox(code, options);
  const b = await createSandbox(code, options);
  try {
    for (let tick = 0; tick < 5; tick++) {
      assert.equal(a.move(state(tick)).direction, 'right');
      assert.equal(b.move(state(tick)).direction, 'right');
    }
    const logs = a.drainLogs();
    assert.deepEqual(logs, b.drainLogs());
    assert.equal(logs.length, 5);
    assert.ok(logs[0].endsWith('0 0'));
    assert.ok(logs[4].endsWith('480 480'));
    assert.deepEqual(a.drainLogs(), []);
  } finally { a.dispose(); b.dispose(); }
});

test('cannot access the host through process, require, or constructor escape', async () => {
  const code = `function move() { if (typeof process !== 'undefined' || typeof require !== 'undefined') throw Error('host leaked');
    try { this.constructor.constructor('return process')(); } catch (e) { return 'left'; }
    throw Error('escaped'); }`;
  const script = await createSandbox(code, options);
  try {
    assert.equal(script.move(state()).direction, 'left');
    assert.equal(script.move(state()).error, undefined);
  } finally { script.dispose(); }
});

test('init and move infinite loops interrupt within configured deadline', async () => {
  await assert.rejects(createSandbox('while (true) {}', { ...options, initTimeoutMs: 40 }), error =>
    error instanceof Error && /超时/.test(error.message));
  const script = await createSandbox('function move() { while (true) {} }', { ...options, moveTimeoutMs: 20 });
  try {
    const result = script.move(state());
    assert.equal(result.timeout, true);
    assert.match(result.error ?? '', /超时/);
  } finally { script.dispose(); }
});

test('init timeout and throwing init are distinguishable from invalid direction', async () => {
  for (const [code, timeout] of [
    ['function init() { while (true) {} }; function move() { return "right" }', true],
    ['function init() { throw Error("bad-init") }; function move() { return "right" }', false],
  ] as const) {
    const script = await createSandbox(code, timeout ? { ...options, initTimeoutMs: 40 } : options);
    try {
      const result = script.init(info);
      assert.equal(result.timeout, timeout);
      assert.ok(result.error);
    } finally { script.dispose(); }
  }
});

test('memory bombs and recursion cannot terminate host or escape limits', async () => {
  const script = await createSandbox(`function move() { let a=[]; for (;;) a.push('x'.repeat(100000)); }`,
    { ...options, moveTimeoutMs: 20 });
  try {
    const result = script.move(state());
    assert.ok(result.error);
  } finally { script.dispose(); }
  const recursive = await createSandbox(`function move() { function recur() { return recur() + 1 }; recur() }`, options);
  try {
    const result = recursive.move(state());
    assert.ok(result.error);
  } finally { recursive.dispose(); }
});

test('Promise results are rejected without running their jobs', async () => {
  const script = await createSandbox(`function init() { return Promise.resolve() }
    function move() { return Promise.resolve('right').then(() => console.log('ran async')) }`, options);
  try {
    assert.match(script.init(info).error ?? '', /Promise/);
    assert.match(script.move(state()).error ?? '', /Promise/);
    assert.deepEqual(script.drainLogs(), []);
  } finally { script.dispose(); }
});

test('console line and byte limits apply across a whole match', async () => {
  const script = await createSandbox(`function move() { for (let i=0;i<250;i++) console.log('a'.repeat(700)); return 'right' }`, options);
  try {
    assert.equal(script.move(state()).direction, 'right');
    const logs = script.drainLogs();
    assert.equal(logs.length, 200);
    assert.ok(logs.every(text => text.length === 500));
    assert.equal(script.move(state()).direction, 'right');
    assert.deepEqual(script.drainLogs(), []);
  } finally { script.dispose(); }
});

test('malicious exports getter and frequent console loops cannot evade timeout', async () => {
  await assert.rejects(createSandbox(`Object.defineProperty(module.exports, 'move', { get() { while (true) {} } })`,
    { ...options, initTimeoutMs: 40 }),
    error => error instanceof Error && /超时/.test(error.message));
  const script = await createSandbox(`function move() { for (;;) console.log('line') }`, { ...options, moveTimeoutMs: 20 });
  try {
    const result = script.move(state());
    assert.equal(result.timeout, true);
    assert.equal(script.drainLogs().length, 200);
  } finally { script.dispose(); }
});

test('mutating guest global leaves other sandboxes and host untouched', async () => {
  const polluted = await createSandbox(`Array.prototype.includes = function() { return false }; globalThis.process = 42;
    function move() { return 'right' }`, options);
  const clean = await createSandbox(`function move() { if (![1].includes(1) || typeof process !== 'undefined') throw Error('polluted'); return 'right' }`, options);
  try {
    assert.equal(polluted.move(state()).direction, 'right');
    assert.equal(clean.move(state()).direction, 'right');
    assert.equal([1].includes(1), true);
    assert.equal(typeof process, 'object');
  } finally { polluted.dispose(); clean.dispose(); }
});

test('compile and entrypoint inspection', async () => {
  assert.deepEqual(await inspectScript(`module.exports = {move: () => 'LEFT'}`, options),
    {compile: true, hasMove: true, hasInit: false});
  const invalid = await inspectScript('function move( {', options);
  assert.equal(invalid.compile, false);
  assert.equal(invalid.hasMove, false);
});

test('lexical entrypoints, primitive and object return shapes remain JSON-safe', async () => {
  const script = await createSandbox(`const move = s => ({direction: 'UP', detail: [1, true, null], n: 2});`, options);
  try {
    assert.equal(script.hasMove, true);
    assert.deepEqual(script.move(state()).raw, {direction: 'UP', detail: [1, true, null], n: 2});
  } finally { script.dispose(); }
  for (const code of [
    `function move() { return null; }`,
    `function move() { return undefined; }`,
    `function move() { return 3n; }`,
    `function move() { const a={}; a.self=a; return a; }`,
  ]) {
    const example = await createSandbox(code, options);
    try {
      const result = example.move(state());
      assert.equal(result.error, undefined);
      assert.equal(result.direction, null);
      assert.doesNotThrow(() => JSON.stringify(result.raw));
    } finally { example.dispose(); }
  }
});

test('hostile return getters and thrown error getters stay under deadline', async () => {
  for (const code of [
    `function move() { return { get direction() { while(true) {} } } }`,
    `function move() { return { get then() { while(true) {} } } }`,
    `function move() { throw { get message() { while(true) {} } } }`,
    `function move() { console.log({get value() { while(true) {} }}); return 'right' }`,
  ]) {
    const script = await createSandbox(code, { ...options, moveTimeoutMs: 20 });
    try { assert.equal(script.move(state()).timeout, true); }
    finally { script.dispose(); }
  }
});

test('global helper mutation cannot replace captured serialization builtins', async () => {
  const script = await createSandbox(`
    Object.prototype.toJSON = function() { while(true) {} };
    Array.prototype.toJSON = function() { while(true) {} };
    JSON.parse = function() { throw Error('hijacked') };
    JSON.stringify = function() { throw Error('hijacked') };
    Reflect.apply = function() { throw Error('hijacked') };
    function move(s) { return {direction: s.legalMoves[0], array: [1,2]}; }
  `, options);
  try {
    const result = script.move(state());
    assert.equal(result.error, undefined);
    assert.equal(result.direction, 'up');
  } finally { script.dispose(); }
});

test('imports and async host APIs are unavailable', async () => {
  assert.equal((await inspectScript(`import x from 'node:fs'; function move() { return 'up' }`, options)).compile, false);
  const script = await createSandbox(`function move() {
    if (typeof require !== 'undefined' || typeof fetch !== 'undefined' || typeof setTimeout !== 'undefined') throw Error('API leaked');
    return 'right';
  }`, options);
  try { assert.equal(script.move(state()).direction, 'right'); }
  finally { script.dispose(); }
});
