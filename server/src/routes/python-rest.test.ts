import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { z } from 'zod';
import { createUser, openDatabase, setDb } from '../db';
import { shutdownRunner } from '../runner';
import * as agents from '../services/agents';
import * as matches from '../services/matches';
import type { Principal } from '../services/principal';

const code = 'def move(state):\n    print("python-owner-log", state["tick"])\n    legal = state["legalMoves"]\n    return {"direction": legal[0] if legal else state["you"]["dir"]}\n';
const errorSchema = z.object({ error: z.object({ code: z.string() }) });
const versionSchema = z.object({ version: z.number(), status: z.string() });
const scriptSchema = z.object({ id: z.number(), language: z.string(), activeVersion: z.number().nullable(), latestStatus: z.string() });
const runSchema = z.object({ ok: z.boolean(), legal: z.boolean(), logs: z.array(z.string()) });
const matchSchema = z.object({
  id: z.number(), status: z.string(), ticks: z.number(), participants: z.array(z.object({
    errors: z.number(), timeouts: z.number(), logs: z.array(z.object({ text: z.string() })).optional(),
  })),
});

describe('Python scripts REST lifecycle', () => {
  const db = openDatabase(':memory:');
  let server: http.Server;
  let base: string;
  let apiKey: string;
  let otherApiKey: string;

  before(async () => {
    setDb(db);
    const owner: Principal = { kind: 'user', userId: createUser('python-rest-owner', 'unused-test-hash').id };
    const other: Principal = { kind: 'user', userId: createUser('python-rest-other', 'unused-test-hash').id };
    apiKey = (await agents.create(owner, { name: 'Python REST Agent' })).apiKey;
    otherApiKey = (await agents.create(other, { name: 'Python REST Spectator' })).apiKey;
    const { createApp } = await import('../app');
    server = http.createServer(createApp());
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}/api`;
  });

  after(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await matches.waitPendingMatches(db);
    await shutdownRunner();
    db.close();
  });

  async function request(method: string, route: string, body?: unknown, key = apiKey) {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload: unknown = await response.json();
    return { status: response.status, body: payload };
  }

  it('persists Python language through validation, versions, id-based dry-run, a mixed match and review', async () => {
    const health = await request('GET', '/health');
    assert.deepEqual(z.object({ python: z.object({ available: z.boolean(), reason: z.string().optional() }) }).parse(health.body).python,
      { available: true });
    const created = await request('POST', '/scripts', { name: 'python-rest-snake', code, language: 'python', visibility: 'open' });
    assert.equal(created.status, 201);
    const script = scriptSchema.parse(created.body);
    assert.equal(script.language, 'python');
    assert.equal(script.latestStatus, 'valid', JSON.stringify(created.body));
    assert.equal(script.activeVersion, 1);
    assert.equal(z.object({ language: z.string() }).parse(db.prepare('SELECT language FROM scripts WHERE id=?').get(script.id)).language, 'python');

    const validated = await request('POST', '/scripts/validate', { code, language: 'python' });
    assert.equal(validated.status, 200);
    assert.equal(z.object({ ok: z.boolean() }).parse(validated.body).ok, true);

    const run = await request('POST', '/scripts/dry-run', { code, language: 'python', scenario: 'solo-open' });
    assert.equal(run.status, 200);
    assert.equal(runSchema.parse(run.body).ok, true);
    assert.equal(runSchema.parse(run.body).legal, true);
    assert.match(runSchema.parse(run.body).logs.join('\n'), /python-owner-log/);

    // Caller-supplied language never overrides the persisted language of a script reference.
    const byId = await request('POST', '/scripts/dry-run', { scriptId: script.id, language: 'javascript' });
    assert.equal(runSchema.parse(byId.body).ok, true);
    const publicRun = await request('POST', '/scripts/dry-run', { scriptId: script.id }, otherApiKey);
    assert.equal(runSchema.parse(publicRun.body).ok, true);
    assert.deepEqual(runSchema.parse(publicRun.body).logs, []);

    const version = await request('POST', `/scripts/${script.id}/versions`, { code: code + '\n# Python version 2\n' });
    assert.equal(version.status, 201);
    assert.equal(versionSchema.parse(version.body).version, 2);
    assert.equal(versionSchema.parse(version.body).status, 'valid');

    for (const [method, route, body] of [
      ['PATCH', `/scripts/${script.id}`, { language: 'javascript' }],
      ['POST', `/scripts/${script.id}/versions`, { code, language: 'javascript' }],
    ] as const) {
      const rejected = await request(method, route, body);
      assert.equal(rejected.status, 422);
      assert.equal(errorSchema.parse(rejected.body).error.code, 'VALIDATION_ERROR');
    }
    assert.equal(scriptSchema.parse((await request('GET', `/scripts/${script.id}`)).body).language, 'python');

    const played = await request('POST', '/matches', {
      kind: 'test', mode: 'battle', seed: 123, maxTicks: 4, wait: true,
      participants: [{ scriptId: script.id }, { builtin: 'greedy' }],
    });
    assert.equal(played.status, 201);
    const match = matchSchema.parse(played.body);
    assert.equal(match.status, 'done');
    assert.equal(match.ticks, 4);
    assert.equal(match.participants[0]?.errors, 0);
    assert.equal(match.participants[0]?.timeouts, 0);
    assert.match(JSON.stringify(match.participants[0]?.logs), /python-owner-log/);
    const review = await request('GET', `/matches/${match.id}/review?slot=0&series=1`);
    assert.equal(review.status, 200);
    assert.equal(z.object({ matchId: z.number() }).parse(review.body).matchId, match.id);
  });

  it('defaults existing clients to JavaScript and rejects invalid languages before mutation', async () => {
    const created = await request('POST', '/scripts', {
      name: 'legacy-javascript', code: 'function move(state) { return state.legalMoves[0] || state.you.dir; }',
    });
    assert.equal(created.status, 201);
    const script = scriptSchema.parse(created.body);
    assert.equal(script.language, 'javascript');
    assert.equal(script.latestStatus, 'valid');
    const beforeCount = db.prepare('SELECT COUNT(*) AS n FROM scripts').get();
    for (const route of ['/scripts', '/scripts/validate', '/scripts/dry-run']) {
      const invalid = await request('POST', route, { ...(route === '/scripts' ? { name: 'invalid-language' } : {}), code, language: 'ruby' });
      assert.equal(invalid.status, 422);
      assert.equal(errorSchema.parse(invalid.body).error.code, 'VALIDATION_ERROR');
    }
    assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM scripts').get(), beforeCount);
  });

  it('still saves genuine Python syntax failures as invalid versions rather than infrastructure errors', async () => {
    const created = await request('POST', '/scripts', { name: 'python-syntax-error', language: 'python', code: 'def move(:\n    pass' });
    assert.equal(created.status, 201);
    const script = scriptSchema.parse(created.body);
    assert.equal(script.latestStatus, 'invalid');
    assert.equal(script.activeVersion, null);
    const versions = z.object({ versions: z.array(z.object({
      report: z.object({ items: z.array(z.object({ id: z.string(), status: z.string() })) }),
    })) }).parse(created.body).versions;
    assert.equal(versions[0]?.report.items.find(item => item.id === 'compile')?.status, 'fail');
  });
});
