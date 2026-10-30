import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const dataDir = path.resolve(__dirname, '../data');

function loadOrCreateJwtSecret(): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, '.jwt_secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch { /* first run */ }
  const secret = randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export const config = {
  port: Number(process.env.PORT) || 8008,
  publicUrl: process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 8008}`,
  jwtSecret: loadOrCreateJwtSecret(),
  jwtDays: 7,
  dbPath: process.env.DB_PATH || path.join(dataDir, 'serpent.db'),
};

export const DEFAULT_AGENT_PROMPT = `你是贪吃蛇选手，正在联网对局里自主行动。
根据局面选择下一步，只回复一个英文单词：up、down、left 或 right。
不要解释，不要标点，不要其它文字。

原则：
- 不能 180 度掉头（legalMoves 已排除非法方向，必须从中选）
- 优先吃最近的食物 *
- 避开墙壁 #、自己的身体 B、对手 h/b
- 没有安全吃食路径时，先活着`;
