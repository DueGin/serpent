import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { openDatabase, setDb } from './db';
import { arenaEvents, attachRealtime } from './realtime';
import { shutdownRunner } from './runner';
import { dryRunSchema, initSchema, matchCreateSchema, stateSchema } from './routes/schemas';
import { checkDryRunOptions } from './services/script-input';
import { listScenarios } from './runner';
import type { Server as SocketServer } from 'socket.io';
import type { MatchSummaryDTO } from './api-types';

process.env.LADDER_AUTO = '0';

describe('REST request schemas', () => {
  it('rejects ambiguous participants, invalid counts, seeds and tick limits', () => {
    const valid = { kind: 'test', mode: 'battle', participants: [{ scriptId: 1 }, { builtin: 'greedy' }] };
    assert.equal(matchCreateSchema.safeParse(valid).success, true);
    for (const input of [
      { ...valid, participants: [{ scriptId: 1, builtin: 'greedy' }, { builtin: 'greedy' }] },
      { ...valid, participants: [{ scriptId: 1, ownerId: 9 }, { builtin: 'greedy' }] },
      { ...valid, mode: 'solo' },
      { ...valid, teams: true },
      { ...valid, seed: -1 },
      { ...valid, seed: 0x100000000 },
      { ...valid, maxTicks: 10001 },
    ]) assert.equal(matchCreateSchema.safeParse(input).success, false);
  });

  it('requires complete, bounded dry-run state and init objects', () => {
    assert.equal(dryRunSchema.safeParse({ code: 'function move() {}', state: {} }).success, false);
    assert.equal(dryRunSchema.safeParse({ code: 'function move() {}', init: {} }).success, false);
    assert.equal(dryRunSchema.safeParse({ code: 'function move() {}', scriptId: 1 }).success, false);
    assert.equal(dryRunSchema.safeParse({ scriptId: 1, version: 1 }).success, true);
    assert.equal(stateSchema.safeParse({ protocol: 'serpent-script-v1' }).success, false);
    assert.equal(initSchema.safeParse({ protocol: 'serpent-script-v1' }).success, false);
  });

  it('enforces dry-run limits for service callers as well as REST callers', () => {
    const scenario = listScenarios()[0]!;
    assert.deepEqual(checkDryRunOptions({ state: scenario.state, init: scenario.init }), {
      scenario: undefined, state: scenario.state, init: scenario.init,
    });
    for (const limits of [
      { ...scenario.init.limits, moveTimeoutMs: 51 },
      { ...scenario.init.limits, initTimeoutMs: 501 },
      { ...scenario.init.limits, memoryLimitMB: 33 },
      { ...scenario.init.limits, memoryLimitMB: Infinity },
    ]) assert.throws(() => checkDryRunOptions({ init: { ...scenario.init, limits } }));
    assert.throws(() => checkDryRunOptions({ state: scenario.state, scenario: scenario.id }));
    assert.throws(() => checkDryRunOptions({
      state: scenario.state, init: { ...scenario.init, width: scenario.init.width + 1 },
    }));
    for (const item of listScenarios()) {
      assert.doesNotThrow(() => checkDryRunOptions({ state: item.state, init: item.init }), item.id);
    }
  });
});

describe('Arena REST integration', () => {
  const db = openDatabase(':memory:');
  let server: http.Server;
  let io: SocketServer;
  let base: string;
  let token: string;
  let otherToken: string;
  let apiKey: string;
  let agentId: number;
  let otherAgentId: number;
  let scriptId: number;
  let publicScriptId: number;
  let exhibitionMatch: MatchSummaryDTO;
  const code = "function move(state) { console.log('owner-only-log'); return state.legalMoves[0] || state.you.dir; }";

  async function request(method: string, route: string, body?: unknown, credential?: string) {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: {
        ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any, headers: response.headers };
  }

  before(async () => {
    setDb(db);
    const { createApp } = await import('./app');
    server = http.createServer(createApp());
    io = attachRealtime(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const registered = await request('POST', '/api/auth/register', { username: 'rest-owner', password: 'abcdef' });
    assert.equal(registered.status, 201);
    token = registered.body.token;
    const other = await request('POST', '/api/auth/register', { username: 'rest-other', password: 'abcdef' });
    otherToken = other.body.token;
    const agent = await request('POST', '/api/agents', { name: 'REST agent', modelLabel: 'test-model' }, token);
    assert.equal(agent.status, 201);
    agentId = agent.body.id;
    apiKey = agent.body.apiKey;
    const otherAgent = await request('POST', '/api/agents', { name: 'Other REST agent' }, otherToken);
    assert.equal(otherAgent.status, 201);
    otherAgentId = otherAgent.body.id;
  });

  after(async () => {
    if (io) await new Promise<void>(resolve => io.close(() => resolve()));
    else if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await shutdownRunner();
    db.close();
  });

  it('publishes anonymous reads with list envelopes and stable JSON errors', async () => {
    for (const route of ['/api/agents/directory', '/api/scripts/public', '/api/matches', '/api/matches/live', '/api/ladders', '/api/teams']) {
      const result = await request('GET', route);
      assert.equal(result.status, 200, route);
      assert.ok(Array.isArray(result.body.data), route);
      assert.equal(result.headers.get('cache-control'), 'no-store');
    }
    assert.equal((await request('GET', '/api/health')).body.ok, true);
    assert.equal(typeof (await request('GET', '/api/stats')).body.agents, 'number');
    assert.equal((await request('GET', '/api/ladders/battle')).body.slug, 'battle');
    const missing = await request('GET', '/api/does-not-exist');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'NOT_FOUND');
    const docs = await request('GET', '/api/docs');
    assert.equal(docs.status, 200);
    assert.equal((await request('GET', '/mcp')).status, 405);
  });

  it('separates user and agent credentials and never redisplays API keys', async () => {
    const me = await request('GET', '/api/agents/me', undefined, apiKey);
    assert.equal(me.status, 200);
    assert.equal(me.body.id, agentId);
    const mine = await request('GET', '/api/agents', undefined, token);
    assert.equal(mine.body.data.length, 1);
    assert.equal(mine.body.data[0].apiKey, undefined);
    const profile = await request('GET', `/api/agents/${agentId}/profile`);
    assert.equal(profile.status, 200);
    assert.equal(profile.body.agent.keyPrefix, undefined);
    assert.equal(profile.body.agent.apiKey, undefined);
    assert.equal((await request('GET', '/api/agents/me', undefined, token)).status, 403);
    assert.equal((await request('GET', '/api/agents', undefined, apiKey)).status, 403);
    assert.equal((await request('POST', '/api/agents', { name: 'forbidden' }, apiKey)).status, 403);
    assert.equal((await request('PATCH', `/api/agents/${agentId}`, { name: 'stolen' }, otherToken)).status, 403);
    assert.equal((await request('GET', '/api/agents/me')).status, 401);
    const rotated = await request('POST', `/api/agents/${agentId}/rotate-key`, {}, token);
    assert.equal(rotated.status, 200);
    assert.notEqual(rotated.body.apiKey, apiKey);
    assert.equal((await request('GET', '/api/agents/me', undefined, apiKey)).status, 401);
    apiKey = rotated.body.apiKey;
    assert.equal((await request('GET', '/api/agents/me', undefined, apiKey)).status, 200);
  });

  it('validates all write boundaries before invoking services', async () => {
    for (const [route, body] of [
      ['/api/scripts/validate', { code: 'a'.repeat(65537) }],
      ['/api/scripts/validate', { code: '蛇'.repeat(21846) }],
      ['/api/scripts/dry-run', { code, state: { legalMoves: ['up'] } }],
      ['/api/scripts/dry-run', { code, init: { limits: { moveTimeoutMs: 1e9 } } }],
      ['/api/scripts', { name: 'unsafe', code, agentId, ownerId: 10 }],
      ['/api/matches', { kind: 'test', mode: 'solo', participants: [{ scriptId: 1, builtin: 'greedy' }] }],
      ['/api/ladders/battle/entries', { scriptId: 1, teamId: 1, lineup: [1, 2] }],
    ] as const) {
      const result = await request('POST', route, body, token);
      assert.equal(result.status, 422, route);
      assert.equal(result.body.error.code, 'VALIDATION_ERROR');
    }
    assert.equal((await request('POST', '/api/scripts/validate', { code })).status, 401);
    assert.equal((await request('GET', '/api/matches?limit=101')).status, 422);
    assert.equal((await request('GET', '/api/matches?limit=1&limit=2')).status, 422);
    assert.equal((await request('GET', '/api/scripts/abc')).status, 422);
    assert.equal((await request('GET', '/api/matches/1/frames/0?viewer=4')).status, 422);
    assert.equal((await request('PATCH', `/api/agents/${agentId}`, {}, token)).status, 422);
    const malformed = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken',
    });
    assert.equal(malformed.status, 422);
    assert.equal((await malformed.json() as any).error.code, 'VALIDATION_ERROR');
  });

  it('creates immutable script versions and protects private metadata and code', async () => {
    const created = await request('POST', '/api/scripts', { name: 'REST private', visibility: 'private', code }, apiKey);
    assert.equal(created.status, 201);
    scriptId = created.body.id;
    assert.equal(created.body.canEdit, true);
    if (created.body.activeVersion !== 1) {
      console.error('[rest] 首个脚本检测报告', JSON.stringify(created.body.versions.map((version: any) => ({
        status: version.status, report: version.report,
      }))));
    }
    assert.equal(created.body.activeVersion, 1);
    assert.equal(created.body.versions[0].report.ok, true);
    assert.equal(created.body.code, code);
    assert.equal((await request('GET', `/api/scripts/${scriptId}`)).status, 404);
    assert.equal((await request('GET', `/api/scripts/${scriptId}`, undefined, otherToken)).status, 404);
    const version = await request('POST', `/api/scripts/${scriptId}/versions`, { code, note: 'REST v2', activate: false }, apiKey);
    assert.equal(version.status, 201);
    assert.equal(version.body.version, 2);
    const detail = await request('GET', `/api/scripts/${scriptId}`, undefined, token);
    assert.equal(detail.body.activeVersion, 1);
    assert.equal(detail.body.latestVersion, 2);
    const activate = await request('PATCH', `/api/scripts/${scriptId}`, { activeVersion: 2, visibility: 'listed' }, token);
    assert.equal(activate.status, 200);
    assert.equal(activate.body.activeVersion, 2);
    const publicVersion = await request('GET', `/api/scripts/${scriptId}/versions/1`);
    assert.equal(publicVersion.status, 200);
    assert.equal(publicVersion.body.code, undefined);
    const ownedVersion = await request('GET', `/api/scripts/${scriptId}/versions/1`, undefined, apiKey);
    assert.equal(ownedVersion.body.code, code);
    const open = await request('POST', '/api/scripts', { agentId, name: 'REST open', visibility: 'open', code }, token);
    assert.equal(open.status, 201);
    publicScriptId = open.body.id;
    assert.equal((await request('GET', `/api/scripts/${publicScriptId}`)).body.code, code);
    const scenarios = await request('GET', '/api/scripts/scenarios');
    assert.ok(scenarios.body.data.length >= 8);
    assert.equal(stateSchema.safeParse(scenarios.body.data[0].state).success, true);
    assert.equal(initSchema.safeParse(scenarios.body.data[0].init).success, true);
    const dryRun = await request('POST', '/api/scripts/dry-run', { scriptId, scenario: scenarios.body.data[0].id }, apiKey);
    assert.equal(dryRun.status, 200);
    assert.equal(dryRun.body.ok, true);
  });

  it('runs test/exhibition matches, exposes replay frames, and hides owner logs', async () => {
    const test = await request('POST', '/api/matches', {
      kind: 'test', mode: 'solo', participants: [{ scriptId }], maxTicks: 8, seed: 42, wait: true,
    }, apiKey);
    assert.equal(test.status, 201);
    assert.equal(test.body.status, 'done');
    assert.equal(test.body.live, false);
    assert.ok(test.body.participants[0].logs.some((line: { text: string }) => line.text.includes('owner-only-log')));
    const anonymous = await request('GET', `/api/matches/${test.body.id}`);
    assert.equal(anonymous.status, 200);
    assert.equal(anonymous.body.participants[0].logs, undefined);
    assert.equal(anonymous.body.participants[0].firstError, undefined);
    const replay = await request('GET', `/api/matches/${test.body.id}/replay`);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.frames.length, test.body.ticks + 1);
    const frame = await request('GET', `/api/matches/${test.body.id}/frames/0?viewer=0`);
    assert.equal(frame.status, 200);
    assert.equal(frame.body.state.protocol, 'serpent-script-v1');
    assert.equal(typeof frame.body.ascii, 'string');
    const exhibition = await request('POST', '/api/matches', {
      kind: 'exhibition', mode: 'battle', participants: [{ builtin: 'greedy' }, { builtin: 'coward' }],
      maxTicks: 8, seed: 42, wait: true,
    }, token);
    assert.equal(exhibition.status, 201);
    assert.equal(exhibition.body.live, true);
    exhibitionMatch = exhibition.body;
    const live = await request('GET', '/api/matches/live');
    assert.ok(live.body.data.some((match: { id: number }) => match.id === exhibition.body.id));
    assert.ok(!live.body.data.some((match: { id: number }) => match.id === test.body.id));
  });

  it('allows anonymous Socket.IO connections and sanitizes public event payloads', async () => {
    const open = await fetch(`${base}/socket.io/?EIO=4&transport=polling`);
    const handshake = await open.text();
    assert.ok(handshake.startsWith('0'));
    const sid = (JSON.parse(handshake.slice(1)) as { sid: string }).sid;
    const transport = `${base}/socket.io/?EIO=4&transport=polling&sid=${encodeURIComponent(sid)}`;
    await fetch(transport, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '40' });
    let connected = false;
    for (let i = 0; i < 3 && !connected; i++) {
      const poll = await fetch(transport, { signal: AbortSignal.timeout(5000) });
      connected = (await poll.text()).split('\x1e').some(packet => packet.startsWith('40'));
    }
    assert.equal(connected, true);
    const withSecrets = {
      ...exhibitionMatch,
      participants: exhibitionMatch.participants.map(participant => ({
        ...participant, firstError: 'private-error', logs: [{ tick: 0, text: 'private-log' }],
      })),
    };
    arenaEvents.emit('match:finished', withSecrets);
    arenaEvents.emit('ladder:updated', { slug: 'battle' });
    const received: any[][] = [];
    for (let i = 0; i < 3 && received.length < 2; i++) {
      const poll = await fetch(transport, { signal: AbortSignal.timeout(5000) });
      for (const packet of (await poll.text()).split('\x1e')) {
        if (packet.startsWith('42')) {
          const event = JSON.parse(packet.slice(2)) as any[];
          if (event[0] === 'match:finished' || event[0] === 'ladder:updated') received.push(event);
        }
      }
    }
    const match = received.find(event => event[0] === 'match:finished')?.[1];
    assert.ok(match);
    assert.equal(match.participants[0].logs, undefined);
    assert.equal(match.participants[0].firstError, undefined);
    assert.deepEqual(received.find(event => event[0] === 'ladder:updated')?.[1], { slug: 'battle' });
    await fetch(transport, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '1' });
  });

  it('enters and manually queues ladders with rating updates and cooldowns', async () => {
    const joined = await request('POST', '/api/ladders/battle/entries', { scriptId: publicScriptId }, apiKey);
    assert.equal(joined.status, 201);
    const entryId = joined.body.entryId;
    assert.ok((await request('GET', '/api/ladders/mine', undefined, apiKey)).body.data.some((entry: { entryId: number }) => entry.entryId === entryId));
    const queued = await request('POST', `/api/ladders/battle/entries/${entryId}/queue`, {}, apiKey);
    assert.equal(queued.status, 200);
    assert.equal(queued.body.kind, 'ladder');
    let detail = await request('GET', `/api/matches/${queued.body.id}`, undefined, apiKey);
    for (let i = 0; i < 200 && ['queued', 'running'].includes(detail.body.status); i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      detail = await request('GET', `/api/matches/${queued.body.id}`, undefined, apiKey);
    }
    assert.equal(detail.body.status, 'done');
    const leaderboard = await request('GET', '/api/ladders/battle/leaderboard?by=entry&limit=100');
    const row = leaderboard.body.data.find((entry: { entryId: number }) => entry.entryId === entryId);
    assert.ok(row.games >= 1);
    assert.equal(typeof row.rating, 'number');
    assert.equal((await request('POST', `/api/ladders/battle/entries/${entryId}/queue`, {}, apiKey)).status, 429);
    const paused = await request('PATCH', `/api/ladders/battle/entries/${entryId}`, { active: false }, apiKey);
    assert.equal(paused.status, 200);
    assert.equal(paused.body.active, false);
    assert.equal((await request('DELETE', `/api/ladders/battle/entries/${entryId}`, undefined, apiKey)).status, 200);
  });

  it('guards team invitations and captain-only management', async () => {
    const created = await request('POST', '/api/teams', { agentId, name: 'REST team', tag: 'REST' }, token);
    assert.equal(created.status, 201);
    const teamId = created.body.id;
    assert.equal(typeof created.body.inviteCode, 'string');
    assert.equal((await request('GET', `/api/teams/${teamId}`)).body.inviteCode, undefined);
    assert.equal((await request('POST', '/api/teams/join', { agentId: otherAgentId, inviteCode: created.body.inviteCode }, otherToken)).status, 200);
    assert.equal((await request('PATCH', `/api/teams/${teamId}`, { name: 'hijack' }, otherToken)).status, 403);
    const rotated = await request('POST', `/api/teams/${teamId}/rotate-invite`, {}, token);
    assert.equal(rotated.status, 200);
    assert.notEqual(rotated.body.inviteCode, created.body.inviteCode);
    const kicked = await request('POST', `/api/teams/${teamId}/kick`, { agentId: otherAgentId }, token);
    assert.equal(kicked.status, 200);
    assert.equal(kicked.body.members.length, 1);
    assert.equal((await request('POST', `/api/teams/${teamId}/leave`, { agentId }, token)).status, 200);
    assert.equal((await request('DELETE', `/api/scripts/${publicScriptId}`, undefined, token)).status, 200);
  });
});

describe('Server startup recovery', () => {
  it('only startServer marks interrupted simulations as failed', async () => {
    const db = openDatabase(':memory:');
    setDb(db);
    const insert = db.prepare(`INSERT INTO matches(kind,mode,teams,status,seed,config_json,created_at)
      VALUES('exhibition','solo',0,?,1,'{}',?)`);
    insert.run('queued', Date.now());
    insert.run('running', Date.now());
    const { createApp, startServer } = await import('./app');
    createApp();
    assert.equal((db.prepare("SELECT count(*) AS n FROM matches WHERE status IN ('queued','running')").get() as { n: number }).n, 2);
    const started = await startServer({ port: 0, host: '127.0.0.1' });
    try {
      const rows = db.prepare('SELECT status,error,finished_at,broadcast_at FROM matches').all() as Array<{
        status: string; error: string; finished_at: number; broadcast_at: number | null;
      }>;
      for (const row of rows) {
        assert.equal(row.status, 'error');
        assert.equal(row.error, '服务重启，对局已中断');
        assert.equal(typeof row.finished_at, 'number');
        assert.equal(row.broadcast_at, null);
      }
    } finally {
      await started.close();
      db.close();
    }
  });
});
