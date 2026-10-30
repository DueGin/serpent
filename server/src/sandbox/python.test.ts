import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createSandbox, type Sandbox } from './index';
import { prewarmPythonHosts, shutdownPythonHosts, pythonHostCommand } from './python';
import { listScenarios } from '../runner/scenarios';

const options = { seed: 71, slot: 0, moveTimeoutMs: 50, initTimeoutMs: 500, memoryLimitMB: 32 };
const state = listScenarios()[0]?.state;
assert.ok(state);
const directory = mkdtempSync(join(tmpdir(), 'serpent-python-escape-'));
const sentinel = join(directory, 'secret');
const output = join(directory, 'written');
const secret = 'HOST_SENTINEL_91a4b7';
writeFileSync(sentinel, secret);
let connections = 0;
const network = createServer((socket) => { connections++; socket.destroy(); });
const listening = new Promise<number>((resolvePort) => {
  network.listen(0, '127.0.0.1', () => {
    const address = network.address();
    assert.ok(address && typeof address === 'object');
    resolvePort(address.port);
  });
});

after(() => { shutdownPythonHosts(); network.close(); rmSync(directory, { recursive: true, force: true }); });

test('纵深防御：绕开 Python 导入限制后，原生 Node 仍不能读写宿主、联网或生成代码', async () => {
  const port = await listening;
  const resources = realpathSync(resolve(__dirname, '../../node_modules/pyodide'));
  const invocation = pythonHostCommand(join(__dirname, 'python-confinement-probe.cjs'), resources);
  const result = await new Promise<unknown>((resolveReply, reject) => {
    const child = spawn(invocation.command, [...invocation.args, sentinel, output, String(port)],
      { env: {}, cwd: resources, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    child.once('message', resolveReply);
    child.once('error', reject);
    child.once('exit', code => { if (code !== 0) reject(new Error(`probe exited ${code}`)); });
  });
  assert.deepEqual(result, { read: true, write: true, spawn: true, native: true, eval: true,
    emptyEnv: true, network: true, worker: true });
  assert.equal(readFileSync(sentinel, 'utf8'), secret);
  assert.equal(existsSync(output), false);
  assert.equal(connections, 0);
});

async function attack(body: string): Promise<void> {
  const port = await listening;
  let sandbox: Sandbox | undefined;
  try {
    const probe = body.replaceAll('127.0.0.1:1', `127.0.0.1:${port}`);
    sandbox = await createSandbox(`def move(state):\n${probe.split('\n').map(line => '    ' + line).join('\n')}`, options, 'python');
    const result = await sandbox.move(state);
    const exposed = JSON.stringify({ raw: result.raw, logs: sandbox.drainLogs() });
    assert.equal(exposed.includes(secret), false, `宿主秘密泄露: ${body}`);
    // Merely throwing is insufficient: every probe asserts the external side effects.
    assert.equal(readFileSync(sentinel, 'utf8'), secret, `宿主哨兵被修改: ${body}`);
    assert.equal(existsSync(output), false, `宿主文件被创建: ${body}`);
    assert.equal(connections, 0, `建立了网络连接（端口 ${port}）: ${body}`);
    assert.ok(result.error || result.direction === 'right' || result.fatal, JSON.stringify(result));
  } finally { sandbox?.dispose(); }
}

const forbidden = ['js', 'pyodide', 'pyodide_js', '_pyodide', 'micropip', 'ctypes',
  'socket', 'subprocess', 'threading', 'multiprocessing', 'asyncio'];
for (const name of forbidden) {
  test(`逃逸：直接导入 ${name} 不触达宿主`, () => attack(`import ${name}\nreturn 'left'`));
}

const fileRead = `open(${JSON.stringify(sentinel)}).read()`;
const repository = resolve(__dirname, '../auth.ts');
const probes: Record<string, string> = {
  '__import__': `__import__('js').process.exit(17)`,
  '__builtins__': `__builtins__['__import__']('js').fetch('http://127.0.0.1:1')`,
  importlib: `import importlib\nimportlib.import_module('js').process.exit(17)`,
  'sys.modules': `import sys\nbridge = sys.modules.get('js')\nif bridge is not None: bridge.process.exit(17)\nreturn 'right'`,
  'gc.get_objects': `import gc\nfor obj in gc.get_objects():\n    if type(obj).__name__ == 'module' and getattr(obj, '__name__', '') == 'js':\n        obj.process.exit(17)\nreturn 'right'`,
  'object.__subclasses__': `for cls in object.__subclasses__():\n    if cls.__name__ == 'FileIO':\n        return cls(${JSON.stringify(sentinel)}).read().decode()\nreturn 'right'`,
  'open /etc/passwd': `return open('/etc/passwd').read()`,
  '读取仓库源码': `return open(${JSON.stringify(repository)}).read()`,
  '读取哨兵': `return ${fileRead}`,
  '写入哨兵': `open(${JSON.stringify(sentinel)}, 'w').write('changed')`,
  '写宿主文件': `open(${JSON.stringify(output)}, 'w').write('changed')`,
  'io.FileIO': `import io\nreturn io.FileIO(${JSON.stringify(sentinel)}).read().decode()`,
  'os.open': `import os\nreturn os.read(os.open(${JSON.stringify(sentinel)}, os.O_RDONLY), 1024).decode()`,
  'js.process': `import js\njs.process.mainModule.require('fs').readFileSync(${JSON.stringify(sentinel)}, 'utf8')`,
  'js.fetch': `import js\njs.fetch('http://127.0.0.1:1')`,
  NODEFS: `import js\njs.pyodide.FS.mount(js.pyodide.FS.filesystems.NODEFS, {'root': '/'}, '/host')\nreturn open('/host/etc/passwd').read()`,
  SystemRandom: `import random\nrandom.SystemRandom().random()`,
  urandom: `import os\nos.urandom(10)`,
};
for (const [name, body] of Object.entries(probes)) test(`逃逸：${name} 不触达宿主`, () => attack(body));

test('逃逸：反射找回桥接对象仍不能读写宿主或联网', async () => {
  const port = await listening;
  // Pyodide internals can retain JsProxy references. Deliberately search them instead of
  // treating import filtering as a security boundary; the child still has no process/fetch.
  await attack(`import gc\nfor obj in gc.get_objects():\n    if type(obj).__name__ == 'JsProxy':\n        try:\n            obj.fetch('http://127.0.0.1:${port}')\n        except BaseException:\n            pass\nreturn 'right'`);
});

test('隔离：同局两个解释器的全局秘密、后续作业不可相互读取', async () => {
  const first = await createSandbox(`SECRET = ${JSON.stringify(secret)}\ndef move(state):\n    return 'right'`, options, 'python');
  const second = await createSandbox(`def move(state):\n    import gc, sys\n    for obj in gc.get_objects():\n        if type(obj) is dict and obj.get('SECRET'):\n            return obj['SECRET']\n    return 'right'`, { ...options, slot: 1 }, 'python');
  try {
    const result = await second.move(state);
    assert.equal(result.raw, 'right');
    assert.equal(readFileSync(sentinel, 'utf8'), secret);
    assert.equal(existsSync(output), false);
    assert.equal(connections, 0);
  } finally { first.dispose(); second.dispose(); }
  await attack(`return globals().get('SECRET', 'right')`);
});

test('资源：死循环中断保留状态，深递归不能破坏宿主', async () => {
  const sandbox = await createSandbox(`calls = 0\ndef move(state):\n    global calls\n    calls += 1\n    if calls == 1:\n        while True: pass\n    return {'direction': 'right', 'calls': calls}`, options, 'python');
  try {
    const interrupted = await sandbox.move(state);
    assert.equal(interrupted.timeout, true);
    assert.equal(interrupted.fatal, undefined);
    const next = await sandbox.move(state);
    assert.deepEqual(next.raw, { direction: 'right', calls: 2 });
    assert.equal(readFileSync(sentinel, 'utf8'), secret);
    assert.equal(existsSync(output), false);
    assert.equal(connections, 0);
  } finally { sandbox.dispose(); }
  await attack(`def recurse(): return recurse()\nreturn recurse()`);
});

test('资源：捕获 KeyboardInterrupt 后继续死循环会被杀进程', async () => {
  const sandbox = await createSandbox(`def move(state):\n    while True:\n        try:\n            while True: pass\n        except BaseException: pass`, options, 'python');
  try {
    const result = await sandbox.move(state);
    assert.equal(result.fatal, true);
    assert.match(result.error ?? '', /中断|终止|失格/);
    assert.equal(readFileSync(sentinel, 'utf8'), secret);
    assert.equal(existsSync(output), false);
    assert.equal(connections, 0);
  } finally { sandbox.dispose(); }
});

test('资源：内存炸弹立即失格，宿主仍可运行下一作业', async () => {
  const sandbox = await createSandbox(`def move(state):\n    bomb = bytearray(80 * 1024 * 1024)\n    return 'right'`, options, 'python');
  try {
    const result = await sandbox.move(state);
    assert.equal(result.fatal, true, JSON.stringify(result));
    assert.match(result.error ?? '', /内存/);
    assert.equal(readFileSync(sentinel, 'utf8'), secret);
    assert.equal(existsSync(output), false);
    assert.equal(connections, 0);
  } finally { sandbox.dispose(); }
  await attack(`return 'right'`);
});

test('资源：print 和超大返回值被限制，宿主哨兵与网络未受影响', async () => {
  const sandbox = await createSandbox(`def move(state):\n    for i in range(1000): print('x' * 1000)\n    return {'direction':'right','bulk':['a' * 5000] * 100}`, options, 'python');
  try {
    const result = await sandbox.move(state);
    assert.ok(result.error || result.timeout);
    const logs = sandbox.drainLogs();
    assert.equal(logs.length, 200);
    assert.ok(logs.every(line => line.length <= 500));
    assert.equal(readFileSync(sentinel, 'utf8'), secret);
    assert.equal(existsSync(output), false);
    assert.equal(connections, 0);
  } finally { sandbox.dispose(); }
});

test('标准库、dataclass、随机和确定时间可用；预热实例只交付一次', async () => {
  const code = `from dataclasses import dataclass\nimport heapq, itertools, functools, bisect, array, typing, random, time\n@dataclass\nclass Value:\n    n: int\ndef move(state):\n    print(random.random(), time.time(), time.monotonic(), time.perf_counter(), Value(3).n)\n    return 'right'`;
  const logs: string[][] = [];
  for (let i = 0; i < 2; i++) {
    await prewarmPythonHosts();
    const sandbox = await createSandbox(code, options, 'python');
    try { assert.equal((await sandbox.move(state)).direction, 'right'); logs.push(sandbox.drainLogs()); }
    finally { sandbox.dispose(); }
  }
  assert.deepEqual(logs[0], logs[1]);
});
