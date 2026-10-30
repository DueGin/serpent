import type Database from 'better-sqlite3';
import { AppError } from '../http';

export interface Lifecycle { generation: number; stopping: boolean }
const lifecycles = new WeakMap<Database.Database, Lifecycle>();

export function lifecycle(db: Database.Database): Lifecycle {
  let token = lifecycles.get(db);
  if (!token) { token = { generation: 0, stopping: false }; lifecycles.set(db, token); }
  return token;
}
export function startLifecycle(db: Database.Database): Lifecycle {
  const token = { generation: lifecycle(db).generation + 1, stopping: false };
  lifecycles.set(db, token);
  return token;
}
export function lifecycleActive(db: Database.Database, token: Lifecycle): boolean {
  return db.open && !token.stopping && lifecycles.get(db) === token;
}
export function assertRunning(db: Database.Database): void {
  if (!lifecycleActive(db, lifecycle(db))) throw new AppError('RATE_LIMITED', '服务正在关闭，请稍后重试');
}
