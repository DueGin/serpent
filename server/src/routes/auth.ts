import { Router } from 'express';
import { z } from 'zod';
import { createUser, getUserByName } from '../db';
import { hashPassword, requireAuth, signToken, verifyPassword, type AuthedRequest } from '../auth';

const router = Router();

const credSchema = z.object({
  username: z.string().trim().min(2).max(20).regex(/^[\w\u4e00-\u9fff-]+$/, '用户名仅含字母数字下划线或中文'),
  password: z.string().min(6).max(72),
});

router.post('/register', (req, res) => {
  const parsed = credSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message || '注册信息不合法' } });
    return;
  }
  const { username, password } = parsed.data;
  if (getUserByName(username)) {
    res.status(409).json({ error: { code: 'CONFLICT', message: '用户名已被占用' } });
    return;
  }
  const user = createUser(username, hashPassword(password));
  res.status(201).json({
    token: signToken(user),
    user: { id: user.id, username: user.username, createdAt: user.created_at },
  });
});

router.post('/login', (req, res) => {
  const parsed = credSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: '请输入用户名和密码' } });
    return;
  }
  const user = getUserByName(parsed.data.username);
  if (!user || !verifyPassword(parsed.data.password, user.password_hash)) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '用户名或密码错误' } });
    return;
  }
  res.json({
    token: signToken(user),
    user: { id: user.id, username: user.username, createdAt: user.created_at },
  });
});

router.get('/me', requireAuth, (req: AuthedRequest, res) => {
  res.json({ user: { id: req.auth!.userId, username: req.auth!.username } });
});

export default router;
