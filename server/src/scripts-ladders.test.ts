import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { createUser, getDb, openDatabase, setDb } from './db';
import { AppError } from './http';
import { defaultConfig, shutdownRunner } from './runner';
import * as agents from './services/agents';
import * as scripts from './services/scripts';
import * as ladders from './services/ladders';
import * as matches from './services/matches';
import * as teams from './services/teams';
import type { Principal } from './services/principal';

let user: Principal, otherUser: Principal, agent: Principal, otherAgent: Principal;
const code = 'function move(state) { console.log("private debug"); return state.legalMoves[0] || state.you.dir; }';
function rejected(errorCode: string) { return (err: unknown) => err instanceof AppError && err.code === errorCode; }
async function seedScript(p: Principal, name: string, visibility: 'listed' | 'private' | 'open' = 'listed'): Promise<number> {
  assert.equal(p.kind, 'agent');
  const db = getDb(), now = Date.now();
  const result = db.prepare('INSERT INTO scripts(agent_id,name,visibility,created_at,updated_at) VALUES(?,?,?,?,?)').run((p as { agentId: number }).agentId, name, visibility, now, now);
  const id = Number(result.lastInsertRowid);
  const version = db.prepare("INSERT INTO script_versions(script_id,version,code,code_hash,size,status,created_at) VALUES(?,1,?,'fixture',?,'valid',?)").run(id, code, Buffer.byteLength(code), now);
  db.prepare('UPDATE scripts SET active_version_id=?,latest_version_id=? WHERE id=?').run(version.lastInsertRowid, version.lastInsertRowid, id);
  return id;
}
beforeEach(async () => {
  await ladders.waitLadderJobs();
  await matches.waitPendingMatches();
  const db = openDatabase(':memory:');
  setDb(db);
  const a = createUser('owner', 'not-used'), b = createUser('other', 'not-used');
  user = { kind: 'user', userId: a.id }; otherUser = { kind: 'user', userId: b.id };
  const aa = await agents.create(user, { name: 'Alpha' }), bb = await agents.create(otherUser, { name: 'Beta' });
  agent = { kind: 'agent', agentId: aa.id, userId: a.id }; otherAgent = { kind: 'agent', agentId: bb.id, userId: b.id };
});
after(async () => { await ladders.waitLadderJobs(); await matches.waitPendingMatches(); await shutdownRunner(); });

describe('scripts service', () => {
  it('creates checked immutable versions and only activates requested valid code', async () => {
    const script = await scripts.create(agent, { name: 'Checked', code });
    assert.equal(script.activeVersion, 1); assert.equal(script.latestStatus, 'valid');
    const v2 = await scripts.addVersion(agent, script.id, { code: code + '\n//v2', activate: false, note: 'candidate' });
    assert.equal(v2.version, 2); assert.equal((await scripts.get(agent, script.id)).activeVersion, 1);
    const v3 = await scripts.addVersion(agent, script.id, { code: 'function move() { return "invalid"; }' });
    assert.equal(v3.status, 'invalid');
    assert.equal((await scripts.get(agent, script.id)).activeVersion, 1);
    await assert.rejects(scripts.update(agent, script.id, { activeVersion: 3 }), rejected('VALIDATION_ERROR'));
    assert.equal((await scripts.update(agent, script.id, { activeVersion: 2 })).activeVersion, 2);
    assert.equal((await scripts.getVersion(agent, script.id, 1)).code, code);
    assert.equal((await scripts.get(agent, script.id)).latestVersion, 3);
    await assert.rejects(scripts.create(agent, { name: 'Checked', code }), rejected('CONFLICT'));
    await assert.rejects(scripts.create(agent, { name: '', code }), rejected('VALIDATION_ERROR'));
  });
  it('enforces visibility, ownership, and owner-only diagnostic logs', async () => {
    const privateId = await seedScript(agent, 'private', 'private');
    const listedId = await seedScript(agent, 'listed');
    const openId = await seedScript(agent, 'open', 'open');
    await assert.rejects(scripts.get(null, privateId), rejected('NOT_FOUND'));
    assert.equal((await scripts.get(null, listedId)).code, undefined);
    assert.equal((await scripts.getVersion(null, listedId, 1)).code, undefined);
    assert.equal((await scripts.get(null, openId)).code, code);
    await assert.rejects(scripts.addVersion(otherAgent, listedId, { code }), rejected('FORBIDDEN'));
    await assert.rejects(scripts.dryRun(otherAgent, { scriptId: listedId, scenario: 'solo-open' }), rejected('FORBIDDEN'));
    const publicRun = await scripts.dryRun(otherAgent, { scriptId: openId, scenario: 'solo-open' });
    assert.deepEqual(publicRun.logs, []);
    const scenario = (await scripts.scenarios())[0];
    await assert.rejects(scripts.dryRun(agent, { code, init: { ...scenario.init,
      limits: { ...scenario.init.limits, moveTimeoutMs: 1000 } } }), rejected('VALIDATION_ERROR'));
    assert.equal((await scripts.dryRun(agent, { scriptId: listedId, scenario: 'solo-open' })).logs[0], 'private debug');
    assert.equal((await scripts.listPublic()).length, 2);
    await scripts.archive(agent, listedId);
    assert.equal((await scripts.get(agent, listedId)).archived, true);
    await assert.rejects(scripts.get(null, listedId), rejected('NOT_FOUND'));
  });
  it('enforces the 20 active scripts and 30 versions/hour agent quotas', async () => {
    const first = await seedScript(agent, 'first');
    for (let i = 1; i < 20; i++) await seedScript(agent, `script-${i}`);
    await assert.rejects(scripts.create(agent, { name: 'overflow', code }), rejected('LIMIT_EXCEEDED'));
    const db = getDb();
    for (let i = 2; i <= 11; i++) db.prepare("INSERT INTO script_versions(script_id,version,code,code_hash,size,status,created_at) VALUES(?,?,?,'fixture',?,'valid',?)").run(first, i, code, code.length, Date.now());
    await assert.rejects(scripts.addVersion(agent, first, { code }), rejected('RATE_LIMITED'));
    await scripts.archive(agent, first);
    await assert.rejects(scripts.create(agent, { name: 'version-limited', code }), rejected('RATE_LIMITED'));
    db.prepare('UPDATE script_versions SET created_at=?').run(Date.now() - 3600001);
    const replacement = await scripts.create(agent, { name: 'replacement', code });
    assert.equal(replacement.activeVersion, 1);
    await assert.rejects(scripts.validate('你'.repeat(22000)), rejected('LIMIT_EXCEEDED'));
  });
});

describe('ladder service', () => {
  it('joins and queues a rated match with unique agent identity and cooldown', async () => {
    const first = await seedScript(agent, 'first'), second = await seedScript(agent, 'second');
    const e1 = await ladders.join(agent, 'battle', { scriptId: first });
    await ladders.join(agent, 'battle', { scriptId: second });
    assert.equal(e1.rating, 1000);
    await assert.rejects(ladders.queue(otherAgent, 'battle', e1.entryId), rejected('FORBIDDEN'));
    const result = await ladders.queue(agent, 'battle', e1.entryId);
    assert.equal(result.status, 'done'); assert.equal(result.kind, 'ladder');
    assert.equal(result.participants.filter((p) => p.agentId === (agent as { agentId: number }).agentId).length, 1);
    const updated = ladders.entryDTO(e1.entryId);
    assert.equal(updated.games, 1); assert.notEqual(updated.rating, 1000);
    assert.equal(updated.rating, Math.round(1000 + 40 * (updated.mu - 3 * updated.sigma)));
    await ladders.recordMatchResult(result.id);
    assert.equal(ladders.entryDTO(e1.entryId).games, 1);
    await assert.rejects(ladders.queue(agent, 'battle', e1.entryId), rejected('RATE_LIMITED'));
    assert.equal((await ladders.leaderboard('battle', { by: 'agent' })).filter((r) => r.agentId === (agent as { agentId: number }).agentId).length, 1);
  });
  it('limits entries, prevents foreign-agent rating transfer, and pauses archived scripts', async () => {
    const ids = await Promise.all(['a', 'b', 'c', 'd'].map((name) => seedScript(agent, name)));
    for (const id of ids.slice(0, 3)) await ladders.join(agent, 'score', { scriptId: id });
    await assert.rejects(ladders.join(agent, 'score', { scriptId: ids[3] }), rejected('LIMIT_EXCEEDED'));
    const extra = await agents.create(user, { name: 'Same-user-other-agent' });
    const ownOther: Principal = { kind: 'agent', agentId: extra.id, userId: user.userId };
    const other = await seedScript(ownOther, 'other');
    const entry = (await ladders.mine(agent)).find((e) => e.scriptId === ids[0])!;
    await assert.rejects(ladders.updateEntry(user, 'score', entry.entryId, { scriptId: other }), rejected('VALIDATION_ERROR'));
    await scripts.archive(agent, ids[0]);
    assert.equal(ladders.entryDTO(entry.entryId).active, false);
    assert.equal((await ladders.leaderboard('score')).some((e) => e.entryId === entry.entryId), false);
  });
  it('deduplicates repeated solo enrollment and records exactly ten fixed-seed benchmarks', async () => {
    const scriptId = await seedScript(agent, 'solo');
    const e = await ladders.join(agent, 'solo', { scriptId });
    for (let i = 0; i < 10; i++) await ladders.join(agent, 'solo', { scriptId });
    await ladders.waitLadderJobs();
    const entry = ladders.entryDTO(e.entryId);
    assert.equal(entry.games, 10); assert.equal(entry.rating, entry.avgScore);
    const rows = getDb().prepare('SELECT m.seed,m.kind FROM matches m JOIN match_participants p ON p.match_id=m.id WHERE p.ladder_entry_id=? ORDER BY m.id').all(e.entryId) as Array<{ seed: number; kind: string }>;
    assert.deepEqual(rows.map((r) => r.seed), [17, 101, 307, 509, 701, 907, 1201, 1601, 2003, 3001]);
    assert.ok(rows.every((r) => r.kind === 'benchmark'));
    await ladders.join(agent, 'solo', { scriptId }); await ladders.waitLadderJobs();
    assert.equal(ladders.entryDTO(e.entryId).games, 10);
    const v2 = await scripts.addVersion(agent, scriptId, { code: code + '\n// refreshed' });
    assert.equal(v2.status, 'valid');
    await ladders.waitLadderJobs();
    assert.equal(ladders.entryDTO(e.entryId).games, 20);
  });
  it('validates distinct teammate scripts, rates a house 2v2 match and stops departed lineups', async () => {
    const a = await seedScript(agent, 'a'), b = await seedScript(otherAgent, 'b');
    const team = await teams.create(agent, { name: 'Together' });
    await teams.join(otherAgent, { inviteCode: team.inviteCode! });
    await assert.rejects(ladders.join(otherAgent, 'team-battle', { teamId: team.id, lineup: [a, b] }), rejected('FORBIDDEN'));
    await assert.rejects(ladders.join(agent, 'team-battle', { teamId: team.id, lineup: [a, a] }), rejected('VALIDATION_ERROR'));
    const entry = await ladders.join(agent, 'team-battle', { teamId: team.id, lineup: [a, b] });
    const match = await ladders.queue(agent, 'team-battle', entry.entryId);
    assert.equal(match.status, 'done'); assert.equal(match.participants.length, 4);
    assert.equal(ladders.entryDTO(entry.entryId).games, 1);
    const our = match.participants.filter((p) => p.teamId === team.id);
    assert.equal(our.length, 2); assert.equal(our[0].team, our[1].team);
    assert.equal(our[0].ratingAfter, our[1].ratingAfter);
    await teams.leave(otherAgent, team.id);
    assert.equal(ladders.entryDTO(entry.entryId).active, false);
  });
  it('rejects another member private script at both enrollment and lineup update', async () => {
    const a = await seedScript(agent, 'captain', 'private');
    const b = await seedScript(otherAgent, 'member', 'private');
    const team = await teams.create(agent, { name: 'Private lineup' });
    assert.ok(team.inviteCode);
    await teams.join(otherAgent, { inviteCode: team.inviteCode });
    await assert.rejects(ladders.join(agent, 'team-battle', { teamId: team.id, lineup: [a, b] }), rejected('FORBIDDEN'));
    await assert.rejects(ladders.join(user, 'team-battle', { teamId: team.id, lineup: [a, b] }), rejected('FORBIDDEN'));
    await scripts.update(otherAgent, b, { visibility: 'listed' });
    const entry = await ladders.join(agent, 'team-battle', { teamId: team.id, lineup: [a, b] });
    await scripts.update(otherAgent, b, { visibility: 'private' });
    await assert.rejects(ladders.updateEntry(agent, 'team-battle', entry.entryId, { lineup: [a, b] }), rejected('FORBIDDEN'));
    await assert.rejects(ladders.updateEntry(user, 'team-battle', entry.entryId, { active: true }), rejected('FORBIDDEN'));
    await assert.rejects(ladders.queue(agent, 'team-battle', entry.entryId), rejected('CONFLICT'));
    const paused = getDb().prepare('SELECT active,inactive_reason FROM ladder_entries WHERE id=?').get(entry.entryId) as
      { active: number; inactive_reason: string };
    assert.equal(paused.active, 0);
    assert.match(paused.inactive_reason, /私有脚本/);
    assert.equal((getDb().prepare('SELECT count(*) AS n FROM match_participants WHERE script_id=?').get(b) as { n: number }).n, 0);
  });
  it('rechecks internal matches and pauses revoked lineups before creating any record', async () => {
    const a = await seedScript(agent, 'captain'), b = await seedScript(otherAgent, 'member');
    const team = await teams.create(agent, { name: 'Revoked lineup' });
    assert.ok(team.inviteCode);
    await teams.join(otherAgent, { inviteCode: team.inviteCode });
    const entry = await ladders.join(agent, 'team-score', { teamId: team.id, lineup: [a, b] });
    await scripts.update(otherAgent, b, { visibility: 'private' });
    const ladder = getDb().prepare("SELECT id FROM ladders WHERE slug='team-score'").get() as { id: number };
    await assert.rejects(matches.createInternalMatch({ kind: 'ladder', ladderId: ladder.id,
      config: defaultConfig('score', { teams: true, maxTicks: 1 }), participants: [
        { scriptId: a, ladderEntryId: entry.entryId, teamId: team.id }, { builtin: 'greedy' },
        { scriptId: b, ladderEntryId: entry.entryId, teamId: team.id }, { builtin: 'coward' },
      ], wait: true }), rejected('CONFLICT'));
    assert.equal(ladders.entryDTO(entry.entryId).active, false);
    assert.equal((getDb().prepare('SELECT count(*) AS n FROM matches').get() as { n: number }).n, 0);
  });
  it('retains user authorization for two owned private scripts but never extends an Agent Key', async () => {
    const sibling = await agents.create(user, { name: 'Sibling' });
    const siblingPrincipal: Principal = { kind: 'agent', agentId: sibling.id, userId: user.userId };
    const a = await seedScript(agent, 'captain', 'private'), b = await seedScript(siblingPrincipal, 'sibling', 'private');
    const team = await teams.create(agent, { name: 'Same owner' });
    assert.ok(team.inviteCode);
    await teams.join(siblingPrincipal, { inviteCode: team.inviteCode });
    await assert.rejects(ladders.join(agent, 'team-score', { teamId: team.id, lineup: [a, b] }), rejected('FORBIDDEN'));
    const entry = await ladders.join(user, 'team-score', { teamId: team.id, lineup: [a, b] });
    getDb().prepare("UPDATE ladders SET config_json=json_set(config_json,'$.maxTicks',1) WHERE slug='team-score'").run();
    const match = await ladders.queue(user, 'team-score', entry.entryId);
    assert.equal(match.status, 'done');
    assert.equal(match.participants.filter(p => p.teamId === team.id).length, 2);
    await assert.rejects(ladders.updateEntry(agent, 'team-score', entry.entryId, { active: true }), rejected('FORBIDDEN'));
    assert.equal(ladders.entryDTO(entry.entryId).active, true);
  });
});
