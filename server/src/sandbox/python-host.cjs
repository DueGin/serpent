'use strict';
// Trusted process supervisor. This file is copied verbatim into dist/sandbox.
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const nativeProcess = process;
// macOS CoreFoundation injects __CF_USER_TEXT_ENCODING even into env:{} execs.
for (const key of Object.keys(nativeProcess.env)) delete nativeProcess.env[key];
const nativeNow = performance.now.bind(performance);
const PROTOCOL_LIMIT = 2 * 1024 * 1024;

if (isMainThread) {
  const interrupt = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(__filename, { workerData: { interrupt: interrupt.buffer, resources: process.argv[2] } });
  let pending;
  let baseline = 0;
  let closed = false;
  const send = (value) => { if (process.connected) process.send(value); };
  const fail = (reason) => {
    if (closed) return;
    closed = true;
    send({ id: pending?.id, fatal: true, error: reason });
    void worker.terminate().finally(() => process.exit(1));
  };
  process.on('disconnect', () => process.exit(0));
  // Includes both the WASM allocation and Python/JS heaps; checked even during a stuck call.
  const monitor = setInterval(() => {
    if (baseline && process.memoryUsage().rss > baseline + (pending?.memoryLimitMB ?? 32) * 1024 * 1024) {
      fail('Python 内存超过解释器基线限制，已失格');
    }
  }, 5);
  monitor.unref();
  worker.on('error', () => fail('Python 解释器崩溃，已失格'));
  worker.on('exit', () => { if (!closed) fail('Python 解释器退出，已失格'); });
  worker.on('message', (message) => {
    if (message.ready) {
      baseline = process.memoryUsage().rss;
      send({ ready: true, startupMs: message.startupMs, baselineBytes: baseline, wasmBytes: message.wasmBytes });
      return;
    }
    if (!pending || pending.id !== message.id) return;
    clearTimeout(pending.timer);
    clearTimeout(pending.grace);
    const cpu = process.cpuUsage(pending.cpu);
    const result = { ...message, timeout: pending.interrupted || message.timeout,
      elapsedMs: nativeNow() - pending.started, cpuMs: (cpu.user + cpu.system) / 1000 };
    if (result.timeout) { result.raw = null; result.error = 'Python 调用超时'; }
    pending = undefined;
    Atomics.store(interrupt, 0, 0);
    send(result);
  });
  process.on('message', (message) => {
    if (closed || pending || !message || typeof message !== 'object' ||
        !Number.isSafeInteger(message.id) || typeof message.payload !== 'string' ||
        Buffer.byteLength(message.payload) > PROTOCOL_LIMIT) return fail('Python IPC 输入无效');
    if (!['load', 'init', 'move'].includes(message.operation)) return fail('Python IPC 操作无效');
    Atomics.store(interrupt, 0, 0);
    const timeout = Math.min(500, Math.max(1, Number(message.timeoutMs) || 50));
    pending = { id: message.id, cpu: process.cpuUsage(), started: nativeNow(),
      memoryLimitMB: Math.min(32, Math.max(1, Number(message.memoryLimitMB) || 32)), interrupted: false };
    pending.timer = setTimeout(() => {
      if (!pending) return;
      pending.interrupted = true;
      Atomics.store(interrupt, 0, 2);
      pending.grace = setTimeout(() => fail('Python 中断宽限期耗尽，已终止进程并失格'), 200);
    }, timeout);
    worker.postMessage(message);
  });
} else {
  (async () => {
    const started = nativeNow();
    const bootstrap = fs.readFileSync(path.join(__dirname, 'python-bootstrap.py'), 'utf8');
    // Emscripten NODEFS eagerly asks for constants even though NODEFS is removed below.
    // Do not relax --permission or expose native bindings for this compatibility shim.
    nativeProcess.binding = (name) => {
      if (name === 'constants') return { fs: fs.constants };
      throw new Error('禁止原生绑定');
    };
    const { loadPyodide } = require(path.join(workerData.resources, 'pyodide.js'));
    const py = await loadPyodide({ indexURL: workerData.resources + path.sep,
      packageBaseUrl: 'file:///__serpent_no_packages__/', packages: [],
      env: { PYTHONHASHSEED: '0' },
      enableRunUntilComplete: false, stdout: () => {}, stderr: () => {} });
    py.setInterruptBuffer(new Int32Array(workerData.interrupt));
    // No native or host filesystem may be mounted, including through recovered bridge references.
    for (const name of Object.keys(py.FS.filesystems)) {
      if (name !== 'MEMFS') delete py.FS.filesystems[name];
    }
    py.FS.mount = () => { throw new Error('禁止挂载文件系统'); };
    py.loadPackage = async () => { throw new Error('禁止加载外部包'); };
    py.loadPackagesFromImports = py.loadPackage;
    const driver = py.runPython(bootstrap);
    let tick = 0;
    let randomState = 0;
    const NativeDate = Date;
    function DeterministicDate(...args) {
      const date = new NativeDate(...(args.length ? args : [tick * 120]));
      return new.target ? date : date.toString();
    }
    DeterministicDate.prototype = NativeDate.prototype;
    DeterministicDate.now = () => tick * 120;
    DeterministicDate.parse = NativeDate.parse;
    DeterministicDate.UTC = NativeDate.UTC;
    globalThis.Date = DeterministicDate;
    Math.random = () => {
      randomState = (randomState + 0x6d2b79f5) >>> 0;
      let value = randomState;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
    };
    Object.defineProperty(performance, 'now', { value: () => tick * 120 });
    const baselineFootprint = py._module._malloc_footprint();
    // An RSS sampler misses short-lived/lazily committed allocations. dlmalloc's
    // allocator limit is synchronous and also covers allocations freed before return.
    py._module._malloc_set_footprint_limit(baselineFootprint + 32 * 1024 * 1024);
    // Install trusted C allocator wrappers, not Python tracing: a script can clear
    // frame.f_trace or catch MemoryError, but a failed allocation must still DQ it.
    let allocationFailed = false;
    const memory = py._module;
    for (const domain of [0, 1, 2]) {
      const descriptor = memory._PyMem_RawMalloc(20);
      memory._PyMem_GetAllocator(domain, descriptor);
      const original = Array.from(memory.HEAPU32.slice(descriptor / 4, descriptor / 4 + 5));
      for (const [index, signature] of [[1, 'iii'], [2, 'iiii'], [3, 'iiii']]) {
        const allocate = memory.wasmTable.get(original[index]);
        const wrapper = memory.addFunction((...args) => {
          const pointer = allocate(...args);
          const nonzeroSize = index === 2 ? (args[1] >>> 0) !== 0 && (args[2] >>> 0) !== 0 :
            (args.at(-1) >>> 0) !== 0;
          if (!pointer && nonzeroSize) allocationFailed = true;
          return pointer;
        }, signature);
        memory.HEAPU32[descriptor / 4 + index] = wrapper;
      }
      memory._PyMem_SetAllocator(domain, descriptor);
      // Keep the tiny descriptor allocation: its wrapper installation is part of baseline.
    }
    // Emscripten has already captured the trusted primitives needed by CPython.
    for (const name of ['process', 'require', 'module', 'fetch', 'WebSocket', 'XMLHttpRequest',
      'Worker', 'SharedWorker', 'EventSource', 'BroadcastChannel', 'WebTransport',
      'navigator', 'crypto', 'loadPyodide', '_createPyodideModule', '__dirname', '__filename']) {
      try { Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false }); }
      catch { /* Non-configurable absent host features remain protected by OS/Node permissions. */ }
    }
    parentPort.postMessage({ ready: true, startupMs: nativeNow() - started,
      wasmBytes: py._module.HEAPU8.byteLength });
    parentPort.on('message', (message) => {
      let value;
      try {
        const input = JSON.parse(message.payload);
        if (message.operation === 'load') randomState = ((input.seed >>> 0) ^
          Math.imul((input.slot + 1) >>> 0, 0x9e3779b9)) >>> 0;
        tick = message.operation === 'move' ? input.tick : 0;
        py._module._malloc_set_footprint_limit(baselineFootprint +
          Math.min(32, Math.max(1, Number(message.memoryLimitMB) || 32)) * 1024 * 1024);
        const serialized = driver(message.operation, message.payload);
        if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > 512 * 1024) {
          throw new Error('Python 返回值超过限制');
        }
        value = JSON.parse(serialized);
      } catch { value = { raw: null, error: 'Python 解释器执行失败' }; }
      if (allocationFailed) value = { raw: null, fatal: true, error: 'Python 内存分配超过限制，已失格' };
      parentPort.postMessage({ id: message.id, ...value });
    });
  })().catch((error) => { nativeProcess.stderr.write(String(error.stack) + '\n'); nativeProcess.exitCode = 1; parentPort.close(); });
}
