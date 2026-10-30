import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { cpus } from 'node:os';

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
  playbackTickMs: Math.max(1, Number(process.env.PLAYBACK_TICK_MS) || 120),
  ladderIntervalMs: Math.max(100, Number(process.env.LADDER_INTERVAL_MS) || 20_000),
  ladderAuto: process.env.LADDER_AUTO !== '0',
  runnerWorkers: Math.max(1, Number(process.env.RUNNER_WORKERS) || Math.min(4, Math.max(1, cpus().length - 1))),
  runnerJobTimeoutMs: Math.max(1, Number(process.env.RUNNER_JOB_TIMEOUT_MS) || 180_000),
};
