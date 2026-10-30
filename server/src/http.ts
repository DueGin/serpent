import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, type ZodType } from 'zod';

const statuses = { UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, VALIDATION_ERROR: 422, CONFLICT: 409, LIMIT_EXCEEDED: 409, RATE_LIMITED: 429, INTERNAL: 500 } as const;
export type ErrorCode = keyof typeof statuses;
export class AppError extends Error {
  readonly status: number;
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.name = 'AppError';
    this.status = statuses[code];
  }
}
export function runnerError(error: unknown): AppError | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  if (error.code === 'RUNNER_BUSY' || error.code === 'RUNNER_UNAVAILABLE') {
    return new AppError('RATE_LIMITED', '模拟任务池繁忙或暂不可用，请稍后重试');
  }
  return undefined;
}
export async function runnerCall<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) { throw runnerError(error) ?? error; }
}
export function parseInput<T>(schema: ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.issues[0]?.message || '参数不合法');
  return parsed.data;
}
export function databaseWrite<T>(operation: () => T): T {
  try { return operation(); }
  catch (err) {
    if ((err as { code?: string })?.code?.startsWith('SQLITE_CONSTRAINT')) {
      throw new AppError('CONFLICT', '名称或记录已存在，或关联记录不合法');
    }
    throw err;
  }
}
export function sendError(res: Response, err: unknown): void {
  err = runnerError(err) ?? err;
  if (err instanceof ZodError) err = new AppError('VALIDATION_ERROR', err.issues[0]?.message || '参数不合法');
  if (!(err instanceof AppError)) {
    const e = err as { code?: string; type?: string };
    if (e?.code?.startsWith('SQLITE_CONSTRAINT')) err = new AppError('CONFLICT', '名称或记录已存在，或关联记录不合法');
    else if (e?.type === 'entity.parse.failed' || e?.type === 'entity.too.large') err = new AppError('VALIDATION_ERROR', 'JSON 格式错误或请求体过大');
    else err = new AppError('INTERNAL', '服务暂时不可用');
  }
  const error = err as AppError;
  res.status(error.status).json({ error: { code: error.code, message: error.message } });
}
export const errorMiddleware: ErrorRequestHandler = (err, _req, res, _next) => sendError(res, err);
export function asyncRoute(fn: (req: Request, res: Response, next: NextFunction) => unknown): RequestHandler {
  return (req, res, next) => { Promise.resolve().then(() => fn(req, res, next)).catch(next); };
}
