import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { createUser, openDatabase, setDb } from '../db';
import { sha256 } from '../crypto';
import { shutdownRunner } from '../runner';
import * as agents from '../services/agents';
import * as matches from '../services/matches';
import { pythonHostDiagnostics } from '../sandbox/python';

const execute = promisify(execFile);
const code = 'def move(state):\n    return state["legalMoves"][0]\n';
const unavailable = z.object({ error: z.object({ code: z.literal('PYTHON_UNAVAILABLE'), message: z.string() }) });

describe('Python infrastructure failures are never script failures', () => {
  const db = openDatabase(':memory:');
  let directory: string;
  let counter: string;
  let server: http.Server;
  let base: string;
  let apiKey: string;
  let scriptId: number;
  let client: Client;
  const originalCommand = process.env.PYTHON_ISOLATOR_COMMAND;
  const originalWorkers = process.env.RUNNER_WORKERS;

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'serpent-python-unavailable-'));
    counter = join(directory, 'probes');
    const command = join(directory, 'deny-isolator');
    await writeFile(command, `#!/bin/sh\nprintf 'probe\\n' >> '${counter}'\necho 'bwrap: No permissions to create new namespace' >&2\nexit 1\n`, { mode: 0o755 });
    process.env.PYTHON_ISOLATOR_COMMAND = command;
    process.env.RUNNER_WORKERS = '1';
    setDb(db);
    const user = createUser('python-unavailable-owner', 'unused-test-hash');
    const agent = await agents.create({ kind: 'user', userId: user.id }, { name: 'Unavailable Python Agent' });
    apiKey = agent.apiKey;
    // A previously validated immutable snapshot, saved before the deployment broke.
    scriptId = Number(db.prepare(`INSERT INTO scripts(agent_id,name,language,created_at,updated_at)
      VALUES (?,'existing-python','python',1,1)`).run(agent.id).lastInsertRowid);
    const versionId = db.prepare(`INSERT INTO script_versions(script_id,version,code,code_hash,size,status,note,created_at)
      VALUES (?,1,?,?,?,'valid','prior deployment',1)`).run(scriptId, code, sha256(code), Buffer.byteLength(code)).lastInsertRowid;
    db.prepare('UPDATE scripts SET latest_version_id=?,active_version_id=? WHERE id=?').run(versionId, versionId, scriptId);
    const { createApp } = await import('../app');
    server = http.createServer(createApp());
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}`;
    client = new Client({ name: 'python-unavailable-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
    }));
  });

  after(async () => {
    await client?.close();
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await matches.waitPendingMatches(db);
    await shutdownRunner();
    db.close();
    if (originalCommand === undefined) delete process.env.PYTHON_ISOLATOR_COMMAND;
    else process.env.PYTHON_ISOLATOR_COMMAND = originalCommand;
    if (originalWorkers === undefined) delete process.env.RUNNER_WORKERS;
    else process.env.RUNNER_WORKERS = originalWorkers;
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function request(route: string, body?: unknown) {
    const response = await fetch(`${base}/api${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload: unknown = await response.json();
    return { status: response.status, body: payload };
  }

  function snapshot() {
    return { scripts: db.prepare('SELECT * FROM scripts').all(), versions: db.prepare('SELECT * FROM script_versions').all() };
  }

  it('caches one lightweight startup probe and reports unavailable health/stats without loading Pyodide', async () => {
    const health = z.object({ ok: z.literal(true), python: z.object({ available: z.literal(false), reason: z.string() }) });
    for (let i = 0; i < 2; i++) {
      const response = await request('/health');
      assert.equal(response.status, 200);
      assert.match(health.parse(response.body).python.reason, /No permissions to create new namespace/);
    }
    assert.equal(z.object({ pythonAvailable: z.boolean() }).parse((await request('/stats')).body).pythonAvailable, false);
    assert.equal((await readFile(counter, 'utf8')).trim(), 'probe');
    assert.equal(pythonHostDiagnostics().hosts, 0);
  });

  it('returns 503 for validation/dry-run/create/version and leaves neither invalid versions nor empty scripts', async () => {
    const before = snapshot();
    for (const [route, body] of [
      ['/scripts/validate', { code, language: 'python' }],
      ['/scripts/dry-run', { code, language: 'python' }],
      ['/scripts/dry-run', { scriptId }],
      ['/scripts', { name: 'must-not-remain', code, language: 'python' }],
      [`/scripts/${scriptId}/versions`, { code }],
    ] as const) {
      const result = await request(route, body);
      assert.equal(result.status, 503, JSON.stringify(result));
      assert.match(unavailable.parse(result.body).error.message, /请联系管理员/);
      assert.deepEqual(snapshot(), before);
    }
  });

  it('marks the whole match error without disqualification, results, replay or ladder attribution', async () => {
    const input = { kind: 'test', mode: 'battle', maxTicks: 3,
      participants: [{ scriptId }, { builtin: 'greedy' }] };
    const waited = await request('/matches', { ...input, wait: true });
    assert.equal(waited.status, 503);
    unavailable.parse(waited.body);
    const queued = await request('/matches', { ...input, wait: false });
    assert.equal(queued.status, 201);
    await matches.waitPendingMatches(db);
    const rows = db.prepare('SELECT status,replay_blob,trace_blob,broadcast_at FROM matches').all();
    assert.equal(rows.length, 2);
    for (const row of rows) assert.deepEqual(row, { status: 'error', replay_blob: null, trace_blob: null, broadcast_at: null });
    const participants = z.array(z.object({ rank: z.number().nullable(), death_reason: z.string().nullable(), errors: z.number(), timeouts: z.number(), first_error: z.string().nullable() }))
      .parse(db.prepare('SELECT rank,death_reason,errors,timeouts,first_error FROM match_participants').all());
    for (const participant of participants) assert.deepEqual(participant, { rank: null, death_reason: null, errors: 0, timeouts: 0, first_error: null });
  });

  it('never updates ladder ratings or game counts for an unavailable Python match', async () => {
    const joined = await request('/ladders/battle/entries', { scriptId });
    assert.equal(joined.status, 201);
    const entryId = z.object({ entryId: z.number() }).parse(joined.body).entryId;
    const before = db.prepare('SELECT * FROM ladder_entries ORDER BY id').all();
    const queued = await request(`/ladders/battle/entries/${entryId}/queue`, {});
    assert.equal(queued.status, 503);
    unavailable.parse(queued.body);
    await matches.waitPendingMatches(db);
    assert.deepEqual(db.prepare('SELECT * FROM ladder_entries ORDER BY id').all(), before);
    assert.deepEqual(db.prepare(`SELECT m.status,p.rank,p.rating_before,p.rating_after
      FROM matches m JOIN match_participants p ON p.match_id=m.id WHERE m.kind='ladder' AND p.script_id=?`).get(scriptId),
    { status: 'error', rank: null, rating_before: null, rating_after: null });
  });

  it('surfaces the code and actionable Chinese text in MCP rules and failed tools without saving versions', async () => {
    const before = snapshot();
    const rules = await client.callTool({ name: 'get_rules', arguments: {} });
    assert.match(JSON.stringify(rules), /当前部署暂不支持 Python/);
    for (const [name, args] of [
      ['validate_code', { code, language: 'python' }],
      ['dry_run', { code, language: 'python' }],
      ['create_script', { name: 'mcp-must-not-remain', code, language: 'python' }],
      ['update_script', { scriptId, code }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, JSON.stringify(result));
      assert.match(JSON.stringify(result), /PYTHON_UNAVAILABLE/);
      assert.match(JSON.stringify(result), /不是用户代码错误/);
      assert.deepEqual(snapshot(), before);
    }
  });

  it('CLI prints PYTHON_UNAVAILABLE rather than a misleading validation report', async () => {
    const file = join(directory, 'snake.py');
    await writeFile(file, code);
    await assert.rejects(execute(process.execPath, ['--import', 'tsx', join(__dirname, '../cli/serpent.ts'), 'validate', file], {
      env: { ...process.env, SERPENT_URL: base, SERPENT_API_KEY: apiKey },
    }), (error: unknown) => {
      assert.ok(typeof error === 'object' && error !== null && 'stderr' in error && typeof error.stderr === 'string');
      assert.match(error.stderr, /PYTHON_UNAVAILABLE/);
      assert.match(error.stderr, /请联系管理员/);
      return true;
    });
  });

  it('JavaScript remains usable when Python isolation is unavailable', async () => {
    const result = await request('/scripts/dry-run', { code: 'function move(s) { return s.legalMoves[0]; }' });
    assert.equal(result.status, 200);
    assert.equal(z.object({ ok: z.boolean() }).parse(result.body).ok, true);
  });
});
