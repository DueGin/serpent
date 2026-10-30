import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandbox } from '../sandbox';
import { shutdownPythonHosts } from '../sandbox/python';
import { listScenarios } from './scenarios';

const directory = mkdtempSync(join(tmpdir(), 'serpent-review-'));
const sentinel = join(directory, 'sentinel');
const output = join(directory, 'written');
const secret = 'review-host-secret-4271';
writeFileSync(sentinel, secret);
const options = { seed: 61, slot: 0, moveTimeoutMs: 500, initTimeoutMs: 500, memoryLimitMB: 32 };
const state = listScenarios()[0]?.state;
assert.ok(state);
after(() => { shutdownPythonHosts(); rmSync(directory, { recursive: true, force: true }); });

function hostIntact(): void {
  assert.equal(readFileSync(sentinel, 'utf8'), secret);
  assert.equal(existsSync(output), false);
}

test('安全复查：gc 不能从 JsFinder/JsLoader/模块字典恢复 JS 能力', async () => {
  const sandbox = await createSandbox(`
def move(state):
    import gc, types
    leaked = []
    for obj in gc.get_objects():
        kind = type(obj)
        if kind.__module__ == '_pyodide._importhook':
            if kind.__name__ == 'JsFinder' and obj.jsproxies:
                leaked.append('finder')
            if kind.__name__ == 'JsLoader' and obj.jsproxy is not None:
                leaked.append('loader')
        if kind is types.ModuleType and obj.__name__.split('.')[0] in ('pyodide', '_pyodide', '_pyodide_core'):
            for value in obj.__dict__.copy().values():
                if type(value).__module__ == 'pyodide.ffi' and not isinstance(value, type) and value is not None:
                    leaked.append(obj.__name__)
    return {'direction': 'right', 'leaked': leaked}
`, options, 'python');
  try {
    const result = await sandbox.move(state);
    assert.deepEqual(result.raw, { direction: 'right', leaked: [] }, JSON.stringify(result));
    hostIntact();
  } finally { sandbox.dispose(); }
});

test('安全复查：已移除的 finder 不能重新开放分配器和 NODEFS', async () => {
  const sandbox = await createSandbox(`
def move(state):
    import gc
    for obj in gc.get_objects():
        if type(obj).__name__ == 'JsFinder':
            bridge = obj.jsproxies.get('pyodide_js')
            if bridge is not None:
                bridge._module._malloc_set_footprint_limit(0)
                bomb = bytearray(80 * 1024 * 1024)
                del bomb
                return {'direction':'right','escaped':True}
    return {'direction':'right','escaped':False}
`, options, 'python');
  try {
    const result = await sandbox.move(state);
    assert.deepEqual(result.raw, { direction: 'right', escaped: false }, JSON.stringify(result));
    hostIntact();
  } finally { sandbox.dispose(); }
});

test('确定性复查：random.seed(None) 和 Random(None) 不使用宿主熵', async () => {
  const code = `
import random
def move(state):
    random.seed(None)
    return {'direction':'right', 'module':random.random(), 'instance':random.Random(None).random()}
`;
  const results: unknown[] = [];
  for (let i = 0; i < 2; i++) {
    const sandbox = await createSandbox(code, options, 'python');
    try {
      const result = await sandbox.move(state);
      assert.equal(result.error, undefined, JSON.stringify(result));
      results.push(result.raw);
      hostIntact();
    } finally { sandbox.dispose(); }
  }
  assert.deepEqual(results[0], results[1]);
});

test('日志复查：多参数 print 按换行计数，半行在调用结束时冲刷', async () => {
  const sandbox = await createSandbox(`
def move(state):
    import sys
    print('a', 'b')
    sys.stdout.write('first')
    sys.stdout.write(' second\\nthird\\n')
    print('x' * 1000)
    print('partial', end='')
    return 'right'
`, options, 'python');
  try {
    assert.equal((await sandbox.move(state)).direction, 'right');
    assert.deepEqual(sandbox.drainLogs(), ['a b', 'first second', 'third', 'x'.repeat(500), 'partial']);
    hostIntact();
  } finally { sandbox.dispose(); }
});

test('安全复查：反射找回核心模块也不能制造新的 JS 代理', async () => {
  const sandbox = await createSandbox(`
def move(state):
    import gc
    for obj in gc.get_objects():
        if type(obj).__name__ == 'module' and obj.__name__ == '_pyodide_core':
            try:
                obj.to_js({})
            except PermissionError:
                return {'direction':'right','blocked':True}
            return {'direction':'right','blocked':False}
    return {'direction':'right','blocked':True}
`, options, 'python');
  try {
    const result = await sandbox.move(state);
    assert.deepEqual(result.raw, { direction: 'right', blocked: true }, JSON.stringify(result));
    hostIntact();
  } finally { sandbox.dispose(); }
});

test('安全复查：脚本捕获 MemoryError 也必须失格，不能重置追踪器', async () => {
  const sandbox = await createSandbox(`
def move(state):
    import sys
    try:
        sys.settrace(None)
    except PermissionError:
        pass
    try:
        bomb = bytearray(80 * 1024 * 1024)
    except MemoryError:
        pass
    return 'right'
`, options, 'python');
  try {
    const result = await sandbox.move(state);
    assert.equal(result.fatal, true, JSON.stringify(result));
    assert.match(result.error ?? '', /内存/);
    hostIntact();
  } finally { sandbox.dispose(); }
});

test('可信分配器：关闭当前帧追踪再捕获 MemoryError 仍然失格', async () => {
  const sandbox = await createSandbox(`
def move(state):
    import sys
    sys._getframe().f_trace = None
    try:
        bytearray(80 * 1024 * 1024)
    except MemoryError:
        pass
    return 'right'
`, options, 'python');
  try {
    const result = await sandbox.move(state);
    assert.equal(result.fatal, true, JSON.stringify(result));
    assert.match(result.error ?? '', /内存/);
    hostIntact();
  } finally { sandbox.dispose(); }
});
