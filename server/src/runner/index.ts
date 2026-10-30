import { cpus } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import type {
  CheckReport, DryRunInput, DryRunResult, Frame, Replay, ScenarioInfo,
  ScriptLanguage, ScriptState, SimulateInput, SimulateResult,
} from '../types';
import { defaultConfig, ENGINE_VERSION } from './config';
import { listScenarios } from './scenarios';
import { replayFrames, frameState } from './replay';
import { PythonUnavailableError } from '../sandbox/python-availability';

export { ENGINE_VERSION, defaultConfig, listScenarios, replayFrames, frameState };

export class RunnerBusyError extends Error {
  readonly code = 'RUNNER_BUSY';
  constructor(readonly reason: 'queue_full' | 'queue_bytes' | 'queue_timeout') {
    super(reason === 'queue_timeout' ? 'runner queue deadline exceeded' : 'runner queue capacity exceeded');
    this.name = 'RunnerBusyError';
  }
}

export class RunnerUnavailableError extends Error {
  readonly code = 'RUNNER_UNAVAILABLE';
  constructor(readonly retryAfterMs: number, detail?: string) {
    super(`runner workers unavailable${detail ? `: ${detail}` : ''}`);
    this.name = 'RunnerUnavailableError';
  }
}

type JobName = 'simulate' | 'validate' | 'dryRun';
type QueuedJob = {
  id: number; name: JobName; input: unknown; bytes: number; deadline: number;
  timer?: NodeJS.Timeout; settled: boolean;
  resolve(value: unknown): void; reject(error: Error): void;
};
type Slot = { worker: Worker; ready: boolean; stopping: boolean; job?: QueuedJob; timer?: NodeJS.Timeout };
interface PoolOptions {
  size?: number; jobTimeoutMs?: number; maxPendingJobs?: number; maxPendingBytes?: number;
  queueTimeoutMs?: number; startupTimeoutMs?: number; retryBaseMs?: number; retryMaxMs?: number;
  maxStartupFailures?: number; circuitCooldownMs?: number; workerFactory?: () => Worker;
}

function positive(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.max(1, Math.floor(number)) : fallback;
}

function workerEntry(): Worker {
  const built = join(__dirname, 'worker.js');
  const source = join(__dirname, 'worker.ts');
  // The ready signal follows loading the entrypoint, not just Node's online
  // event: a missing module is a startup failure, never a crashed match.
  const load = existsSync(built) ? `require(${JSON.stringify(built)});`
    : `require('tsx/cjs'); require(${JSON.stringify(source)});`;
  return new Worker(`${load} require('node:worker_threads').parentPort.postMessage({type:'runner-ready'});`, { eval: true });
}

/** Internal pool implementation; injectable workers keep failure tests deterministic. */
export class RunnerPool {
  private readonly size: number;
  private readonly jobTimeoutMs: number;
  private readonly maxPendingJobs: number;
  private readonly maxPendingBytes: number;
  private readonly queueTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly maxStartupFailures: number;
  private readonly circuitCooldownMs: number;
  private readonly workerFactory: () => Worker;
  private nextJob = 0;
  private stopping = false;
  private slots: Slot[] = [];
  private queue: QueuedJob[] = [];
  private pendingJobs = 0;
  private pendingBytes = 0;
  private startupFailures = 0;
  private nextStartAt = 0;
  private circuitUntil = 0;
  private startupError?: string;
  private retryTimer?: NodeJS.Timeout;
  private shutdownPromise?: Promise<void>;

  constructor(options: PoolOptions = {}) {
    this.size = Math.min(32, positive(options.size, Math.min(4, Math.max(1, cpus().length - 1))));
    this.jobTimeoutMs = positive(options.jobTimeoutMs, 180_000);
    this.maxPendingJobs = positive(options.maxPendingJobs, 64);
    this.maxPendingBytes = positive(options.maxPendingBytes, 8 * 1024 * 1024);
    this.queueTimeoutMs = positive(options.queueTimeoutMs, 30_000);
    this.startupTimeoutMs = positive(options.startupTimeoutMs, 10_000);
    this.retryBaseMs = positive(options.retryBaseMs, 100);
    this.retryMaxMs = positive(options.retryMaxMs, 2000);
    this.maxStartupFailures = positive(options.maxStartupFailures, 5);
    this.circuitCooldownMs = positive(options.circuitCooldownMs, 30_000);
    this.workerFactory = options.workerFactory ?? workerEntry;
  }

  get diagnostics() {
    return { pendingJobs: this.pendingJobs, pendingBytes: this.pendingBytes, queuedJobs: this.queue.length,
      workers: this.slots.length, retryScheduled: this.retryTimer !== undefined,
      startupFailures: this.startupFailures, circuitOpen: Date.now() < this.circuitUntil };
  }

  run<T>(name: JobName, input: unknown): Promise<T> {
    if (this.stopping) return Promise.reject(new Error('runner is shutting down'));
    if (Date.now() < this.circuitUntil) return Promise.reject(this.unavailable());
    if (this.circuitUntil) {
      this.circuitUntil = 0;
      this.startupFailures = 0;
      this.startupError = undefined;
    }
    if (this.pendingJobs >= this.maxPendingJobs) return Promise.reject(new RunnerBusyError('queue_full'));
    let bytes: number;
    try { bytes = Buffer.byteLength(JSON.stringify(input) ?? 'null', 'utf8'); }
    catch (error) { return Promise.reject(error); }
    // Executing inputs also count until their result settles. A large job
    // cannot bypass the memory ceiling merely by leaving the waiting queue.
    if (bytes > this.maxPendingBytes - this.pendingBytes) return Promise.reject(new RunnerBusyError('queue_bytes'));
    return new Promise<T>((resolve, reject) => {
      const job: QueuedJob = { id: ++this.nextJob, name, input, bytes,
        deadline: Date.now() + this.queueTimeoutMs, settled: false,
        resolve: (value) => resolve(value as T), reject };
      this.pendingJobs++;
      this.pendingBytes += bytes;
      job.timer = setTimeout(() => {
        const index = this.queue.indexOf(job);
        if (index >= 0) this.queue.splice(index, 1);
        this.settle(job, new RunnerBusyError('queue_timeout'));
        this.pump();
      }, this.queueTimeoutMs);
      this.queue.push(job);
      this.pump();
    });
  }

  private settle(job: QueuedJob, error?: Error, result?: unknown): void {
    if (job.settled) return;
    job.settled = true;
    if (job.timer) clearTimeout(job.timer);
    job.timer = undefined;
    this.pendingJobs--;
    this.pendingBytes -= job.bytes;
    if (error) job.reject(error);
    else job.resolve(result);
  }

  private unavailable(): RunnerUnavailableError {
    return new RunnerUnavailableError(Math.max(0, this.circuitUntil - Date.now()), this.startupError);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private startupFailed(error: Error): void {
    this.startupError = error.message;
    this.startupFailures++;
    if (this.startupFailures >= this.maxStartupFailures) {
      this.circuitUntil = Date.now() + this.circuitCooldownMs;
      this.clearRetry();
      for (const job of this.queue.splice(0)) this.settle(job, this.unavailable());
      return;
    }
    const backoff = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** (this.startupFailures - 1));
    this.nextStartAt = Date.now() + backoff;
  }

  private createSlot(): boolean {
    let worker: Worker;
    try { worker = this.workerFactory(); }
    catch (error) {
      this.startupFailed(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
    const slot: Slot = { worker, ready: false, stopping: false };
    this.slots.push(slot);
    slot.timer = setTimeout(() => this.failSlot(slot, new Error('runner worker startup timed out')), this.startupTimeoutMs);
    slot.timer.unref();
    worker.on('message', (message: { type?: string; id?: number; result?: unknown; error?: string; errorCode?: string; reason?: string }) => {
      if (slot.stopping || !message || typeof message !== 'object') return;
      if (message.type === 'runner-ready' && !slot.ready) {
        if (slot.timer) clearTimeout(slot.timer);
        slot.timer = undefined;
        slot.ready = true;
        this.startupFailures = 0;
        this.startupError = undefined;
        this.circuitUntil = 0;
        this.nextStartAt = 0;
        this.pump();
        return;
      }
      if (!slot.ready || !slot.job || slot.job.id !== message.id) return;
      const job = slot.job;
      slot.job = undefined;
      if (slot.timer) clearTimeout(slot.timer);
      slot.timer = undefined;
      this.settle(job, message.errorCode === 'PYTHON_UNAVAILABLE'
        ? new PythonUnavailableError(message.reason ?? 'Python 解释器启动失败')
        : message.error ? new Error(message.error) : undefined, message.result);
      this.pump();
    });
    worker.on('error', (error) => this.failSlot(slot, error));
    worker.on('exit', (code) => {
      if (!slot.stopping) this.failSlot(slot, new Error(`runner worker exited (${code})`));
    });
    return true;
  }

  private failSlot(slot: Slot, error: Error): void {
    if (slot.stopping) return;
    slot.stopping = true;
    if (slot.timer) clearTimeout(slot.timer);
    if (slot.job) this.settle(slot.job, error);
    slot.job = undefined;
    const index = this.slots.indexOf(slot);
    if (index >= 0) this.slots.splice(index, 1);
    void slot.worker.terminate().catch(() => undefined);
    if (!this.stopping) {
      if (!slot.ready) this.startupFailed(error);
      else this.nextStartAt = Math.max(this.nextStartAt, Date.now() + this.retryBaseMs);
      this.pump();
    }
  }

  private pump(): void {
    if (this.stopping) return;
    for (const slot of this.slots) {
      if (!slot.ready || slot.job || slot.stopping) continue;
      let job = this.queue.shift();
      while (job && Date.now() >= job.deadline) {
        this.settle(job, new RunnerBusyError('queue_timeout'));
        job = this.queue.shift();
      }
      if (!job) break;
      if (job.timer) clearTimeout(job.timer);
      job.timer = undefined;
      slot.job = job;
      slot.timer = setTimeout(() => this.failSlot(slot, new Error(`runner job timed out after ${this.jobTimeoutMs}ms`)), this.jobTimeoutMs);
      slot.timer.unref();
      try { slot.worker.postMessage({ id: job.id, name: job.name, input: job.input }); }
      catch (error) {
        if (slot.timer) clearTimeout(slot.timer);
        slot.timer = undefined;
        slot.job = undefined;
        this.settle(job, error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (!this.queue.length) { this.clearRetry(); return; }
    if (Date.now() < this.circuitUntil) {
      for (const job of this.queue.splice(0)) this.settle(job, this.unavailable());
      this.clearRetry();
      return;
    }
    const starting = this.slots.filter((slot) => !slot.ready).length;
    if (this.slots.length >= this.size || starting >= this.queue.length) return;
    if (Date.now() < this.nextStartAt) {
      this.clearRetry();
      this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.pump(); }, this.nextStartAt - Date.now());
      return;
    }
    this.clearRetry();
    while (this.slots.length < this.size && this.slots.filter((slot) => !slot.ready).length < this.queue.length) {
      if (!this.createSlot()) { this.pump(); break; }
    }
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopping = true;
    this.clearRetry();
    for (const job of this.queue.splice(0)) this.settle(job, new Error('runner shut down'));
    const workers = this.slots.splice(0).map(async (slot) => {
      slot.stopping = true;
      if (slot.timer) clearTimeout(slot.timer);
      if (slot.job) this.settle(slot.job, new Error('runner shut down'));
      await slot.worker.terminate().catch(() => undefined);
    });
    this.shutdownPromise = Promise.all(workers).then(() => undefined).finally(() => {
      this.stopping = false;
      this.nextStartAt = 0;
      this.circuitUntil = 0;
      this.startupFailures = 0;
      this.startupError = undefined;
      this.shutdownPromise = undefined;
    });
    return this.shutdownPromise;
  }
}

const pool = new RunnerPool({
  size: positive(process.env.RUNNER_WORKERS, Math.min(4, Math.max(1, cpus().length - 1))),
  jobTimeoutMs: positive(process.env.RUNNER_JOB_TIMEOUT_MS, 180_000),
  maxPendingJobs: positive(process.env.RUNNER_QUEUE_MAX_JOBS, 64),
  maxPendingBytes: positive(process.env.RUNNER_QUEUE_MAX_BYTES, 8 * 1024 * 1024),
  queueTimeoutMs: positive(process.env.RUNNER_QUEUE_TIMEOUT_MS, 30_000),
});
export function simulate(input: SimulateInput): Promise<SimulateResult> { return pool.run('simulate', input); }
export function validateScript(code: string, language: ScriptLanguage = 'javascript'): Promise<CheckReport> {
  return pool.run('validate', { code, language });
}
export function dryRun(input: DryRunInput): Promise<DryRunResult> { return pool.run('dryRun', input); }
export function shutdownRunner(): Promise<void> { return pool.shutdown(); }

export type { CheckReport, DryRunInput, DryRunResult, Frame, Replay, ScenarioInfo, ScriptLanguage, ScriptState, SimulateInput, SimulateResult };
