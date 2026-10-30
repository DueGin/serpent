import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type Database from 'better-sqlite3';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { createUser, getDb, openDatabase, setDb } from './db';
import { AppError } from './http';
import { arenaEvents } from './realtime';
import { defaultConfig, shutdownRunner } from './runner';
import { PLAYBACK_TICK_MS, type Replay } from './types';
import * as agents from './services/agents';
import * as matches from './services/matches';
import type { Principal } from './services/principal';

process.env.LADDER_AUTO = '0';
const hasCode = (code: string) => (error: unknown): boolean => error instanceof AppError && error.code === code;

function user(name: string): Principal {
  const row = createUser(name, 'test-password-hash');
  return { kind: 'user', userId: row.id };
}

function insertScript(agentId: number, options: {
  name?: string; visibility?: 'private' | 'listed' | 'open'; code?: string; status?: string;
} = {}): { scriptId: number; versionId: number } {
  const db = getDb();
  const now = Date.now();
  const scriptId = Number(db.prepare(`INSERT INTO scripts
    (agent_id,name,visibility,created_at,updated_at) VALUES (?,?,?,?,?)`)
    .run(agentId, options.name ?? 'strategy', options.visibility ?? 'listed', now, now).lastInsertRowid);
  const code = options.code ?? 'function move(s) { console.log("private-log", s.tick); return s.you.dir; }';
  const versionId = Number(db.prepare(`INSERT INTO script_versions
    (script_id,version,code,code_hash,size,status,created_at) VALUES (?,1,?,?,?,?,?)`)
    .run(scriptId, code, createHash('sha256').update(code).digest('hex'), Buffer.byteLength(code), options.status ?? 'valid', now).lastInsertRowid);
  db.prepare('UPDATE scripts SET active_version_id=?,latest_version_id=? WHERE id=?').run(versionId, versionId, scriptId);
  return { scriptId, versionId };
}

describe('match services', { concurrency: false }, () => {
  let db: Database.Database;
  beforeEach(() => { db = openDatabase(':memory:'); setDb(db); });
  afterEach(async () => { await matches.waitPendingMatches(); db.close(); });
  after(async () => { await shutdownRunner(); });

  it('persists immutable participant versions and gzip replay; exposes private logs only to owners', async () => {
    const owner = user('owner');
    const outsider = user('outsider');
    const agent = await agents.create(owner, { name: 'Owned Agent' });
    const sibling = await agents.create(owner, { name: 'Sibling Agent' });
    const script = insertScript(agent.id, {
      code: 'function move(s) { console.log("owner-secret", s.tick); throw new Error("owner-error"); }',
      visibility: 'private',
    });
    const publicEvents: unknown[] = [];
    const listener = (event: unknown) => publicEvents.push(event);
    arenaEvents.on('match:finished', listener);
    let match;
    try {
      match = await matches.create(owner, { kind: 'test', agentId: agent.id, mode: 'solo',
        participants: [{ scriptId: script.scriptId }], maxTicks: 4, seed: 123, wait: true });
    } finally { arenaEvents.off('match:finished', listener); }
    assert.equal(publicEvents.length, 0);
    assert.equal(match.status, 'done');
    assert.equal(match.ticks, 4);
    assert.equal(match.seed, 123);
    assert.equal(match.broadcastAt, null);
    assert.equal(match.live, false);
    assert.equal(match.participants[0]?.version, 1);
    assert.equal(match.participants[0]?.errors, 4);
    assert.match(match.participants[0]?.firstError ?? '', /owner-error/);
    assert.match(JSON.stringify(match.participants[0]?.logs), /owner-secret/);
    assert.ok((match.durationMs ?? 0) >= 0);
    const row = db.prepare('SELECT * FROM matches WHERE id=?').get(match.id) as { replay_blob: Buffer; duration_ms: number };
    assert.equal(Buffer.isBuffer(row.replay_blob), true);
    assert.equal(row.replay_blob.subarray(0, 2).toString('hex'), '1f8b');
    const stored = JSON.parse(gunzipSync(row.replay_blob).toString('utf8')) as Replay;
    assert.equal(stored.moves.length, match.ticks);
    const participant = db.prepare('SELECT version_id,moves,cpu_ms FROM match_participants WHERE match_id=?').get(match.id) as { version_id: number; moves: number; cpu_ms: number };
    assert.equal(participant.version_id, script.versionId);
    assert.equal(participant.moves, 4);
    assert.ok(participant.cpu_ms >= 0);
    for (const principal of [null, outsider, { kind: 'agent', userId: owner.userId, agentId: sibling.id } as Principal]) {
      const publicResult = await matches.get(principal, match.id);
      assert.equal('logs' in publicResult.participants[0]!, false);
      assert.equal('firstError' in publicResult.participants[0]!, false);
    }
    const agentResult = await matches.get({ kind: 'agent', userId: owner.userId, agentId: agent.id }, match.id);
    assert.equal(agentResult.participants[0]?.logs?.length, 4);
    assert.equal((await matches.list(null)).length, 0);
    assert.equal((await matches.list(outsider)).length, 0);
    assert.equal((await matches.list(owner, { kind: 'test', agentId: agent.id }))[0]?.id, match.id);
    assert.equal((await matches.live()).length, 0);
  });

  it('returns deterministic replay frames and validates frame viewer/tick boundaries', async () => {
    const owner = user('owner');
    const agent = await agents.create(owner, { name: 'Deterministic Agent' });
    const script = insertScript(agent.id);
    const input = { kind: 'test' as const, mode: 'solo' as const, agentId: agent.id,
      participants: [{ scriptId: script.scriptId }], maxTicks: 6, seed: 321, wait: true };
    const one = await matches.create(owner, input);
    const two = await matches.create(owner, input);
    const replayOne = await matches.replay(one.id);
    const replayTwo = await matches.replay(two.id);
    assert.deepEqual(replayOne.frames, replayTwo.frames);
    assert.equal(replayOne.frames.length, one.ticks + 1);
    assert.equal(replayOne.frames[0]?.tick, 0);
    assert.equal(replayOne.tickMs, PLAYBACK_TICK_MS);
    const frame = await matches.frame(null, one.id, 3);
    assert.equal(frame.state.tick, 3);
    assert.equal(frame.state.you.slot, 0);
    assert.equal(frame.state.protocol, 'serpent-script-v1');
    assert.match(frame.ascii, /H/);
    await assert.rejects(matches.frame(null, one.id, -1), hasCode('VALIDATION_ERROR'));
    await assert.rejects(matches.frame(null, one.id, one.ticks + 1), hasCode('VALIDATION_ERROR'));
    await assert.rejects(matches.frame(null, one.id, 1.1), hasCode('VALIDATION_ERROR'));
    await assert.rejects(matches.frame(null, one.id, 0, 1), hasCode('VALIDATION_ERROR'));
    await assert.rejects(matches.get(null, 999999), hasCode('NOT_FOUND'));
  });

  it('keeps the selected version snapshot when the active version changes during simulation', async () => {
    const owner = user('owner');
    const agent = await agents.create(owner, { name: 'Versioned Agent' });
    const script = insertScript(agent.id);
    const created = await matches.create(owner, { kind: 'test', mode: 'solo', agentId: agent.id,
      participants: [{ scriptId: script.scriptId }], maxTicks: 3 });
    const code = 'function move(s) { return "up"; }';
    const newVersion = Number(db.prepare(`INSERT INTO script_versions
      (script_id,version,code,code_hash,size,status,created_at) VALUES (?,2,?,?,?,'valid',?)`)
      .run(script.scriptId, code, createHash('sha256').update(code).digest('hex'), Buffer.byteLength(code), Date.now()).lastInsertRowid);
    db.prepare('UPDATE scripts SET active_version_id=?,latest_version_id=? WHERE id=?').run(newVersion, newVersion, script.scriptId);
    await matches.waitPendingMatches(db);
    const result = await matches.get(owner, created.id);
    assert.equal(result.status, 'done');
    assert.equal(result.participants[0]?.version, 1);
    assert.match(JSON.stringify(result.participants[0]?.logs), /private-log/);
    const stored = db.prepare('SELECT version_id FROM match_participants WHERE match_id=?').get(created.id) as { version_id: number };
    assert.equal(stored.version_id, script.versionId);
    const selected = await matches.create(owner, { kind: 'test', mode: 'solo', agentId: agent.id,
      participants: [{ scriptId: script.scriptId, version: 2 }], maxTicks: 3, wait: true });
    assert.equal(selected.participants[0]?.version, 2);
    assert.deepEqual(selected.participants[0]?.logs, []);
  });

  it('enforces test identity, visibility, archived/disabled and valid-version boundaries', async () => {
    const owner = user('owner'), outsider = user('outsider');
    const agent = await agents.create(owner, { name: 'Owner Agent' });
    const other = await agents.create(outsider, { name: 'Other Agent' });
    const own = insertScript(agent.id);
    const privateScript = insertScript(other.id, { name: 'private', visibility: 'private' });
    const listed = insertScript(other.id, { name: 'listed' });
    const invalid = insertScript(agent.id, { name: 'invalid', status: 'invalid' });
    const base = { kind: 'test' as const, agentId: agent.id, mode: 'battle' as const,
      participants: [{ scriptId: own.scriptId }, { builtin: 'greedy' as const }], maxTicks: 3, wait: true };
    await assert.rejects(matches.create(owner, { ...base, agentId: undefined }), hasCode('VALIDATION_ERROR'));
    await assert.rejects(matches.create(outsider, base), hasCode('FORBIDDEN'));
    await assert.rejects(matches.create(owner, { ...base, participants: [{ builtin: 'greedy' }, { scriptId: listed.scriptId }] }), hasCode('FORBIDDEN'));
    await assert.rejects(matches.create(owner, { ...base, participants: [{ scriptId: own.scriptId }, { scriptId: privateScript.scriptId }] }), hasCode('FORBIDDEN'));
    await assert.rejects(matches.create(owner, { ...base, participants: [{ scriptId: invalid.scriptId }, { builtin: 'greedy' }] }), hasCode('VALIDATION_ERROR'));
    await assert.rejects(matches.create(owner, { ...base, participants: [{ scriptId: own.scriptId, version: 99 }, { builtin: 'greedy' }] }), hasCode('NOT_FOUND'));
    const allowed = await matches.create(owner, { ...base, participants: [{ scriptId: own.scriptId }, { scriptId: listed.scriptId }] });
    assert.equal(allowed.status, 'done');
    assert.equal('logs' in allowed.participants[1]!, false);
    db.prepare('UPDATE scripts SET archived=1 WHERE id=?').run(own.scriptId);
    await assert.rejects(matches.create(owner, base), hasCode('NOT_FOUND'));
    db.prepare('UPDATE scripts SET archived=0 WHERE id=?').run(own.scriptId);
    db.prepare('UPDATE agents SET disabled=1 WHERE id=?').run(other.id);
    await assert.rejects(matches.create(owner, { ...base, participants: [{ scriptId: own.scriptId }, { scriptId: listed.scriptId }] }), hasCode('NOT_FOUND'));
  });

  it('validates player counts and fixed 2v2 slot assignments', async () => {
    const owner = user('owner');
    const duo = [{ builtin: 'greedy' as const }, { builtin: 'coward' as const }];
    const four = [...duo, ...duo];
    await assert.rejects(matches.create(owner, { kind: 'exhibition', mode: 'solo', participants: duo }), hasCode('VALIDATION_ERROR'));
    await assert.rejects(matches.create(owner, { kind: 'exhibition', mode: 'battle', participants: duo.slice(0, 1) }), hasCode('VALIDATION_ERROR'));
    await assert.rejects(matches.create(owner, { kind: 'exhibition', mode: 'solo', teams: true, participants: four }), hasCode('VALIDATION_ERROR'));
    await assert.rejects(matches.create(owner, { kind: 'exhibition', mode: 'battle', teams: true, participants: duo }), hasCode('VALIDATION_ERROR'));
    await assert.rejects(matches.create(owner, { kind: 'exhibition', mode: 'battle', teams: true,
      participants: [{ builtin: 'greedy', team: 1 }, ...four.slice(1)] }), hasCode('VALIDATION_ERROR'));
    await assert.rejects(matches.create(owner, { kind: 'exhibition', mode: 'battle', participants: duo, seed: -1 }), hasCode('VALIDATION_ERROR'));
    await assert.rejects(matches.create(owner, { kind: 'exhibition', mode: 'battle', participants: duo, maxTicks: 0 }), hasCode('VALIDATION_ERROR'));
    const team = await matches.create(owner, { kind: 'exhibition', mode: 'battle', teams: true, participants: four, maxTicks: 2, wait: true });
    assert.equal(team.status, 'done');
    assert.deepEqual(team.participants.map(participant => participant.slot), [0, 1, 2, 3]);
    assert.deepEqual(team.participants.map(participant => participant.team), [0, 1, 0, 1]);
  });

  it('enforces rolling hourly test limits and two concurrent tests per Agent', async () => {
    const owner = user('owner');
    const agent = await agents.create(owner, { name: 'Limited Agent' });
    const script = insertScript(agent.id);
    const input = { kind: 'test' as const, mode: 'solo' as const, agentId: agent.id,
      participants: [{ scriptId: script.scriptId }], maxTicks: 4 };
    const one = await matches.create(owner, input), two = await matches.create(owner, input);
    assert.equal(matches.activeMatchCount(db), 2);
    await assert.rejects(matches.create(owner, input), hasCode('LIMIT_EXCEEDED'));
    await matches.waitPendingMatches(db);
    assert.equal(matches.activeMatchCount(db), 0);
    assert.equal((await matches.get(owner, one.id)).status, 'done');
    assert.equal((await matches.get(owner, two.id)).status, 'done');
    const insert = db.prepare(`INSERT INTO matches(kind,mode,teams,status,seed,config_json,
      created_by_user_id,created_by_agent_id,created_at) VALUES ('test','solo',0,'done',1,?,?,?,?)`);
    db.transaction(() => {
      for (let index = 0; index < 58; index++) insert.run(JSON.stringify(defaultConfig('solo')), owner.userId, agent.id, Date.now());
    })();
    await assert.rejects(matches.create(owner, input), hasCode('RATE_LIMITED'));
    db.prepare('UPDATE matches SET created_at=?').run(Date.now() - 3_600_001);
    const resumed = await matches.create(owner, { ...input, wait: true });
    assert.equal(resumed.status, 'done');
  });

  it('calculates public live windows, emits redacted events and filters match lists', async () => {
    const owner = user('owner');
    const agent = await agents.create(owner, { name: 'Broadcast Agent' });
    const script = insertScript(agent.id);
    const events: unknown[] = [];
    const listener = (event: unknown) => events.push(event);
    arenaEvents.on('match:finished', listener);
    let match;
    try {
      match = await matches.create(owner, { kind: 'exhibition', mode: 'solo', seed: 1,
        participants: [{ scriptId: script.scriptId }], maxTicks: 20, wait: true });
    } finally { arenaEvents.off('match:finished', listener); }
    assert.equal(match.status, 'done');
    assert.equal(match.live, true);
    assert.equal(match.playbackMs, match.ticks * PLAYBACK_TICK_MS);
    assert.ok(match.broadcastAt !== null);
    assert.equal(events.length, 1);
    assert.equal(JSON.stringify(events).includes('private-log'), false);
    assert.equal((await matches.live())[0]?.id, match.id);
    assert.equal((await matches.list(null, { scriptId: script.scriptId, limit: 1 }))[0]?.id, match.id);
    assert.equal((await matches.list(null, { before: match.id })).length, 0);
    const stats = await matches.platformStats();
    assert.equal(typeof stats.pythonAvailable, 'boolean');
    assert.deepEqual(stats, { agents: 1, scripts: 1, matches: 1, liveMatches: 1, pythonAvailable: stats.pythonAvailable });
    db.prepare('UPDATE matches SET broadcast_at=? WHERE id=?').run(Date.now() - match.playbackMs - 1, match.id);
    assert.equal((await matches.live()).length, 0);
    assert.equal((await matches.get(null, match.id)).live, false);
  });

  it('finishes pending work against its captured database even after setDb changes', async () => {
    const owner = user('owner');
    const agent = await agents.create(owner, { name: 'Stable Agent' });
    const script = insertScript(agent.id);
    const created = await matches.create(owner, { kind: 'test', mode: 'solo', agentId: agent.id,
      participants: [{ scriptId: script.scriptId }], maxTicks: 3 });
    const alternate = openDatabase(':memory:');
    try {
      setDb(alternate);
      await matches.waitPendingMatches(db);
      assert.equal((db.prepare('SELECT status FROM matches WHERE id=?').get(created.id) as { status: string }).status, 'done');
      assert.equal((alternate.prepare('SELECT count(*) AS total FROM matches').get() as { total: number }).total, 0);
    } finally { setDb(db); alternate.close(); }
  });

  it('converts runner shutdown failures into sanitized terminal match errors', async () => {
    const owner = user('owner');
    const agent = await agents.create(owner, { name: 'Interrupted Agent' });
    const script = insertScript(agent.id, { code: 'function move(s) { while(true) {} }' });
    const created = await matches.create(owner, { kind: 'test', mode: 'solo', agentId: agent.id,
      participants: [{ scriptId: script.scriptId }], maxTicks: 100 });
    await shutdownRunner();
    await matches.waitPendingMatches(db);
    const result = await matches.get(owner, created.id);
    assert.equal(result.status, 'error');
    assert.equal(result.error, '对局执行失败，请稍后重试');
    assert.equal(result.broadcastAt, null);
    assert.equal(matches.activeMatchCount(db), 0);
    await assert.rejects(matches.replay(created.id), hasCode('CONFLICT'));
  });

  it('creates internal immutable ladder matches and records rating changes before completion', async () => {
    const ladder = db.prepare("SELECT id FROM ladders WHERE slug='battle'").get() as { id: number };
    const entries = db.prepare('SELECT id,builtin FROM ladder_entries WHERE ladder_id=? ORDER BY id LIMIT 2')
      .all(ladder.id) as Array<{ id: number; builtin: 'greedy' | 'coward' }>;
    const match = await matches.createInternalMatch({ kind: 'ladder', ladderId: ladder.id,
      config: defaultConfig('battle', { seed: 982, maxTicks: 3, players: 2 }), wait: true,
      participants: entries.map(entry => ({ builtin: entry.builtin, ladderEntryId: entry.id })) });
    assert.equal(match.status, 'done');
    assert.equal(match.seed, 982);
    assert.equal(match.ladderSlug, 'battle');
    assert.ok(match.participants.every(participant => participant.ratingBefore === 1000 && participant.ratingAfter !== null));
    const updated = db.prepare('SELECT games,rating FROM ladder_entries WHERE id=?').get(entries[0]!.id) as { games: number; rating: number };
    assert.equal(updated.games, 1);
    assert.equal(updated.rating, match.participants[0]?.ratingAfter);
    const solo = db.prepare("SELECT id FROM ladders WHERE slug='solo'").get() as { id: number };
    const benchmark = await matches.createInternalMatch({ kind: 'benchmark', ladderId: solo.id,
      config: defaultConfig('solo', { seed: 77, maxTicks: 2 }), participants: [{ builtin: 'greedy' }], wait: true });
    assert.equal(benchmark.status, 'done');
    assert.equal(benchmark.seed, 77);
    assert.equal((await matches.list(null, { ladder: 'solo' }))[0]?.id, benchmark.id);
  });
});
