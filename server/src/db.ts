import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config';
import { hashAgentKey } from './crypto';

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
  description: string;
  model_label: string;
  color: string;
  api_key_hash: string;
  api_key_prefix: string;
  disabled: number;
  created_at: number;
  updated_at: number;
  last_seen_at: number | null;
}

export interface TeamRow {
  id: number;
  name: string;
  tag: string;
  description: string;
  captain_agent_id: number;
  invite_code: string;
  created_at: number;
  disbanded: number;
}

let db: Database.Database | null = null;
const SCHEMA_VERSION = 4;

export function getDb(): Database.Database {
  if (!db) db = openDatabase(config.dbPath);
  return db;
}

export function setDb(instance: Database.Database): void {
  db = instance;
}

export function openDatabase(file: string): Database.Database {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const instance = new Database(file);
  try {
    instance.pragma('journal_mode = WAL');
    instance.pragma('foreign_keys = ON');
    instance.pragma('busy_timeout = 5000');
    const version = instance.pragma('user_version', { simple: true }) as number;
    if (version > SCHEMA_VERSION) throw new Error('Database schema is newer than this server');
    if (version < 1) instance.transaction(() => migrateV1(instance))();
    if (version < 2) instance.transaction(() => migrateV2(instance))();
    if (version < 3) instance.transaction(() => migrateV3(instance))();
    if (version < 4) instance.transaction(() => migrateV4(instance))();
    instance.transaction(() => seedLadders(instance))();
    return instance;
  } catch (err) {
    instance.close();
    throw err;
  }
}

// survival-64 规则上线：脚本语言列；新规则与旧规则成绩不可比，天梯积分与基准成绩清零（历史对局保留）。
function migrateV4(instance: Database.Database): void {
  const columns = instance.pragma('table_info(scripts)') as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'language')) {
    instance.exec(`ALTER TABLE scripts ADD COLUMN language TEXT NOT NULL DEFAULT 'javascript'
      CHECK(language IN ('javascript','python'))`);
  }
  instance.exec(`
    UPDATE ladder_entries SET mu=25, sigma=8.333333333333334, rating=1000, games=0, wins=0,
      avg_score=NULL, best_score=NULL, avg_ticks=NULL, last_match_at=NULL;
    PRAGMA user_version = 4;
  `);
}

function migrateV3(instance: Database.Database): void {
  instance.exec(`
    ALTER TABLE matches ADD COLUMN trace_blob BLOB;
    PRAGMA user_version = 3;
  `);
}

function migrateV2(instance: Database.Database): void {
  instance.exec(`
    ALTER TABLE ladder_entries ADD COLUMN authorized_user_id INTEGER REFERENCES users(id);
    ALTER TABLE ladder_entries ADD COLUMN authorized_agent_id INTEGER REFERENCES agents(id);
    ALTER TABLE ladder_entries ADD COLUMN inactive_reason TEXT;
    UPDATE ladder_entries SET active=0,inactive_reason='阵容授权需要队长重新确认'
      WHERE entrant_type='team';
    PRAGMA user_version = 2;
  `);
}

function migrateV1(instance: Database.Database): void {
  const columns = instance.pragma('table_info(agents)') as Array<{ name: string }>;
  if (columns.some((column) => column.name === 'base_url' || column.name === 'system_prompt')) {
    instance.exec('ALTER TABLE agents RENAME TO agents_legacy');
  }
  instance.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      description TEXT NOT NULL DEFAULT '',
      model_label TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '#edc748',
      api_key_hash TEXT NOT NULL UNIQUE CHECK(length(api_key_hash) = 64),
      api_key_prefix TEXT NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_seen_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS scripts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL REFERENCES agents(id),
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      visibility TEXT NOT NULL DEFAULT 'listed' CHECK(visibility IN ('private','listed','open')),
      active_version_id INTEGER REFERENCES script_versions(id),
      latest_version_id INTEGER REFERENCES script_versions(id),
      archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(agent_id, name)
    );
    CREATE TABLE IF NOT EXISTS script_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      script_id INTEGER NOT NULL REFERENCES scripts(id),
      version INTEGER NOT NULL CHECK(version > 0),
      code TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      size INTEGER NOT NULL CHECK(size >= 0),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','valid','invalid')),
      report_json TEXT,
      note TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      UNIQUE(script_id, version)
    );
    CREATE TABLE IF NOT EXISTS ladders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL CHECK(kind IN ('solo','individual','team')),
      mode TEXT NOT NULL CHECK(mode IN ('solo','score','battle')),
      teams INTEGER NOT NULL DEFAULT 0 CHECK(teams IN (0,1)),
      players_per_match INTEGER NOT NULL CHECK(players_per_match BETWEEN 1 AND 4),
      config_json TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      tag TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      captain_agent_id INTEGER NOT NULL REFERENCES agents(id),
      invite_code TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      disbanded INTEGER NOT NULL DEFAULT 0 CHECK(disbanded IN (0,1))
    );
    CREATE TABLE IF NOT EXISTS team_members (
      team_id INTEGER NOT NULL REFERENCES teams(id),
      agent_id INTEGER NOT NULL UNIQUE REFERENCES agents(id),
      role TEXT NOT NULL CHECK(role IN ('captain','member')),
      joined_at INTEGER NOT NULL,
      PRIMARY KEY(team_id, agent_id)
    );
    CREATE TABLE IF NOT EXISTS ladder_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ladder_id INTEGER NOT NULL REFERENCES ladders(id),
      entrant_type TEXT NOT NULL CHECK(entrant_type IN ('script','team','builtin')),
      script_id INTEGER REFERENCES scripts(id),
      team_id INTEGER REFERENCES teams(id),
      agent_id INTEGER REFERENCES agents(id),
      builtin TEXT,
      lineup_json TEXT,
      mu REAL NOT NULL DEFAULT 25,
      sigma REAL NOT NULL DEFAULT 8.333333333333334 CHECK(sigma > 0),
      rating INTEGER NOT NULL DEFAULT 1000,
      games INTEGER NOT NULL DEFAULT 0 CHECK(games >= 0),
      wins INTEGER NOT NULL DEFAULT 0 CHECK(wins >= 0),
      avg_score REAL,
      best_score INTEGER,
      avg_ticks REAL,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      joined_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_match_at INTEGER,
      CHECK(
        (entrant_type = 'script' AND script_id IS NOT NULL AND agent_id IS NOT NULL AND team_id IS NULL AND builtin IS NULL)
        OR (entrant_type = 'team' AND team_id IS NOT NULL AND script_id IS NULL AND builtin IS NULL)
        OR (entrant_type = 'builtin' AND builtin IS NOT NULL AND script_id IS NULL AND team_id IS NULL AND agent_id IS NULL)
      )
    );
    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK(kind IN ('test','exhibition','ladder','benchmark')),
      mode TEXT NOT NULL CHECK(mode IN ('solo','score','battle')),
      teams INTEGER NOT NULL DEFAULT 0 CHECK(teams IN (0,1)),
      ladder_id INTEGER REFERENCES ladders(id),
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done','error')),
      seed INTEGER NOT NULL,
      config_json TEXT NOT NULL,
      ticks INTEGER NOT NULL DEFAULT 0,
      end_reason TEXT,
      winners_json TEXT NOT NULL DEFAULT '[]',
      winner_team INTEGER,
      replay_blob BLOB,
      error TEXT,
      created_by_user_id INTEGER REFERENCES users(id),
      created_by_agent_id INTEGER REFERENCES agents(id),
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      broadcast_at INTEGER,
      duration_ms REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS match_participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL REFERENCES matches(id),
      slot INTEGER NOT NULL CHECK(slot BETWEEN 0 AND 3),
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      team INTEGER CHECK(team IN (0,1)),
      agent_id INTEGER REFERENCES agents(id),
      script_id INTEGER REFERENCES scripts(id),
      version_id INTEGER REFERENCES script_versions(id),
      version INTEGER,
      builtin TEXT,
      ladder_entry_id INTEGER REFERENCES ladder_entries(id),
      team_id INTEGER REFERENCES teams(id),
      rank INTEGER,
      score INTEGER NOT NULL DEFAULT 0,
      length INTEGER NOT NULL DEFAULT 3,
      alive INTEGER NOT NULL DEFAULT 1 CHECK(alive IN (0,1)),
      death_tick INTEGER,
      death_reason TEXT,
      kills INTEGER NOT NULL DEFAULT 0,
      moves INTEGER NOT NULL DEFAULT 0,
      timeouts INTEGER NOT NULL DEFAULT 0,
      errors INTEGER NOT NULL DEFAULT 0,
      invalid_moves INTEGER NOT NULL DEFAULT 0,
      avg_move_ms REAL NOT NULL DEFAULT 0,
      max_move_ms REAL NOT NULL DEFAULT 0,
      cpu_ms REAL NOT NULL DEFAULT 0,
      first_error TEXT,
      logs_json TEXT NOT NULL DEFAULT '[]',
      rating_before REAL,
      rating_after REAL,
      UNIQUE(match_id, slot)
    );
    CREATE INDEX IF NOT EXISTS idx_arena_agents_user ON agents(user_id, disabled);
    CREATE INDEX IF NOT EXISTS idx_scripts_agent ON scripts(agent_id, archived);
    CREATE INDEX IF NOT EXISTS idx_scripts_public ON scripts(visibility, archived, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_versions_script ON script_versions(script_id, version DESC);
    CREATE INDEX IF NOT EXISTS idx_matches_created ON matches(created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_matches_ladder ON matches(ladder_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_matches_live ON matches(kind, status, broadcast_at DESC);
    CREATE INDEX IF NOT EXISTS idx_matches_agent ON matches(created_by_agent_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_participants_agent ON match_participants(agent_id, match_id DESC);
    CREATE INDEX IF NOT EXISTS idx_participants_script ON match_participants(script_id, match_id DESC);
    CREATE INDEX IF NOT EXISTS idx_participants_team ON match_participants(team_id, match_id DESC);
    CREATE INDEX IF NOT EXISTS idx_entries_ladder ON ladder_entries(ladder_id, active, rating DESC);
    CREATE INDEX IF NOT EXISTS idx_entries_agent ON ladder_entries(agent_id, active);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_script_unique ON ladder_entries(ladder_id, script_id) WHERE script_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_team_unique ON ladder_entries(ladder_id, team_id) WHERE team_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_builtin_unique ON ladder_entries(ladder_id, builtin) WHERE builtin IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_members_team ON team_members(team_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_members_captain ON team_members(team_id) WHERE role = 'captain';
    PRAGMA user_version = 1;
  `);
}

function seedLadders(instance: Database.Database): void {
  const now = Date.now();
  const presets = [
    ['solo', '单人基准', '固定种子，挑战单人最高分', 'solo', 'solo', 0, 1],
    ['battle', '个人对战', '四蛇交锋，最后存活者获胜', 'individual', 'battle', 0, 4],
    ['score', '个人抢分', '穿墙竞速，以分数决胜', 'individual', 'score', 0, 4],
    ['team-battle', '团队对战', '双人协作，2v2 生存对战', 'team', 'battle', 1, 4],
    ['team-score', '团队抢分', '双人协作，2v2 抢分对战', 'team', 'score', 1, 4],
  ] as const;
  const upsert = instance.prepare(`INSERT INTO ladders
    (slug,name,description,kind,mode,teams,players_per_match,config_json,active,created_at)
    VALUES (?,?,?,?,?,?,?,?,1,?) ON CONFLICT(slug) DO UPDATE SET
    name=excluded.name,description=excluded.description,kind=excluded.kind,mode=excluded.mode,
    teams=excluded.teams,players_per_match=excluded.players_per_match,config_json=excluded.config_json`);
  const entry = instance.prepare(`INSERT INTO ladder_entries
    (ladder_id,entrant_type,builtin,lineup_json,joined_at,updated_at)
    VALUES (?,'builtin',?,?,?,?) ON CONFLICT DO NOTHING`);
  for (const [slug, name, description, kind, mode, teams, players] of presets) {
    const configJson = JSON.stringify({ mode, teams: !!teams, width: mode === 'solo' ? 24 : 28,
      height: mode === 'solo' ? 16 : 20, wrap: mode === 'score', foodCount: mode === 'solo' ? 1 : 4,
      maxTicks: mode === 'solo' ? 1500 : mode === 'score' ? 500 : 1000,
      targetScore: null, seed: 1, moveTimeoutMs: 50, initTimeoutMs: 500, memoryLimitMB: 32, matchCpuBudgetMs: 30000 });
    upsert.run(slug, name, description, kind, mode, teams, players, configJson, now);
    const ladder = instance.prepare('SELECT id FROM ladders WHERE slug=?').get(slug) as { id: number };
    if (kind === 'team') entry.run(ladder.id, 'house', '["builtin:greedy","builtin:coward"]', now, now);
    else for (const bot of ['greedy', 'coward', 'random']) entry.run(ladder.id, bot, null, now, now);
  }
}

export function createUser(username: string, passwordHash: string): UserRow {
  const info = getDb().prepare('INSERT INTO users (username,password_hash,created_at) VALUES (?,?,?)')
    .run(username, passwordHash, Date.now());
  return getUserById(Number(info.lastInsertRowid))!;
}

export function getUserById(id: number): UserRow | undefined {
  return getDb().prepare('SELECT * FROM users WHERE id=?').get(id) as UserRow | undefined;
}

export function getUserByName(username: string): UserRow | undefined {
  return getDb().prepare('SELECT * FROM users WHERE lower(username)=lower(?)').get(username) as UserRow | undefined;
}

export function getAgentById(id: number): AgentRow | undefined {
  return getDb().prepare('SELECT * FROM agents WHERE id=?').get(id) as AgentRow | undefined;
}

export function getAgentByPlatformKey(key: string): AgentRow | undefined {
  if (!key.startsWith('agk_')) return undefined;
  return getDb().prepare('SELECT * FROM agents WHERE api_key_hash=? AND disabled=0').get(hashAgentKey(key)) as AgentRow | undefined;
}
