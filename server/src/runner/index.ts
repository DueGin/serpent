import { cpus } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import type {
  CheckReport, DryRunInput, DryRunResult, Frame, Replay, ScenarioInfo,
  ScriptState, SimulateInput, SimulateResult,
} from '../types';
import { defaultConfig, ENGINE_VERSION } from './config';
import { listScenarios } from './scenarios';
import { replayFrames, frameState } from './replay';

export { ENGINE_VERSION, defaultConfig, listScenarios, replayFrames, frameState };

type JobName = 'simulate' | 'validate' | 'dryRun';
type QueuedJob = { id: number; name: JobName; input: unknown; resolve(value: unknown): void; reject(error: Error): void };
type Slot = { worker: Worker; job?: QueuedJob; timeout?: NodeJS.Timeout; stopping: boolean };
const requestedWorkers = Number(process.env.RUNNER_WORKERS);
const poolSize = Number.isFinite(requestedWorkers) && requestedWorkers > 0
  ? Math.max(1, Math.min(32, Math.floor(requestedWorkers))) : Math.min(4, Math.max(1, cpus().length - 1));
const requestedTimeout = Number(process.env.RUNNER_JOB_TIMEOUT_MS);
const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : 180_000;
let nextJob = 0;
let stopping = false;
let slots: Slot[] = [];
let queue: QueuedJob[] = [];
let shutdown: Promise<void> | undefined;

function workerEntry(): Worker {
  const built = join(__dirname, 'worker.js');
  if (existsSync(built)) return new Worker(built);
  const source = join(__dirname, 'worker.ts');
  // Register the CJS tsx loader inside the worker itself: parent execArgv is
  // not reliably inherited by node:test or a direct tsx invocation.
  return new Worker(`require('tsx/cjs'); require(${JSON.stringify(source)});`, { eval: true });
}

function createSlot(): Slot {
  const slot: Slot = { worker: workerEntry(), stopping: false };
  slot.worker.on('message', (message: { id: number; result?: unknown; error?: string }) => {
    if (!slot.job || slot.job.id !== message.id) return;
    const job = slot.job;
    if (slot.timeout) clearTimeout(slot.timeout);
    slot.job = undefined;
    slot.timeout = undefined;
    if (message.error) job.reject(new Error(message.error));
    else job.resolve(message.result);
    pump();
  });
  slot.worker.on('error', (error) => { failSlot(slot, error); });
  slot.worker.on('exit', (code) => {
    if (!slot.stopping) failSlot(slot, new Error(`runner worker exited (${code})`));
  });
  return slot;
}

function failSlot(slot: Slot, error: Error): void {
  if (slot.stopping) return;
  slot.stopping = true;
  if (slot.timeout) clearTimeout(slot.timeout);
  slot.job?.reject(error);
  slot.job = undefined;
  const i = slots.indexOf(slot);
  if (i >= 0) {
    slots.splice(i, 1);
    void slot.worker.terminate();
    if (!stopping) slots.push(createSlot());
  }
  pump();
}

function pump(): void {
  if (stopping) return;
  for (const slot of slots) {
    if (slot.job || slot.stopping || queue.length === 0) continue;
    const job = queue.shift()!;
    slot.job = job;
    slot.timeout = setTimeout(() => failSlot(slot, new Error(`runner job timed out after ${timeoutMs}ms`)), timeoutMs);
    slot.timeout.unref();
    try { slot.worker.postMessage({ id: job.id, name: job.name, input: job.input }); }
    catch (error) { failSlot(slot, error instanceof Error ? error : new Error(String(error))); }
  }
}

function run<T>(name: JobName, input: unknown): Promise<T> {
  if (stopping) return Promise.reject(new Error('runner is shutting down'));
  if (!slots.length) for (let i = 0; i < poolSize; i++) slots.push(createSlot());
  return new Promise<T>((resolve, reject) => {
    queue.push({ id: ++nextJob, name, input, resolve: (value) => resolve(value as T), reject });
    pump();
  });
}

export function simulate(input: SimulateInput): Promise<SimulateResult> { return run('simulate', input); }
export function validateScript(code: string): Promise<CheckReport> { return run('validate', code); }
export function dryRun(input: DryRunInput): Promise<DryRunResult> { return run('dryRun', input); }

export function shutdownRunner(): Promise<void> {
  if (shutdown) return shutdown;
  stopping = true;
  for (const job of queue.splice(0)) job.reject(new Error('runner shut down'));
  const workers = slots.splice(0).map(async (slot) => {
    slot.stopping = true;
    if (slot.timeout) clearTimeout(slot.timeout);
    slot.job?.reject(new Error('runner shut down'));
    await slot.worker.terminate();
  });
  shutdown = Promise.all(workers).then(() => undefined).finally(() => {
    stopping = false;
    shutdown = undefined;
  });
  return shutdown;
}

// Keep these concrete return types visible to downstream service consumers.
export type { CheckReport, DryRunInput, DryRunResult, Frame, Replay, ScenarioInfo, ScriptState, SimulateInput, SimulateResult };
