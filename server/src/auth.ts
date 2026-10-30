import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from './config';
import { getUserById, type UserRow } from './db';

export interface AuthPayload {
  userId: number;
  username: string;
}

export interface AuthedRequest extends Request {
  auth?: AuthPayload;
}

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}

export function verifyPassword(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash);
}

export function signToken(user: Pick<UserRow, 'id' | 'username'>): string {
  return jwt.sign(
    { userId: user.id, username: user.username } satisfies AuthPayload,
    config.jwtSecret,
    { expiresIn: `${config.jwtDays}d` },
  );
}

export function verifyToken(token: string): AuthPayload {
  const raw = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as AuthPayload;
  if (!Number.isSafeInteger(raw?.userId) || raw.userId < 1 || typeof raw.username !== 'string' || !raw.username) {
    throw new Error('invalid token');
  }
  return { userId: raw.userId, username: raw.username };
}

export function readBearer(req: Request): string | undefined {
  const header = String(req.headers.authorization ?? '');
  const m = header.match(/^Bearer\s+(\S+)\s*$/i);
  return m?.[1];
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  try {
    const token = readBearer(req);
    if (!token) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '请先登录' } });
      return;
    }
    const payload = verifyToken(token);
    const user = getUserById(payload.userId);
    if (!user) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '账号不存在' } });
      return;
    }
    req.auth = { userId: user.id, username: user.username };
    next();
  } catch {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '登录已过期' } });
  }
}
