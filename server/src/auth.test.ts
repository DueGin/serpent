import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Request } from 'express';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { hashPassword, signToken, verifyPassword, verifyToken } from './auth';
import { hashAgentKey } from './crypto';
import { createUser, getDb, getUserByName, openDatabase, setDb } from './db';
import { AppError } from './http';
import * as agents from './services/agents';
import * as teams from './services/teams';
import { mustOwnAgent, ownsAgent, principalFromAgentKey, principalFromRequest, resolveAgent, type Principal } from './services/principal';

const errorCode = (code: string) => (error: unknown): boolean => error instanceof AppError && error.code === code;
const request = (headers: Record<string, string> = {}) => ({ headers }) as Request;

function freshUser(username = 'captain'): Principal {
  const user = createUser(username, hashPassword('secret123'));
  return { kind: 'user', userId: user.id };
}

function insertScript(agentId: number, name = 'test-script'): number {
  const now = Date.now();
  return Number(getDb().prepare(`INSERT INTO scripts(agent_id,name,created_at,updated_at) VALUES (?,?,?,?)`)
    .run(agentId, name, now, now).lastInsertRowid);
}

function insertEntry(agentId: number, scriptId: number): number {
  return Number(getDb().prepare(`INSERT INTO ladder_entries
    (ladder_id,entrant_type,script_id,agent_id,joined_at,updated_at)
    VALUES ((SELECT id FROM ladders WHERE slug='battle'),'script',?,?,?,?)`)
    .run(scriptId, agentId, Date.now(), Date.now()).lastInsertRowid);
}

describe('password and jwt', () => {
  it('hashes passwords and signs jwt', () => {
    const hash = hashPassword('secret1');
    assert.equal(verifyPassword('secret1', hash), true);
    assert.equal(verifyPassword('nope', hash), false);
    const payload = verifyToken(signToken({ id: 7, username: 'neo' }));
    assert.equal(payload.userId, 7);
    assert.equal(payload.username, 'neo');
    assert.throws(() => verifyToken('invalid-token'));
  });
});

describe('database migrations', () => {
  it('preserves users and legacy bindings, creates indexed arena schema, and seeds idempotently', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'serpent-migration-'));
    const file = path.join(directory, 'old.db');
    try {
      const legacy = new Database(file);
      legacy.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT UNIQUE,password_hash TEXT,created_at INTEGER);
        INSERT INTO users VALUES (42,'legacy','password-hash',100);
        CREATE TABLE agents(id INTEGER PRIMARY KEY,user_id INTEGER,name TEXT,base_url TEXT,api_key TEXT,system_prompt TEXT);
        CREATE INDEX idx_agents_user ON agents(user_id);
        INSERT INTO agents VALUES (9,42,'old-agent','https://example.test','enc1:legacy-secret','old prompt');`);
      legacy.close();
      const migrated = openDatabase(file);
      assert.equal(migrated.pragma('user_version', { simple: true }), 3);
      const matchColumns = migrated.pragma('table_info(matches)') as Array<{ name: string; type: string }>;
      assert.ok(matchColumns.some(column => column.name === 'trace_blob' && column.type === 'BLOB'));
      assert.equal((migrated.prepare('SELECT username FROM users WHERE id=42').get() as { username: string }).username, 'legacy');
      assert.equal((migrated.prepare('SELECT name FROM agents_legacy WHERE id=9').get() as { name: string }).name, 'old-agent');
      const agentColumns = migrated.pragma('table_info(agents)') as Array<{ name: string }>;
      assert.deepEqual(agentColumns.map((column) => column.name).filter((name) => name.includes('key')),
        ['api_key_hash', 'api_key_prefix']);
      assert.equal((migrated.prepare('SELECT COUNT(*) AS count FROM agents').get() as { count: number }).count, 0);
      assert.equal((migrated.prepare('SELECT COUNT(*) AS count FROM ladders').get() as { count: number }).count, 5);
      assert.equal((migrated.prepare('SELECT COUNT(*) AS count FROM ladder_entries').get() as { count: number }).count, 11);
      assert.equal((migrated.prepare("SELECT lineup_json FROM ladder_entries WHERE builtin='house' LIMIT 1").get() as { lineup_json: string }).lineup_json,
        '["builtin:greedy","builtin:coward"]');
      assert.equal(migrated.pragma('foreign_keys', { simple: true }), 1);
      assert.ok(migrated.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_participants_script'").get());
      migrated.close();
      const reopened = openDatabase(file);
      assert.equal((reopened.prepare('SELECT COUNT(*) AS count FROM ladder_entries').get() as { count: number }).count, 11);
      reopened.close();
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it('upgrades existing v1 entries and pauses teams until their captain reauthorizes', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'serpent-migration-v2-'));
    const file = path.join(directory, 'arena.db');
    try {
      const old = openDatabase(file);
      old.exec(`ALTER TABLE ladder_entries DROP COLUMN authorized_user_id;
        ALTER TABLE ladder_entries DROP COLUMN authorized_agent_id;
        ALTER TABLE ladder_entries DROP COLUMN inactive_reason;
        ALTER TABLE matches DROP COLUMN trace_blob;
        PRAGMA user_version=1;
        INSERT INTO users VALUES(1,'owner','hash',0);
        INSERT INTO agents(id,user_id,name,api_key_hash,api_key_prefix,created_at,updated_at)
          VALUES(1,1,'captain','${'a'.repeat(64)}','agk_fixture',0,0);
        INSERT INTO teams(id,name,captain_agent_id,invite_code,created_at) VALUES(1,'old-team',1,'invite',0);
        INSERT INTO ladder_entries(ladder_id,entrant_type,team_id,lineup_json,joined_at,updated_at)
          SELECT id,'team',1,'[1,2]',0,0 FROM ladders WHERE slug='team-battle';`);
      old.close();
      const migrated = openDatabase(file);
      const entry = migrated.prepare("SELECT active,inactive_reason,authorized_user_id FROM ladder_entries WHERE entrant_type='team'").get() as
        { active: number; inactive_reason: string; authorized_user_id: number | null };
      assert.equal(migrated.pragma('user_version', { simple: true }), 3);
      assert.equal(entry.active, 0);
      assert.match(entry.inactive_reason, /重新确认/);
      assert.equal(entry.authorized_user_id, null);
      assert.equal((migrated.prepare("SELECT count(*) AS n FROM ladder_entries WHERE entrant_type='builtin' AND active=1").get() as { n: number }).n, 11);
      migrated.close();
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it('adds nullable telemetry to v2 matches without changing replay data', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'serpent-migration-v3-'));
    const file = path.join(directory, 'arena.db');
    try {
      const old = openDatabase(file);
      old.exec('ALTER TABLE matches DROP COLUMN trace_blob; PRAGMA user_version=2;');
      const replay = Buffer.from('历史回放');
      old.prepare(`INSERT INTO matches(kind,mode,status,seed,config_json,replay_blob,created_at)
        VALUES('test','solo','done',1,'{}',?,0)`).run(replay);
      old.close();
      const migrated = openDatabase(file);
      assert.equal(migrated.pragma('user_version', { simple: true }), 3);
      const row = migrated.prepare('SELECT replay_blob,trace_blob FROM matches').get() as { replay_blob: Buffer; trace_blob: Buffer | null };
      assert.deepEqual(row.replay_blob, replay);
      assert.equal(row.trace_blob, null);
      migrated.close();
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});

describe('agent identities and principals', () => {
  beforeEach(() => setDb(openDatabase(':memory:')));
  afterEach(() => getDb().close());

  it('creates one-time keys and stores only hashes; prefixes are private', async () => {
    const user = freshUser();
    const created = await agents.create(user, { name: 'Strategy One', modelLabel: 'model-x', description: 'Snake strategist' });
    assert.match(created.apiKey, /^agk_[0-9a-f]{64}$/);
    assert.equal(created.keyPrefix, created.apiKey.slice(0, 12));
    assert.equal(created.stats.scripts, 0);
    const stored = getDb().prepare('SELECT * FROM agents WHERE id=?').get(created.id) as Record<string, unknown>;
    assert.equal(stored.api_key_hash, hashAgentKey(created.apiKey));
    assert.equal(JSON.stringify(stored).includes(created.apiKey), false);
    assert.equal(stored.api_key_prefix, created.apiKey.slice(0, 12));
    assert.equal(getUserByName('CAPTAIN')?.id, user.userId);
    const mine = await agents.listMine(user);
    assert.equal(mine[0]?.keyPrefix, created.apiKey.slice(0, 12));
    assert.equal('apiKey' in mine[0]!, false);
    const publicAgent = (await agents.directory())[0]!;
    assert.equal('keyPrefix' in publicAgent, false);
    assert.equal('apiKey' in publicAgent, false);
    assert.equal(publicAgent.ownerName, 'captain');
    await assert.rejects(() => agents.create(user, { name: 'strategy ONE' }), errorCode('CONFLICT'));
  });

  it('accepts JWT and both key headers, rejects invalid credentials and rotation revokes old keys', async () => {
    const p = freshUser();
    const created = await agents.create(p, { name: 'Keyed' });
    const agent: Principal = { kind: 'agent', userId: p.userId, agentId: created.id };
    assert.equal(await principalFromRequest(request()), null);
    assert.deepEqual(await principalFromAgentKey(created.apiKey), agent);
    assert.deepEqual(await principalFromRequest(request({ 'x-agent-api-key': created.apiKey })), agent);
    assert.deepEqual(await principalFromRequest(request({ authorization: `Bearer ${created.apiKey}` })), agent);
    assert.deepEqual(await principalFromRequest(request({ authorization: `Bearer ${signToken({ id: p.userId, username: 'captain' })}` })), p);
    assert.ok((await agents.getMe(agent)).lastSeenAt);
    await assert.rejects(() => principalFromAgentKey('agk_invalid'), errorCode('UNAUTHORIZED'));
    await assert.rejects(() => principalFromAgentKey(`agk_${'a'.repeat(65536)}`), errorCode('UNAUTHORIZED'));
    await assert.rejects(() => principalFromRequest(request({ authorization: 'invalid' })), errorCode('UNAUTHORIZED'));
    await assert.rejects(() => principalFromRequest(request({ authorization: 'Bearer broken-jwt' })), errorCode('UNAUTHORIZED'));
    await assert.rejects(() => principalFromRequest(request({ 'x-agent-api-key': '' })), errorCode('UNAUTHORIZED'));
    const rotated = await agents.rotateKey(p, created.id);
    assert.notEqual(created.apiKey, rotated.apiKey);
    await assert.rejects(() => principalFromAgentKey(created.apiKey), errorCode('UNAUTHORIZED'));
    assert.deepEqual(await principalFromAgentKey(rotated.apiKey), agent);
    assert.equal((await agents.getMe(agent)).keyPrefix, rotated.apiKey.slice(0, 12));
  });

  it('requires explicit agentId for user actions and denies sibling/foreign agent access', async () => {
    const owner = freshUser();
    const stranger = freshUser('stranger');
    const first = await agents.create(owner, { name: 'first' });
    const second = await agents.create(owner, { name: 'second' });
    const a: Principal = { kind: 'agent', agentId: first.id, userId: owner.userId };
    assert.equal(resolveAgent(a).id, first.id);
    assert.equal(resolveAgent(owner, second.id).id, second.id);
    assert.equal(ownsAgent(null, first.id), false);
    assert.equal(ownsAgent(owner, second.id), true);
    assert.equal(ownsAgent(a, second.id), false);
    assert.equal(ownsAgent(stranger, first.id), false);
    assert.throws(() => resolveAgent(owner), errorCode('VALIDATION_ERROR'));
    assert.throws(() => resolveAgent(a, second.id), errorCode('FORBIDDEN'));
    assert.throws(() => mustOwnAgent(stranger, first.id), errorCode('FORBIDDEN'));
    await assert.rejects(() => agents.getMe(owner), errorCode('FORBIDDEN'));
    await assert.rejects(() => agents.listMine(a), errorCode('FORBIDDEN'));
    await assert.rejects(() => agents.create(a, { name: 'forbidden' }), errorCode('FORBIDDEN'));
    await assert.rejects(() => agents.update(stranger, first.id, { name: 'stolen' }), errorCode('FORBIDDEN'));
    await assert.rejects(() => agents.rotateKey(stranger, first.id), errorCode('FORBIDDEN'));
    await assert.rejects(() => agents.remove(stranger, first.id), errorCode('FORBIDDEN'));
    const updated = await agents.update(owner, first.id, { name: 'renamed', description: 'new', color: '#ff0011' });
    assert.equal(updated.name, 'renamed');
    assert.equal(updated.color, '#ff0011');
    await assert.rejects(() => agents.update(owner, first.id, { color: 'red' }), errorCode('VALIDATION_ERROR'));
  });

  it('soft deletes agents, archives scripts, stops entries and revokes all access', async () => {
    const p = freshUser();
    const agent = await agents.create(p, { name: 'retired' });
    const scriptId = insertScript(agent.id);
    const entryId = insertEntry(agent.id, scriptId);
    assert.deepEqual(await agents.remove(p, agent.id), { ok: true });
    assert.equal((getDb().prepare('SELECT disabled FROM agents WHERE id=?').get(agent.id) as { disabled: number }).disabled, 1);
    assert.equal((getDb().prepare('SELECT archived FROM scripts WHERE id=?').get(scriptId) as { archived: number }).archived, 1);
    assert.equal((getDb().prepare('SELECT active FROM ladder_entries WHERE id=?').get(entryId) as { active: number }).active, 0);
    await assert.rejects(() => principalFromAgentKey(agent.apiKey), errorCode('UNAUTHORIZED'));
    assert.equal(ownsAgent(p, agent.id), false);
    assert.equal((await agents.listMine(p)).length, 0);
    assert.equal((await agents.directory()).length, 0);
  });

  it('profiles expose only public script metadata and aggregate finished match results', async () => {
    const p = freshUser();
    const agent = await agents.create(p, { name: 'Profiled' });
    const listed = insertScript(agent.id, 'listed-script');
    const open = insertScript(agent.id, 'open-script');
    const hidden = insertScript(agent.id, 'secret-script');
    getDb().prepare("UPDATE scripts SET visibility='open' WHERE id=?").run(open);
    getDb().prepare("UPDATE scripts SET visibility='private' WHERE id=?").run(hidden);
    const entryId = insertEntry(agent.id, listed);
    getDb().prepare('UPDATE ladder_entries SET rating=1350,games=4,wins=2 WHERE id=?').run(entryId);
    for (const [status, rank, score, errors, timeouts] of [['done', 1, 30, 1, 0], ['done', 2, 10, 0, 2], ['error', 1, 900, 30, 10]] as const) {
      const match = getDb().prepare(`INSERT INTO matches(kind,mode,status,seed,config_json,created_at,finished_at)
        VALUES ('exhibition','battle',?,1,'{}',?,?)`).run(status, Date.now(), Date.now());
      getDb().prepare(`INSERT INTO match_participants(match_id,slot,name,color,agent_id,script_id,rank,score,errors,timeouts,moves,avg_move_ms,first_error,logs_json)
        VALUES (?,0,'Profiled','#edc748',?,?,?,?,?,?,100,2,'private-error','[{"tick":0,"text":"private-log"}]')`)
        .run(match.lastInsertRowid, agent.id, listed, rank, score, errors, timeouts);
    }
    const profile = await agents.profile(agent.id);
    assert.deepEqual(profile.scripts.map((script) => script.id).sort((a, b) => a - b), [listed, open]);
    assert.equal(profile.agent.keyPrefix, undefined);
    assert.deepEqual(profile.agent.stats, { scripts: 3, matches: 2, wins: 1 });
    assert.deepEqual(profile.stats, { matches: 2, wins: 1, winRate: 0.5, avgScore: 20, avgMoveMs: 2, errors: 1, timeouts: 2, moves: 200 });
    assert.equal(profile.ladders[0]?.slug, 'battle');
    assert.equal(profile.ladders[0]?.bestRating, 1350);
    assert.equal(profile.ladders[0]?.bestRank, 1);
    assert.equal(profile.ladders[0]?.entries, 1);
    assert.equal(profile.recentMatches.length, 3);
    assert.equal(JSON.stringify(profile).includes('private-log'), false);
    assert.equal(JSON.stringify(profile).includes('private-error'), false);
    assert.equal(JSON.stringify(profile).includes('secret-script'), false);
  });

  it('applies metadata when disabling through PATCH and enforces database constraints', async () => {
    const p = freshUser();
    const agent = await agents.create(p, { name: 'Old' });
    const scriptId = insertScript(agent.id);
    insertEntry(agent.id, scriptId);
    assert.throws(() => insertEntry(agent.id, scriptId), /UNIQUE constraint/);
    assert.throws(() => getDb().prepare("UPDATE scripts SET visibility='invalid' WHERE id=?").run(scriptId), /CHECK constraint/);
    assert.throws(() => getDb().prepare('UPDATE scripts SET agent_id=999 WHERE id=?').run(scriptId), /FOREIGN KEY constraint/);
    const updated = await agents.update(p, agent.id, { name: 'Disabled', disabled: true });
    assert.equal(updated.name, 'Disabled');
    assert.equal(updated.stats.scripts, 0);
    assert.equal(updated.keyPrefix, undefined);
    await assert.rejects(() => agents.getMe({ kind: 'agent', agentId: agent.id, userId: p.userId }), errorCode('NOT_FOUND'));
  });
});

describe('teams', () => {
  beforeEach(() => setDb(openDatabase(':memory:')));
  afterEach(() => getDb().close());

  it('enforces one team per Agent, invite visibility and captain permissions across users', async () => {
    const user = freshUser();
    const otherUser = freshUser('other');
    const captain = await agents.create(user, { name: 'Captain' });
    const member = await agents.create(otherUser, { name: 'Member' });
    const cp: Principal = { kind: 'agent', agentId: captain.id, userId: user.userId };
    const mp: Principal = { kind: 'agent', agentId: member.id, userId: otherUser.userId };
    const team = await teams.create(cp, { name: 'Team One', tag: 'ONE' });
    assert.equal(team.members[0]?.role, 'captain');
    assert.ok(team.inviteCode);
    assert.equal((await agents.getMe(cp)).team?.id, team.id);
    assert.equal('inviteCode' in await teams.get(null, team.id), false);
    assert.equal('inviteCode' in await teams.get(otherUser, team.id), false);
    assert.equal((await teams.get(user, team.id)).inviteCode, team.inviteCode);
    await assert.rejects(() => teams.join(mp, { inviteCode: 'missing' }), errorCode('NOT_FOUND'));
    await assert.rejects(() => teams.create(user, { agentId: captain.id, name: 'Another' }), errorCode('CONFLICT'));
    const joined = await teams.join(mp, { inviteCode: team.inviteCode! });
    assert.equal(joined.members.length, 2);
    assert.equal(joined.inviteCode, team.inviteCode);
    await assert.rejects(() => teams.join(mp, { inviteCode: team.inviteCode! }), errorCode('CONFLICT'));
    await assert.rejects(() => teams.update(mp, team.id, { name: 'No' }), errorCode('FORBIDDEN'));
    await assert.rejects(() => teams.kick(mp, team.id, captain.id), errorCode('FORBIDDEN'));
    await assert.rejects(() => teams.rotateInvite(mp, team.id), errorCode('FORBIDDEN'));
    assert.equal((await teams.update(user, team.id, { description: 'yes' })).description, 'yes');
    const rotated = await teams.rotateInvite(cp, team.id);
    assert.notEqual(rotated.inviteCode, team.inviteCode);
    assert.equal((await teams.list())[0]?.inviteCode, undefined);
    const kicked = await teams.kick(cp, team.id, member.id);
    assert.equal(kicked.members.length, 1);
    assert.equal('inviteCode' in await teams.get(mp, team.id), false);
    await assert.rejects(() => teams.kick(cp, team.id, captain.id), errorCode('CONFLICT'));
    await assert.rejects(() => teams.join(mp, { inviteCode: team.inviteCode! }), errorCode('NOT_FOUND'));
    await teams.join(otherUser, { agentId: member.id, inviteCode: rotated.inviteCode });
    assert.equal((await teams.get(mp, team.id)).members.length, 2);
  });

  it('transfers captain on leave, pauses affected lineups, and disbands empty teams', async () => {
    const user = freshUser();
    const captain = await agents.create(user, { name: 'Leader' });
    const member = await agents.create(user, { name: 'Successor' });
    const team = await teams.create(user, { agentId: captain.id, name: 'Lineup' });
    await teams.join(user, { agentId: member.id, inviteCode: team.inviteCode! });
    const scriptA = insertScript(captain.id, 'a');
    const scriptB = insertScript(member.id, 'b');
    const info = getDb().prepare(`INSERT INTO ladder_entries
      (ladder_id,entrant_type,team_id,lineup_json,joined_at,updated_at)
      VALUES ((SELECT id FROM ladders WHERE slug='team-battle'),'team',?,?,?,?)`)
      .run(team.id, JSON.stringify([scriptA, scriptB]), Date.now(), Date.now());
    await teams.leave(user, team.id, { agentId: captain.id });
    const active = getDb().prepare('SELECT active FROM ladder_entries WHERE id=?').get(info.lastInsertRowid) as { active: number };
    assert.equal(active.active, 0);
    const teamRow = getDb().prepare('SELECT captain_agent_id FROM teams WHERE id=?').get(team.id) as { captain_agent_id: number };
    assert.equal(teamRow.captain_agent_id, member.id);
    assert.equal((getDb().prepare('SELECT role FROM team_members WHERE agent_id=?').get(member.id) as { role: string }).role, 'captain');
    await assert.rejects(() => teams.update({ kind: 'agent', agentId: captain.id, userId: user.userId }, team.id, { tag: 'NO' }), errorCode('FORBIDDEN'));
    await agents.remove(user, member.id);
    assert.equal((getDb().prepare('SELECT disbanded FROM teams WHERE id=?').get(team.id) as { disbanded: number }).disbanded, 1);
    await assert.rejects(() => teams.get(null, team.id), errorCode('NOT_FOUND'));
    assert.equal((await teams.list()).length, 0);
  });
});
