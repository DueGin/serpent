import { Router } from 'express';
import { z } from 'zod';
import { createUser, getUserByName } from '../db';
import { hashPassword, requireAuth, signToken, verifyPassword, type AuthedRequest } from '../auth';
import { AppError, asyncRoute } from '../http';
import { emptySchema } from './schemas';

const router = Router();

const credSchema = z.object({
  username: z.string().trim().min(2).max(20).regex(/^[\w\u4e00-\u9fff-]+$/, '用户名仅含字母数字下划线或中文'),
  password: z.string().min(6).max(72),
}).strict();

router.post('/register', asyncRoute((req, res) => {
  emptySchema.parse(req.query);
  const { username, password } = credSchema.parse(req.body);
  if (getUserByName(username)) {
    throw new AppError('CONFLICT', '用户名已被占用');
  }
  const user = createUser(username, hashPassword(password));
  res.status(201).json({
    token: signToken(user),
    user: { id: user.id, username: user.username, createdAt: user.created_at },
  });
}));

router.post('/login', asyncRoute((req, res) => {
  emptySchema.parse(req.query);
  const credentials = credSchema.parse(req.body);
  const user = getUserByName(credentials.username);
  if (!user || !verifyPassword(credentials.password, user.password_hash)) {
    throw new AppError('UNAUTHORIZED', '用户名或密码错误');
  }
  res.json({
    token: signToken(user),
    user: { id: user.id, username: user.username, createdAt: user.created_at },
  });
}));

router.get('/me', requireAuth, asyncRoute((req: AuthedRequest, res) => {
  emptySchema.parse(req.query);
  res.json({ user: { id: req.auth!.userId, username: req.auth!.username } });
}));

export default router;
