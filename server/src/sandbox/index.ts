import { performance } from 'node:perf_hooks';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
} from 'quickjs-emscripten-core';
import type { Direction, InitInfo, ScriptLanguage, ScriptState } from '../types';

const MAX_CODE_BYTES = 64 * 1024;
const MAX_LOG_LINES = 200;
const MAX_LOG_CHARS = 500;
export const MAX_SANDBOX_RESULT_BYTES = 64 * 1024;
export const MAX_SANDBOX_ARRAY_LENGTH = 128;
const DIRECTIONS = new Set<Direction>(['up', 'down', 'left', 'right']);

export interface SandboxOptions {
  seed: number;
  slot: number;
  moveTimeoutMs: number;
  initTimeoutMs: number;
  memoryLimitMB: number;
}

export interface SandboxCallResult {
  raw: unknown;
  direction: Direction | null;
  elapsedMs: number;
  timeout: boolean;
  error?: string;
  fatal?: boolean;
  cpuMs?: number;
}

export interface Sandbox {
  readonly hasInit: boolean;
  readonly hasMove: boolean;
  readonly startupCpuMs?: number;
  init(info: InitInfo): SandboxCallResult | Promise<SandboxCallResult>;
  move(state: ScriptState): SandboxCallResult | Promise<SandboxCallResult>;
  drainLogs(): string[];
  dispose(): void;
}

export interface ScriptInspection {
  compile: boolean;
  hasMove: boolean;
  hasInit: boolean;
  error?: string;
}

export class SandboxError extends Error {
  constructor(message: string, readonly timeout = false, readonly elapsedMs = 0) {
    super(message);
    this.name = 'SandboxError';
  }
}

const getQuickJS = (() => {
  let loading: ReturnType<typeof newQuickJSWASMModuleFromVariant> | undefined;
  return () => (loading ??= newQuickJSWASMModuleFromVariant(variant));
})();

interface GuestHostState {
  deadline: number;
  interrupted: boolean;
  tick: number;
  randomState: number;
  logs: string[];
  logCount: number;
}

function initialRandomState(seed: number, slot: number): number {
  let state = (seed >>> 0) ^ Math.imul((slot + 1) >>> 0, 0x9e3779b9);
  state ^= state >>> 16;
  state = Math.imul(state, 0x85ebca6b);
  state ^= state >>> 13;
  return (state ^ (state >>> 16)) >>> 0;
}

function parseDirection(raw: unknown): Direction | null {
  const candidate = typeof raw === 'string'
    ? raw
    : raw && typeof raw === 'object' && 'direction' in raw
      ? (raw as { direction: unknown }).direction
      : null;
  if (typeof candidate !== 'string') return null;
  const direction = candidate.toLowerCase() as Direction;
  return DIRECTIONS.has(direction) ? direction : null;
}

function formatError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

// All property access and serialization of untrusted values stays inside QuickJS.
// The only host callback argument is a primitive string; no host object enters the VM.
const BOOTSTRAP = `
(() => {
  const root = globalThis;
  const create = Object.create;
  const keys = Object.keys;
  const setPrototypeOf = Object.setPrototypeOf;
  const isArray = Array.isArray;
  const apply = Reflect.apply;
  const slice = String.prototype.slice;
  const charCodeAt = String.prototype.charCodeAt;
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const string = String;
  const finite = Number.isFinite;
  const hostNow = __hostNow;
  const hostRandom = __hostRandom;
  const hostLog = __hostLog;
  const NativeDate = Date;
  const clip = (text, length) => apply(slice, text, [0, length]);
  const utf8Bytes = text => {
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
      const code = apply(charCodeAt, text, [i]);
      if (code < 128) bytes++;
      else if (code < 2048) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length &&
          apply(charCodeAt, text, [i + 1]) >= 0xdc00 && apply(charCodeAt, text, [i + 1]) <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    }
    return bytes;
  };
  const spend = (budget, bytes) => {
    budget.bytes -= bytes;
    if (budget.bytes < 0) throw '返回值序列化超过 ${MAX_SANDBOX_RESULT_BYTES} 字节限制';
  };
  const primitive = (value, budget) => {
    spend(budget, utf8Bytes(stringify(value)));
    return value;
  };
  const message = (error) => {
    try { return clip(string(error && error.message !== undefined ? error.message : error), 1000); }
    catch (_) { return '脚本执行错误'; }
  };
  const envelope = (raw, error) => {
    const out = create(null);
    out.raw = raw;
    if (error !== undefined) out.error = error;
    return stringify(out);
  };
  const sanitize = (value, depth, budget, seen) => {
    if (--budget.count < 0 || depth > 8) return primitive('[truncated]', budget);
    if (value === null || typeof value === 'boolean') return primitive(value, budget);
    if (typeof value === 'string') return primitive(clip(value, 5000), budget);
    if (typeof value === 'number') return primitive(finite(value) ? value : null, budget);
    if (typeof value !== 'object') return primitive(null, budget);
    for (let i = 0; i < seen.length; i++) {
      if (seen[i] === value) return primitive('[circular]', budget);
    }
    seen[seen.length] = value;
    spend(budget, 2);
    let out;
    if (isArray(value)) {
      out = setPrototypeOf([], null);
      const length = value.length;
      for (let i = 0; i < ${MAX_SANDBOX_ARRAY_LENGTH} && i < length && budget.count > 0; i++) {
        if (i) spend(budget, 1);
        out[i] = sanitize(value[i], depth + 1, budget, seen);
      }
    } else {
      out = create(null);
      const names = keys(value);
      for (let i = 0; i < names.length && budget.count > 0; i++) {
        const key = clip(names[i], 500);
        spend(budget, utf8Bytes(stringify(key)) + 1 + (i ? 1 : 0));
        out[key] = sanitize(value[names[i]], depth + 1, budget, seen);
      }
    }
    seen.length--;
    return out;
  };
  function DeterministicDate(...args) {
    const date = new NativeDate(...(args.length ? args : [hostNow()]));
    return new.target ? date : date.toString();
  }
  DeterministicDate.prototype = NativeDate.prototype;
  DeterministicDate.prototype.constructor = DeterministicDate;
  DeterministicDate.now = hostNow;
  DeterministicDate.parse = NativeDate.parse;
  DeterministicDate.UTC = NativeDate.UTC;
  root.Date = DeterministicDate;
  Math.random = hostRandom;
  const console = create(null);
  let lineCount = 0;
  const log = (...values) => {
    if (lineCount >= 200) return;
    lineCount++;
    let text = '';
    for (let i = 0; i < values.length && text.length < 500; i++) {
      let part;
      try {
        part = typeof values[i] === 'string' ? values[i] :
          stringify(sanitize(values[i], 0, {count: 100, bytes: 4096}, []));
      } catch (_) { part = '[unprintable]'; }
      text += (i ? ' ' : '') + part;
    }
    hostLog(clip(text, 500));
  };
  console.log = log;
  console.info = log;
  console.warn = log;
  console.error = log;
  root.console = console;
  delete root.__hostNow;
  delete root.__hostRandom;
  delete root.__hostLog;
  root.module = { exports: {} };
  root.exports = root.module.exports;
  const find = name => {
    const module = root.module;
    const exported = module && module.exports;
    const candidate = exported && exported[name];
    if (typeof candidate === 'function') return candidate;
    if (name === 'move' && typeof move === 'function') return move;
    if (name === 'init' && typeof init === 'function') return init;
    return undefined;
  };
  return function(operation, payload) {
    if (operation === 'format-error') return envelope(null, message(payload));
    try {
      if (operation === 'inspect') {
        const result = create(null);
        result.hasMove = typeof find('move') === 'function';
        result.hasInit = typeof find('init') === 'function';
        return stringify(result);
      }
      const fn = find(operation);
      if (typeof fn !== 'function') return envelope(null, operation + '() 未定义');
      const result = apply(fn, undefined, [parse(payload)]);
      if (result !== null && (typeof result === 'object' || typeof result === 'function') &&
          typeof result.then === 'function') return envelope(null, '不支持 Promise 返回值');
      if (operation === 'init') return envelope(null);
      return envelope(sanitize(result, 0, {count: 500, bytes: ${MAX_SANDBOX_RESULT_BYTES - 8}}, []));
    } catch (error) { return envelope(null, message(error)); }
  };
})()
`;

/** A participant owns one isolated QuickJS runtime for the entire match. */
export class ScriptSandbox {
  private disposed = false;

  private constructor(
    private readonly runtime: QuickJSRuntime,
    private readonly context: QuickJSContext,
    private readonly driver: QuickJSHandle,
    private readonly options: SandboxOptions,
    private readonly host: GuestHostState,
    readonly hasInit: boolean,
    readonly hasMove: boolean,
  ) {}

  static async create(code: string, options: SandboxOptions): Promise<ScriptSandbox> {
    if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
      throw new SandboxError(`脚本大小不得超过 ${MAX_CODE_BYTES} 字节`);
    }
    if (!Number.isFinite(options.moveTimeoutMs) || options.moveTimeoutMs <= 0 ||
        !Number.isFinite(options.initTimeoutMs) || options.initTimeoutMs <= 0 ||
        !Number.isFinite(options.memoryLimitMB) || options.memoryLimitMB <= 0) {
      throw new SandboxError('沙箱限制参数无效');
    }

    const quickjs = await getQuickJS();
    const runtime = quickjs.newRuntime();
    runtime.setMemoryLimit(Math.floor(options.memoryLimitMB * 1024 * 1024));
    runtime.setMaxStackSize(256 * 1024);
    const started = performance.now();
    const host: GuestHostState = {
      // Bootstrap is trusted platform code, not part of the participant's init budget.
      deadline: Number.POSITIVE_INFINITY,
      interrupted: false,
      tick: 0,
      randomState: initialRandomState(options.seed, options.slot),
      logs: [],
      logCount: 0,
    };
    runtime.setInterruptHandler(() => {
      if (performance.now() < host.deadline) return false;
      host.interrupted = true;
      return true;
    });

    let context: QuickJSContext | undefined;
    let driver: QuickJSHandle | undefined;
    try {
      context = runtime.newContext();
      const vm = context;
      const callbacks = {
        __hostNow: () => vm.newNumber(host.tick * 120),
        __hostRandom: () => {
          host.randomState = (host.randomState + 0x6d2b79f5) >>> 0;
          let n = host.randomState;
          n = Math.imul(n ^ (n >>> 15), n | 1);
          n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
          return vm.newNumber(((n ^ (n >>> 14)) >>> 0) / 0x100000000);
        },
        __hostLog: (text: QuickJSHandle) => {
          if (host.logCount < MAX_LOG_LINES && vm.typeof(text) === 'string') {
            host.logs.push(vm.getString(text).slice(0, MAX_LOG_CHARS));
            host.logCount++;
          }
          return vm.undefined;
        },
      };
      for (const [name, callback] of Object.entries(callbacks)) {
        const handle = vm.newFunction(name, callback);
        try { vm.setProp(vm.global, name, handle); }
        finally { handle.dispose(); }
      }
      const bootstrap = vm.evalCode(BOOTSTRAP, 'serpent-bootstrap.js', { type: 'global' });
      if (bootstrap.error) {
        bootstrap.error.dispose();
        throw new SandboxError(host.interrupted ? '脚本初始化超时' : '沙箱初始化失败',
          host.interrupted, performance.now() - started);
      }
      driver = bootstrap.value;
      const userStarted = performance.now();
      host.deadline = userStarted + options.initTimeoutMs;
      const evaluated = vm.evalCode(code, 'serpent-user.js', { type: 'global' });
      if (evaluated.error) {
        let message = '脚本编译或初始化失败';
        if (!host.interrupted) message = ScriptSandbox.guestError(vm, driver, evaluated.error);
        evaluated.error.dispose();
        throw new SandboxError(host.interrupted ? '脚本初始化超时' : message,
          host.interrupted, performance.now() - started);
      }
      evaluated.value.dispose();
      const check = ScriptSandbox.runDriver(vm, driver, 'inspect', '');
      if (host.interrupted || performance.now() - userStarted > options.initTimeoutMs) {
        throw new SandboxError('脚本初始化超时', true, performance.now() - userStarted);
      }
      if (check.error) throw new SandboxError(check.error, false, performance.now() - started);
      host.deadline = Number.POSITIVE_INFINITY;
      return new ScriptSandbox(runtime, vm, driver, options, host, check.hasInit === true, check.hasMove === true);
    } catch (error) {
      driver?.dispose();
      context?.dispose();
      runtime.dispose();
      if (error instanceof SandboxError) throw error;
      const elapsedMs = performance.now() - started;
      const timeout = host.interrupted || elapsedMs > options.initTimeoutMs;
      throw new SandboxError(timeout ? '脚本初始化超时' : formatError(error), timeout, elapsedMs);
    }
  }

  private static guestError(vm: QuickJSContext, driver: QuickJSHandle, error: QuickJSHandle): string {
    const op = vm.newString('format-error');
    try {
      const result = vm.callFunction(driver, vm.undefined, op, error);
      if (result.error) {
        result.error.dispose();
        return '脚本执行错误';
      }
      try {
        return vm.typeof(result.value) === 'string'
          ? String(JSON.parse(vm.getString(result.value)).error ?? '脚本执行错误') : '脚本执行错误';
      } finally { result.value.dispose(); }
    } finally { op.dispose(); }
  }

  private static runDriver(vm: QuickJSContext, driver: QuickJSHandle, operation: string, payload: string):
    { raw?: unknown; error?: string; hasInit?: boolean; hasMove?: boolean } {
    const op = vm.newString(operation);
    const data = vm.newString(payload);
    try {
      const result = vm.callFunction(driver, vm.undefined, op, data);
      if (result.error) {
        // Never dump arbitrary guest errors: dump may invoke hostile getters or consume handles.
        result.error.dispose();
        return { error: '脚本执行错误' };
      }
      try {
        if (vm.typeof(result.value) !== 'string') return { error: '沙箱返回值格式错误' };
        const serialized = vm.getString(result.value);
        if (Buffer.byteLength(serialized, 'utf8') > MAX_SANDBOX_RESULT_BYTES) {
          return { error: `返回值序列化超过 ${MAX_SANDBOX_RESULT_BYTES} 字节限制` };
        }
        return JSON.parse(serialized);
      } finally { result.value.dispose(); }
    } finally { op.dispose(); data.dispose(); }
  }

  init(info: InitInfo): SandboxCallResult {
    if (!this.hasInit) return { raw: null, direction: null, elapsedMs: 0, timeout: false };
    this.host.tick = 0;
    return this.invoke('init', info, this.options.initTimeoutMs);
  }

  move(state: ScriptState): SandboxCallResult {
    this.host.tick = state.tick;
    return this.invoke('move', state, this.options.moveTimeoutMs);
  }

  private invoke(name: 'init' | 'move', input: InitInfo | ScriptState, timeoutMs: number): SandboxCallResult {
    if (this.disposed) throw new SandboxError('沙箱已释放');
    const started = performance.now();
    this.host.interrupted = false;
    this.host.deadline = started + timeoutMs;
    try {
      const result = ScriptSandbox.runDriver(this.context, this.driver, name, JSON.stringify(input));
      const elapsedMs = performance.now() - started;
      const timeout = this.host.interrupted || elapsedMs > timeoutMs;
      const raw = timeout || result.error ? null : result.raw ?? null;
      return {
        raw,
        direction: name === 'move' ? parseDirection(raw) : null,
        elapsedMs,
        timeout,
        ...(timeout ? { error: `${name}() 超时` } : result.error ? { error: result.error } : {}),
      };
    } catch (error) {
      const elapsedMs = performance.now() - started;
      const timeout = this.host.interrupted || elapsedMs > timeoutMs;
      return { raw: null, direction: null, elapsedMs,
        timeout, error: timeout ? `${name}() 超时` : formatError(error) };
    } finally {
      this.host.deadline = Number.POSITIVE_INFINITY;
    }
  }

  drainLogs(): string[] {
    return this.host.logs.splice(0);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.driver.dispose();
    this.context.dispose();
    this.runtime.dispose();
  }
}

export function createSandbox(code: string, options: SandboxOptions): Promise<ScriptSandbox>;
export function createSandbox(code: string, options: SandboxOptions, language: ScriptLanguage | undefined): Promise<Sandbox>;
export async function createSandbox(code: string, options: SandboxOptions, language: ScriptLanguage = 'javascript'): Promise<Sandbox> {
  if (language === 'python') {
    const { PythonSandbox } = require('./python') as typeof import('./python');
    return PythonSandbox.create(code, options);
  }
  if (language !== 'javascript') throw new SandboxError('不支持的脚本语言');
  return ScriptSandbox.create(code, options);
}

export async function inspectScript(
  code: string,
  options: Partial<SandboxOptions> = {},
  language: ScriptLanguage = 'javascript',
): Promise<ScriptInspection> {
  try {
    const sandbox = await createSandbox(code, {
      seed: options.seed ?? 1,
      slot: options.slot ?? 0,
      moveTimeoutMs: options.moveTimeoutMs ?? 50,
      initTimeoutMs: options.initTimeoutMs ?? 500,
      memoryLimitMB: options.memoryLimitMB ?? 32,
    }, language);
    try {
      return { compile: true, hasMove: sandbox.hasMove, hasInit: sandbox.hasInit };
    } finally {
      sandbox.dispose();
    }
  } catch (error) {
    return { compile: false, hasMove: false, hasInit: false, error: formatError(error) };
  }
}
