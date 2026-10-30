import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { config, DEFAULT_AGENT_PROMPT } from './config';
import { decryptSecret, encryptSecret } from './crypto';

export type Protocol = 'chat' | 'message' | 'jev' | 'laya';

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  created_at: number;
}

export interface AgentRow {
  id: number;
  user_id: number;
  name: string;
  protocol: Protocol;
  base_url: string;
  model: string;
  api_key: string;
  system_prompt: string;
  platform_key: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export type PublicAgent = {
  id: number;
  user_id: number;
  name: string;
  protocol: Protocol;
  base_url: string;
  model: string;
  system_prompt: string;
  enabled: boolean;
  created_at: number;
  updated_at: number;
  apiKeyHint: string;
  platformKey: string;
};

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) db = openDatabase(config.dbPath);
  return db;
}

export function setDb(instance: Database.Database): void {
  db = instance;
}

export function openDatabase(file: string): Database.Database {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const instance = new Database(file);
  instance.pragma('journal_mode = WAL');
  instance.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      protocol TEXT NOT NULL DEFAULT 'chat',
      base_url TEXT NOT NULL,
      model TEXT NOT NULL,
      api_key TEXT NOT NULL,
      system_prompt TEXT NOT NULL DEFAULT '',
      platform_key TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_agents_user ON agents(user_id);
  `);
  return instance;
}

export function createUser(username: string, passwordHash: string): UserRow {
  const now = Date.now();
  const info = getDb().prepare(
    'INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)',
  ).run(username, passwordHash, now);
  return getUserById(Number(info.lastInsertRowid))!;
}

export function getUserById(id: number): UserRow | undefined {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export function getUserByName(username: string): UserRow | undefined {
  return getDb().prepare('SELECT * FROM users WHERE lower(username) = lower(?)').get(username) as UserRow | undefined;
}

export function newPlatformKey(): string {
  return `agk_${randomBytes(24).toString('hex')}`;
}

export function createAgent(input: {
  userId: number;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  model: string;
  apiKey: string;
  systemPrompt?: string;
}): AgentRow {
  const now = Date.now();
  const platformKey = newPlatformKey();
  const info = getDb().prepare(`
    INSERT INTO agents (user_id, name, protocol, base_url, model, api_key, system_prompt, platform_key, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    input.userId,
    input.name,
    input.protocol,
    input.baseUrl.replace(/\/+$/, ''),
    input.model,
    encryptSecret(input.apiKey),
    input.systemPrompt?.trim() || DEFAULT_AGENT_PROMPT,
    platformKey,
    now,
    now,
  );
  return getAgentById(Number(info.lastInsertRowid))!;
}

function hydrateAgent(row: AgentRow | undefined): AgentRow | undefined {
  if (!row) return undefined;
  if (row.api_key && !row.api_key.startsWith('enc1:')) {
    getDb().prepare('UPDATE agents SET api_key = ? WHERE id = ?').run(encryptSecret(row.api_key), row.id);
    return row;
  }
  return { ...row, api_key: decryptSecret(row.api_key) };
}

export function getAgentById(id: number): AgentRow | undefined {
  const row = getDb().prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined;
  return hydrateAgent(row);
}

export function getAgentByPlatformKey(key: string): AgentRow | undefined {
  if (!key) return undefined;
  const row = getDb().prepare('SELECT * FROM agents WHERE platform_key = ?').get(key) as AgentRow | undefined;
  return hydrateAgent(row);
}

export function listAgentsByUser(userId: number): AgentRow[] {
  const rows = getDb().prepare('SELECT * FROM agents WHERE user_id = ? ORDER BY id DESC').all(userId) as AgentRow[];
  return rows.map((r) => hydrateAgent(r)!);
}

export function updateAgent(id: number, patch: Partial<{
  name: string;
  protocol: Protocol;
  baseUrl: string;
  model: string;
  apiKey: string;
  systemPrompt: string;
  enabled: boolean;
}>): AgentRow | undefined {
  const cur = getAgentById(id);
  if (!cur) return undefined;
  const next = {
    name: patch.name ?? cur.name,
    protocol: patch.protocol ?? cur.protocol,
    base_url: patch.baseUrl ? patch.baseUrl.replace(/\/+$/, '') : cur.base_url,
    model: patch.model ?? cur.model,
    api_key: patch.apiKey && patch.apiKey.trim() ? encryptSecret(patch.apiKey.trim()) : encryptSecret(cur.api_key),
    system_prompt: patch.systemPrompt ?? cur.system_prompt,
    enabled: patch.enabled === undefined ? cur.enabled : (patch.enabled ? 1 : 0),
  };
  getDb().prepare(`
    UPDATE agents SET name=?, protocol=?, base_url=?, model=?, api_key=?, system_prompt=?, enabled=?, updated_at=?
    WHERE id=?
  `).run(next.name, next.protocol, next.base_url, next.model, next.api_key, next.system_prompt, next.enabled, Date.now(), id);
  return getAgentById(id);
}

export function deleteAgent(id: number, userId: number): boolean {
  const info = getDb().prepare('DELETE FROM agents WHERE id = ? AND user_id = ?').run(id, userId);
  return info.changes > 0;
}

export function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export function toPublicAgent(row: AgentRow): PublicAgent {
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    protocol: row.protocol,
    base_url: row.base_url,
    model: row.model,
    system_prompt: row.system_prompt,
    enabled: !!row.enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
    apiKeyHint: maskKey(row.api_key),
    platformKey: row.platform_key,
  };
}
