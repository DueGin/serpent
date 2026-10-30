import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import { config } from './config';
import { getDb } from './db';
import { docsRouter } from './docs';
import { AppError, errorMiddleware } from './http';
import { createMcpRouter } from './mcp';
import { attachRealtime } from './realtime';
import authRoutes from './routes/auth';
import { createArenaRouter } from './routes/arena';
import { shutdownRunner } from './runner';
import { startMatchmaker } from './services/ladders';

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ exposedHeaders: ['Mcp-Session-Id', 'Mcp-Protocol-Version'] }));
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api/auth', authRoutes);
  app.use('/api/docs', docsRouter);
  app.use('/api', createArenaRouter());
  app.use('/mcp', createMcpRouter());
  app.use(['/api', '/mcp'], (_req, _res, next) => next(new AppError('NOT_FOUND', '接口不存在')));

  const webDist = path.resolve(__dirname, '../../web/dist');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    app.use(express.static(webDist));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/socket.io')) { next(); return; }
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }
  app.use((_req, _res, next) => next(new AppError('NOT_FOUND', '页面不存在')));
  app.use(errorMiddleware);
  return app;
}

export async function startServer(options: { port?: number; host?: string } = {}) {
  getDb().prepare(`UPDATE matches SET status='error',error=?,finished_at=?,broadcast_at=NULL
    WHERE status IN ('queued','running')`).run('服务重启，对局已中断', Date.now());
  const app = createApp();
  const server = http.createServer(app);
  const io = attachRealtime(server);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? config.port, options.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    io.close();
    throw error;
  }
  const stopMatchmaker = startMatchmaker();
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!closing) {
      const stopped = stopMatchmaker();
      closing = (async () => {
        await Promise.all([
          new Promise<void>(resolve => { io.close(() => resolve()); }),
          stopped,
        ]);
        await shutdownRunner();
      })();
    }
    return closing;
  };
  return { app, server, io, close };
}
