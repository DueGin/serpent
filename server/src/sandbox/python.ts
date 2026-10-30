import { spawn, type ChildProcess } from 'node:child_process';
import { realpathSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { Direction, InitInfo, ScriptState } from '../types';
import { SandboxError, type Sandbox, type SandboxCallResult, type SandboxOptions } from './index';

const replySchema = z.object({
  id: z.number().optional(), ready: z.boolean().optional(), fatal: z.boolean().optional(),
  raw: z.unknown().optional(), error: z.string().max(1000).optional(), timeout: z.boolean().optional(),
  hasMove: z.boolean().optional(), hasInit: z.boolean().optional(), logs: z.array(z.string().max(500)).max(200).optional(),
  elapsedMs: z.number().nonnegative().optional(), cpuMs: z.number().nonnegative().optional(),
  startupMs: z.number().optional(), baselineBytes: z.number().optional(), wasmBytes: z.number().optional(),
});
type Reply = z.infer<typeof replySchema>;
const positive = (value: string | undefined, fallback: number) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
};
const maxHosts = positive(process.env.PYTHON_MAX_HOSTS, 4);
const warmHosts = Math.min(maxHosts, Math.max(0, Number(process.env.PYTHON_WARM_HOSTS ?? 1) || 0));
const hosts = new Set<PythonHost>();
const warm: PythonHost[] = [];
let warming = false;
let stopping = false;
let lastStartup: Pick<Reply, 'startupMs' | 'baselineBytes' | 'wasmBytes'> = {};

export function pythonHostDiagnostics() {
  return { hosts: hosts.size, warm: warm.length, maxHosts, warmHosts, ...lastStartup };
}

export function pythonHostCommand(entry: string, resources: string): { command: string; args: string[] } {
  const node = realpathSync(process.execPath);
  const args = ['--permission', `--allow-fs-read=${resources}`, `--allow-fs-read=${entry}`,
    `--allow-fs-read=${join(dirname(entry), 'python-bootstrap.py')}`, '--allow-worker',
    '--disallow-code-generation-from-strings', '--max-old-space-size=192', entry, resources];
  // Node 22's permission model does NOT restrict networking. Require an OS network boundary.
  if (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
    const literal = (value: string) => `(literal ${JSON.stringify(value)})`;
    const profile = '(version 1)(allow default)(deny network*)(deny file-write*)(deny process-fork)' +
      '(deny file-read-data)(allow file-read-data ' +
      [node, entry, join(dirname(entry), 'python-bootstrap.py'), '/'].map(literal).join(' ') +
      ` (subpath ${JSON.stringify(resources)}) (subpath "/System/Library") (subpath "/usr/lib") (subpath "/dev"))`;
    return { command: '/usr/bin/sandbox-exec', args: ['-p',
      profile, node, ...args] };
  }
  if (process.platform === 'linux' && existsSync('/usr/bin/bwrap')) {
    const binds = [node, entry, join(dirname(entry), 'python-bootstrap.py'), resources,
      '/usr/lib', '/usr/lib64', '/lib', '/lib64', '/etc/ld.so.cache']
      .filter(value => existsSync(value)).flatMap(value => ['--ro-bind', value, value]);
    return { command: '/usr/bin/bwrap', args: ['--die-with-parent', '--unshare-net',
      '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--new-session',
      '--tmpfs', '/', ...binds, '--dev', '/dev', '--proc', '/proc', '--', node, ...args] };
  }
  throw new SandboxError('Python 需要 OS 网络隔离（macOS sandbox-exec 或 Linux bubblewrap），未配置时拒绝执行');
}

class PythonHost {
  readonly child: ChildProcess;
  readonly ready: Promise<Reply>;
  private sequence = 0;
  private pending?: { id: number; resolve: (reply: Reply) => void; timer: NodeJS.Timeout };
  private dead = false;
  private busy = false;
  private readyResolve?: (reply: Reply) => void;
  private readyReject?: (error: Error) => void;
  private readyTimer: NodeJS.Timeout;

  constructor() {
    const resources = realpathSync(dirname(require.resolve('pyodide')));
    const entry = join(__dirname, 'python-host.cjs');
    const invocation = pythonHostCommand(entry, resources);
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.child = spawn(invocation.command, invocation.args, { env: {}, cwd: resources,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json' });
    hosts.add(this);
    this.readyTimer = setTimeout(() => this.stop('Python 解释器启动超时'), 15_000);
    this.child.on('message', (data: unknown) => {
      const parsed = replySchema.safeParse(data);
      if (!parsed.success) { this.stop('Python IPC 返回值无效'); return; }
      const reply = parsed.data;
      if (reply.ready && this.readyResolve) {
        lastStartup = { startupMs: reply.startupMs, baselineBytes: reply.baselineBytes, wasmBytes: reply.wasmBytes };
        clearTimeout(this.readyTimer);
        this.readyResolve(reply);
        this.readyResolve = undefined;
        this.readyReject = undefined;
        return;
      }
      const pending = this.pending;
      if (!pending || (reply.id !== pending.id && !reply.fatal)) return;
      this.pending = undefined;
      clearTimeout(pending.timer);
      pending.resolve(reply);
      if (reply.fatal) this.stop(reply.error ?? 'Python 解释器已失格');
    });
    this.child.on('error', () => this.stop('Python 隔离进程启动失败'));
    this.child.on('exit', () => this.stop('Python 隔离进程已退出，已失格'));
  }

  async call(operation: string, payload: unknown, timeoutMs: number, memoryLimitMB: number): Promise<Reply> {
    if (this.dead) return { fatal: true, error: 'Python 隔离进程已退出，已失格' };
    if (this.busy) return { fatal: true, error: 'Python 禁止并发调用同一解释器' };
    this.busy = true;
    try {
      const text = JSON.stringify(payload);
      if (Buffer.byteLength(text) > 2 * 1024 * 1024) return { error: 'Python 输入超过限制' };
      return await new Promise<Reply>((resolve) => {
        const id = ++this.sequence;
        const timer = setTimeout(() => this.stop('Python 中断无响应，已终止进程并失格'), timeoutMs + 1000);
        this.pending = { id, resolve, timer };
        this.child.send({ id, operation, payload: text, timeoutMs, memoryLimitMB }, (error) => {
          if (error) this.stop('Python IPC 通道已断开，已失格');
        });
      });
    } finally { this.busy = false; }
  }

  stop(reason = 'Python 沙箱已释放'): void {
    if (this.dead) return;
    this.dead = true;
    hosts.delete(this);
    const index = warm.indexOf(this);
    if (index >= 0) warm.splice(index, 1);
    clearTimeout(this.readyTimer);
    this.readyReject?.(new SandboxError(reason));
    this.readyReject = undefined;
    this.readyResolve = undefined;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.resolve({ fatal: true, error: reason });
      this.pending = undefined;
    }
    this.child.kill('SIGKILL');
  }

  idle(): void { this.child.unref(); this.child.channel?.unref(); }
  claim(): void { this.child.ref(); this.child.channel?.ref(); }
}

export async function prewarmPythonHosts(): Promise<void> {
  if (warming) return;
  if (stopping) return;
  warming = true;
  try {
    while (warm.length < warmHosts && hosts.size < maxHosts) {
      const host = new PythonHost();
      // Make the not-yet-used host claimable while it boots, so four participants
      // cannot be crowded out by an unclaimable in-flight prewarm.
      warm.push(host);
      try { await host.ready; if (warm.includes(host)) host.idle(); }
      catch { host.stop(); break; }
    }
  } finally { warming = false; }
}

export function shutdownPythonHosts(): void {
  stopping = true;
  for (const host of hosts) host.stop();
  warm.splice(0);
}

export class PythonSandbox implements Sandbox {
  readonly hasInit: boolean;
  readonly hasMove: boolean;
  readonly startupCpuMs: number;
  private logs: string[] = [];
  private constructor(private readonly host: PythonHost, private readonly options: SandboxOptions, inspection: Reply) {
    this.hasInit = inspection.hasInit === true;
    this.hasMove = inspection.hasMove === true;
    this.startupCpuMs = inspection.cpuMs ?? 0;
    this.logs.push(...inspection.logs ?? []);
  }

  static async create(code: string, options: SandboxOptions): Promise<PythonSandbox> {
    stopping = false;
    if (Buffer.byteLength(code) > 65536) throw new SandboxError('脚本大小不得超过 65536 字节');
    if (![options.moveTimeoutMs, options.initTimeoutMs, options.memoryLimitMB].every(n => Number.isFinite(n) && n > 0)) {
      throw new SandboxError('沙箱限制参数无效');
    }
    let host = warm.shift();
    if (!host) {
      if (hosts.size >= maxHosts) throw new SandboxError('Python 隔离进程并发已满，请稍后重试');
      host = new PythonHost();
    }
    host.claim();
    try {
      await host.ready;
      const inspection = await host.call('load', { code, seed: options.seed, slot: options.slot }, options.initTimeoutMs, options.memoryLimitMB);
      if (inspection.error || inspection.timeout || inspection.fatal) throw new SandboxError(inspection.error ?? 'Python 加载失败', inspection.timeout);
      return new PythonSandbox(host, options, inspection);
    } catch (error) { host.stop(); throw error; }
  }

  private async invoke(operation: 'init' | 'move', input: InitInfo | ScriptState): Promise<SandboxCallResult> {
    const start = performance.now();
    const result = await this.host.call(operation, input,
      operation === 'move' ? this.options.moveTimeoutMs : this.options.initTimeoutMs, this.options.memoryLimitMB);
    this.logs.push(...result.logs ?? []);
    const raw = result.error || result.timeout ? null : result.raw ?? null;
    const value = typeof raw === 'string' ? raw : raw && typeof raw === 'object' && 'direction' in raw ? raw.direction : null;
    const candidate = typeof value === 'string' ? value.toLowerCase() : '';
    const direction: Direction | null = candidate === 'up' || candidate === 'down' || candidate === 'left' || candidate === 'right' ? candidate : null;
    return { raw, direction, elapsedMs: result.elapsedMs ?? performance.now() - start,
      cpuMs: result.cpuMs ?? 0, timeout: result.timeout === true, ...(result.error ? { error: result.error } : {}),
      ...(result.fatal ? { fatal: true } : {}) };
  }
  init(info: InitInfo): Promise<SandboxCallResult> { return this.invoke('init', info); }
  move(state: ScriptState): Promise<SandboxCallResult> { return this.invoke('move', state); }
  drainLogs(): string[] { return this.logs.splice(0); }
  dispose(): void { this.host.stop(); void prewarmPythonHosts(); }
}
