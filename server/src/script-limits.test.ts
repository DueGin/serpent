import assert from 'node:assert/strict';
import { afterEach, beforeEach, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createUser, getDb, openDatabase, setDb } from './db';
import { AppError } from './http';
import { RunnerBusyError, RunnerUnavailableError, shutdownRunner } from './runner';
import * as scripts from './services/scripts';
import * as agents from './services/agents';
import { checkedScriptCall, SCRIPT_CHECK_LIMITS } from './services/script-limits';
import type { Principal } from './services/principal';

const code = 'function move(s) { return s.legalMoves[0] || s.you.dir; }';
let p: Principal;
const limited = (error: unknown) => error instanceof AppError && error.code === 'RATE_LIMITED' && error.status === 429;

beforeEach(() => {
  const db = openDatabase(':memory:'); setDb(db);
  const user = createUser('limits-owner', 'hash');
  p = { kind: 'user', userId: user.id };
});
afterEach(async () => { await shutdownRunner(); getDb().close(); });

it('shares the two-concurrent admission limit between validate and dry-run services', async () => {
  const first = scripts.validate(code, p);
  const second = scripts.dryRun(p, { code, scenario: 'solo-open' });
  await assert.rejects(scripts.dryRun(p, { code }), limited);
  const results = await Promise.all([first, second]);
  assert.ok(results.every(result => result.ok));
  assert.equal((await scripts.dryRun(p, { code })).ok, true);
  await assert.rejects(scripts.validate(code), error => error instanceof AppError && error.code === 'UNAUTHORIZED');
});

it('shares a 20-per-minute budget across operations and isolates other identities', async () => {
  const agent = await agents.create(p, { name: 'No mutation on rejection' });
  for (let i = 0; i < SCRIPT_CHECK_LIMITS.requests; i++) assert.equal((await scripts.dryRun(p, { code })).ok, true);
  await assert.rejects(scripts.validate(code, p), limited);
  await assert.rejects(scripts.dryRun(p, { code }), limited);
  await assert.rejects(scripts.create(p, { agentId: agent.id, name: 'rejected-before-insert', code }), limited);
  assert.equal((getDb().prepare('SELECT count(*) AS n FROM scripts').get() as { n: number }).n, 0);
  const other = createUser('limits-other', 'hash');
  assert.equal((await scripts.dryRun({ kind: 'user', userId: other.id }, { code })).ok, true);
});

it('releases concurrent slots on failure and maps all runner admission errors to sanitized 429', async () => {
  const db = getDb();
  for (const error of [new RunnerBusyError('queue_full'), new RunnerBusyError('queue_bytes'),
    new RunnerBusyError('queue_timeout'), new RunnerUnavailableError(5000, 'private/worker/path')]) {
    await assert.rejects(checkedScriptCall(db, p, async () => { throw error; }), failure => {
      assert.ok(limited(failure));
      assert.ok(failure instanceof AppError);
      assert.equal(failure.message.includes('private/worker/path'), false);
      return true;
    });
  }
  assert.equal(await checkedScriptCall(db, p, async () => 42), 42);
  const unknown = new Error('other failure');
  await assert.rejects(checkedScriptCall(db, p, async () => { throw unknown; }), error => error === unknown);
  assert.equal(await checkedScriptCall(db, p, async () => 7), 7);
});

it('enforces the same identity budget through real REST and MCP requests', async () => {
  const agent = await agents.create(p, { name: 'Shared quota' });
  const { createApp } = await import('./app');
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${agent.apiKey}`, 'Content-Type': 'application/json' };
  const client = new Client({ name: 'platform-rate-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
    const first = await fetch(`${base}/api/scripts/dry-run`, { method: 'POST', headers, body: JSON.stringify({ code }) });
    assert.equal(first.status, 200);
    await first.json();
    for (let i = 1; i < SCRIPT_CHECK_LIMITS.requests; i++) {
      const result = await client.callTool({ name: 'dry_run', arguments: { code, scenario: 'solo-open' } });
      assert.notEqual(result.isError, true);
    }
    const rejected = await fetch(`${base}/api/scripts/validate`, { method: 'POST', headers, body: JSON.stringify({ code }) });
    assert.equal(rejected.status, 429);
    const payload: unknown = await rejected.json();
    assert.deepEqual(payload, { error: { code: 'RATE_LIMITED', message: '检测与试跑共用每身份最多 2 个并发、每 60 秒 20 次的额度' } });
    const result = await client.callTool({ name: 'validate_code', arguments: { code } });
    assert.equal(result.isError, true);
    assert.equal(JSON.stringify(result.structuredContent).includes('RATE_LIMITED'), true);
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
