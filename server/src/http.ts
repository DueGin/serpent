import type { Response } from 'express';

export function sendError(res: Response, err: unknown): void {
  const anyErr = err as { code?: string; message?: string };
  const code = anyErr.code ?? 'ERROR';
  const status =
    code === 'NOT_FOUND' ? 404
      : code === 'FORBIDDEN' ? 403
      : code === 'FULL' || code === 'STARTED' || code === 'NEED_MORE' ? 409
        : code === 'UPSTREAM' ? 502
        : 400;
  res.status(status).json({
    error: {
      code,
      message: anyErr.message || '请求失败',
    },
  });
}
