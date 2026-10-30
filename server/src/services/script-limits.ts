import { performance } from 'node:perf_hooks';
import type Database from 'better-sqlite3';
import { AppError, runnerCall } from '../http';
import { assertRunning } from './lifecycle';
import type { Principal } from './principal';

export const SCRIPT_CHECK_LIMITS = { concurrent: 2, requests: 20, windowMs: 60_000 } as const;
type Usage = { active: number; starts: number[] };
const usages = new WeakMap<Database.Database, Map<string, Usage>>();
const pendingChecks = new WeakMap<Database.Database, Set<Promise<unknown>>>();

export async function waitScriptChecks(db: Database.Database): Promise<void> {
  while (pendingChecks.get(db)?.size) await Promise.allSettled([...(pendingChecks.get(db) ?? [])]);
}

// Validate and dry-run share a budget across REST/MCP and key rotations.
// Idle identities are pruned on admission, so the limiter itself cannot grow forever.
export async function checkedScriptCall<T>(db: Database.Database, p: Principal | undefined, operation: () => Promise<T>): Promise<T> {
  assertRunning(db);
  if (!p) throw new AppError('UNAUTHORIZED', '检测或试跑需要用户或 Agent 身份');
  let identities = usages.get(db);
  if (!identities) { identities = new Map(); usages.set(db, identities); }
  const now = performance.now();
  for (const [key, usage] of identities) {
    usage.starts = usage.starts.filter(time => now - time < SCRIPT_CHECK_LIMITS.windowMs);
    if (!usage.active && !usage.starts.length) identities.delete(key);
  }
  // 按归属用户计额度：Agent Key 与 JWT、以及同一用户名下多个 Agent 共用同一份，
  // 否则多建几个 Agent 就能成倍放大额度、挤占全局 runner 队列。
  const key = `user:${p.userId}`;
  let usage = identities.get(key);
  if (!usage) { usage = { active: 0, starts: [] }; identities.set(key, usage); }
  if (usage.active >= SCRIPT_CHECK_LIMITS.concurrent || usage.starts.length >= SCRIPT_CHECK_LIMITS.requests) {
    throw new AppError('RATE_LIMITED', '检测与试跑共用每身份最多 2 个并发、每 60 秒 20 次的额度');
  }
  usage.active++;
  usage.starts.push(now);
  let pending = pendingChecks.get(db);
  if (!pending) { pending = new Set(); pendingChecks.set(db, pending); }
  const task = runnerCall(operation);
  pending.add(task);
  try { return await task; }
  finally { pending.delete(task); usage.active--; }
}
