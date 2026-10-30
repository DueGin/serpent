import assert from 'node:assert/strict';
import type http from 'node:http';
import type Database from 'better-sqlite3';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z, type ZodType } from 'zod';

process.env.LADDER_AUTO = '0';
process.env.RUNNER_WORKERS = '1';

let httpServer: http.Server;
let database: Database.Database;
let baseUrl = '';
let client1: Client;
let client2: Client;
let agent1Id = 0;
let agent2Id = 0;
let apiKey1 = '';
let apiKey2 = '';

const textResultSchema = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
  structuredContent: z.record(z.unknown()).optional(),
}).passthrough();

function resultText(result: z.infer<typeof textResultSchema>): string {
  return result.content.map((item) => item.text || '').join('\n');
}

async function call<T>(client: Client, name: string, args: Record<string, unknown>, schema: ZodType<T>): Promise<T> {
  const raw = await client.callTool({ name, arguments: args });
  const result = textResultSchema.parse(raw);
  assert.notEqual(result.isError, true, `${name}: ${resultText(result)}`);
  assert.ok(result.structuredContent, `${name} 缺少 structuredContent`);
  return schema.parse(result.structuredContent.result);
}

async function api(route: string, options: { body?: unknown; token?: string; method?: string } = {}): Promise<unknown> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}/api${route}`, {
    method: options.method || (options.body === undefined ? 'GET' : 'POST'),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload: unknown = await response.json();
  assert.equal(response.ok, true, `${route}: ${JSON.stringify(payload)}`);
  return payload;
}

async function connectAgent(apiKey: string): Promise<Client> {
  const client = new Client({ name: 'serpent-mcp-e2e', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
  });
  await client.connect(transport);
  return client;
}

before(async () => {
  const [{ createApp }, { openDatabase, setDb }] = await Promise.all([
    import('../app'),
    import('../db'),
  ]);
  database = openDatabase(':memory:');
  setDb(database);
  httpServer = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    httpServer.once('listening', resolve);
    httpServer.once('error', reject);
  });
  const address = httpServer.address();
  assert.ok(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;

  const registration = z.object({ token: z.string() }).parse(await api('/auth/register', {
    body: { username: 'mcp_e2e', password: 'test-password' },
  }));
  const createdSchema = z.object({ id: z.number().int().positive(), apiKey: z.string().startsWith('agk_') }).passthrough();
  const first = createdSchema.parse(await api('/agents', {
    token: registration.token,
    body: { name: 'mcp-alpha', modelLabel: 'e2e-agent' },
  }));
  const second = createdSchema.parse(await api('/agents', {
    token: registration.token,
    body: { name: 'mcp-beta', modelLabel: 'e2e-agent' },
  }));
  agent1Id = first.id;
  agent2Id = second.id;
  apiKey1 = first.apiKey;
  apiKey2 = second.apiKey;
  client1 = await connectAgent(apiKey1);
  client2 = await connectAgent(apiKey2);
});

after(async () => {
  await Promise.all([client1?.close(), client2?.close()]);
  const { waitLadderJobs } = await import('../services/ladders');
  await waitLadderJobs();
  const { shutdownRunner } = await import('../runner');
  await shutdownRunner();
  if (httpServer) {
    const closed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
    httpServer.closeAllConnections();
    await closed;
  }
  if (database?.open) database.close();
});

test('MCP SDK Client 完整参赛流程', { timeout: 300_000 }, async (t) => {
  let script1Id = 0;
  let script2Id = 0;
  let matchId = 0;
  let teamId = 0;

  await t.test('HTTP 认证与方法约束', async () => {
    const unauthenticated = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(unauthenticated.status, 401);
    const get = await fetch(`${baseUrl}/mcp`, { headers: { authorization: `Bearer ${apiKey1}` } });
    assert.equal(get.status, 405);
    const del = await fetch(`${baseUrl}/mcp`, { method: 'DELETE', headers: { authorization: `Bearer ${apiKey1}` } });
    assert.equal(del.status, 405);
  });

  await t.test('listTools、资源与 prompt', async () => {
    const listed = await client1.listTools();
    const names = listed.tools.map((tool) => tool.name);
    assert.equal(new Set(names).size, names.length, '工具名不能重复');
    const required = [
      'whoami', 'get_rules', 'list_scenarios', 'validate_code', 'dry_run', 'list_scripts', 'get_script',
      'create_script', 'update_script', 'set_script_meta', 'archive_script', 'run_test_match', 'get_match',
      'get_match_frame', 'list_public_scripts', 'list_ladders', 'get_leaderboard', 'join_ladder',
      'leave_ladder', 'my_ladder_entries', 'queue_ladder_match', 'create_team', 'join_team',
      'leave_team', 'get_team', 'set_team_lineup',
    ];
    for (const name of required) assert.ok(names.includes(name), `缺少工具 ${name}`);

    const resources = await client1.listResources();
    assert.ok(resources.resources.some((resource) => resource.uri === 'serpent://docs/rules'));
    assert.ok(resources.resources.some((resource) => resource.uri === 'serpent://examples/flood-fill'));
    const prompt = await client1.getPrompt({ name: 'write_snake_script', arguments: { mode: 'battle' } });
    assert.ok(prompt.messages.length > 0);
  });

  await t.test('REST 文档与 whoami/get_rules/list_scenarios', async () => {
    const docs = z.object({ data: z.array(z.object({ name: z.string(), title: z.string() })) }).parse(await api('/docs'));
    assert.ok(docs.data.some((doc) => doc.name === 'mcp'));
    const rulesDoc = z.object({ markdown: z.string() }).parse(await api('/docs/rules'));
    assert.match(rulesDoc.markdown, /死亡蛇/);

    const me = await call(client1, 'whoami', {}, z.object({ agent: z.object({ id: z.number() }).passthrough() }).passthrough());
    assert.equal(me.agent.id, agent1Id);
    const rules = textResultSchema.parse(await client1.callTool({ name: 'get_rules', arguments: {} }));
    assert.match(resultText(rules), /serpent-script-v1/);
    assert.match(resultText(rules), /尸体/);
    const scenarios = await call(client1, 'list_scenarios', {}, z.array(z.object({ id: z.string(), state: z.record(z.unknown()) }).passthrough()));
    assert.ok(scenarios.length >= 8);
  });

  await t.test('validate_code 与 dry_run', async () => {
    const report = await call(client1, 'validate_code', {
      code: "function move(state) { return state.legalMoves[0] || 'up'; }",
    }, z.object({ ok: z.boolean(), items: z.array(z.object({ id: z.string(), status: z.string() }).passthrough()) }).passthrough());
    assert.equal(report.ok, true, JSON.stringify(report.items));
    const dry = await call(client1, 'dry_run', {
      code: "function move(state) { return state.legalMoves[0] || 'up'; }",
      scenario: 'solo-open',
    }, z.object({ ok: z.boolean(), legal: z.boolean(), direction: z.string().nullable() }).passthrough());
    assert.equal(dry.ok, true, JSON.stringify(dry));
    assert.equal(dry.legal, true);
  });

  await t.test('create/get/update/set_meta/list/public', async () => {
    const resource = z.object({ contents: z.array(z.object({ text: z.string() }).passthrough()) }).parse(
      await client1.readResource({ uri: 'serpent://examples/greedy-bfs' }),
    );
    const code = resource.contents[0]?.text;
    assert.ok(code);
    const detailSchema = z.object({
      id: z.number(), name: z.string(), activeVersion: z.number().nullable(), latestVersion: z.number(),
      versions: z.array(z.object({ version: z.number(), status: z.string(), report: z.unknown().nullable() }).passthrough()),
    }).passthrough();
    const created = await call(client1, 'create_script', {
      name: 'alpha-greedy', description: 'MCP 端到端脚本', visibility: 'listed', code, note: 'v1',
    }, detailSchema);
    script1Id = created.id;
    assert.equal(created.activeVersion, 1, JSON.stringify(created.versions));

    const fetched = await call(client1, 'get_script', { scriptId: script1Id, includeCode: true }, detailSchema.extend({ code: z.string().optional() }));
    assert.equal(fetched.code, code);
    const version = await call(client1, 'update_script', { scriptId: script1Id, code, note: 'v2', activate: true },
      z.object({ version: z.number(), status: z.string() }).passthrough());
    assert.equal(version.version, 2);
    assert.equal(version.status, 'valid');
    const updated = await call(client1, 'set_script_meta', { scriptId: script1Id, description: '已回归', activeVersion: 2 }, detailSchema);
    assert.equal(updated.activeVersion, 2);
    const mine = await call(client1, 'list_scripts', {}, z.array(z.object({ id: z.number() }).passthrough()));
    assert.ok(mine.some((script) => script.id === script1Id));
    const publicScripts = await call(client1, 'list_public_scripts', { q: 'alpha', limit: 20 }, z.array(z.object({ id: z.number() }).passthrough()));
    assert.ok(publicScripts.some((script) => script.id === script1Id));

    const createdSecond = await call(client2, 'create_script', {
      name: 'beta-greedy', visibility: 'listed', code, note: '队友脚本',
    }, detailSchema);
    script2Id = createdSecond.id;
    assert.equal(createdSecond.activeVersion, 1);
  });

  await t.test('run_test_match/get_match/get_match_frame', async () => {
    const matchSchema = z.object({ id: z.number(), status: z.string(), ticks: z.number(), participants: z.array(z.record(z.unknown())) }).passthrough();
    const match = await call(client1, 'run_test_match', {
      mode: 'battle', participants: [{ scriptId: script1Id }, { builtin: 'greedy' }], seed: 173, maxTicks: 120,
    }, matchSchema);
    matchId = match.id;
    assert.equal(match.status, 'done', JSON.stringify(match));
    assert.equal(match.participants.length, 2);
    const fetched = await call(client1, 'get_match', { matchId }, matchSchema);
    assert.equal(fetched.id, matchId);
    const frame = await call(client1, 'get_match_frame', { matchId, tick: 0, viewerSlot: 0 },
      z.object({ matchId: z.number(), ascii: z.string(), state: z.record(z.unknown()) }).passthrough());
    assert.equal(frame.matchId, matchId);
    assert.ok(frame.ascii.length > 0);
  });

  await t.test('个人天梯入场、排队、排名与退出', async () => {
    const entrySchema = z.object({ entryId: z.number(), ladderSlug: z.string(), active: z.boolean() }).passthrough();
    const entry = await call(client1, 'join_ladder', { slug: 'battle', scriptId: script1Id }, entrySchema);
    assert.equal(entry.active, true);
    const entries = await call(client1, 'my_ladder_entries', {}, z.array(entrySchema));
    assert.ok(entries.some((item) => item.entryId === entry.entryId));
    const ladders = await call(client1, 'list_ladders', {}, z.array(z.object({ slug: z.string() }).passthrough()));
    assert.ok(ladders.some((ladder) => ladder.slug === 'team-battle'));
    const queued = await call(client1, 'queue_ladder_match', { slug: 'battle', entryId: entry.entryId },
      z.object({ id: z.number(), status: z.string() }).passthrough());
    assert.equal(queued.status, 'done', JSON.stringify(queued));
    const leaderboard = await call(client1, 'get_leaderboard', { slug: 'battle', by: 'entry', limit: 50 },
      z.array(z.object({ entryId: z.number(), games: z.number() }).passthrough()));
    assert.ok(leaderboard.some((row) => row.entryId === entry.entryId && row.games >= 1));

    const scoreEntry = await call(client1, 'join_ladder', { slug: 'score', scriptId: script1Id }, entrySchema);
    const left = await call(client1, 'leave_ladder', { slug: 'score', entryId: scoreEntry.entryId }, z.object({ ok: z.literal(true) }));
    assert.equal(left.ok, true);
  });

  await t.test('create/join/get team、团队阵容和团队排名', async () => {
    const teamSchema = z.object({
      id: z.number(), name: z.string(), inviteCode: z.string().optional(),
      members: z.array(z.object({ agentId: z.number(), role: z.string() }).passthrough()),
      entries: z.array(z.record(z.unknown())),
    }).passthrough();
    const team = await call(client1, 'create_team', { name: 'MCP 联队', tag: 'MCP' }, teamSchema);
    teamId = team.id;
    assert.ok(team.inviteCode);
    const joined = await call(client2, 'join_team', { inviteCode: team.inviteCode }, teamSchema);
    assert.equal(joined.members.length, 2);
    assert.ok(joined.members.some((member) => member.agentId === agent2Id));
    const fetched = await call(client1, 'get_team', { teamId }, teamSchema);
    assert.equal(fetched.members.length, 2);

    const entry = await call(client1, 'set_team_lineup', {
      slug: 'team-battle', teamId, lineup: [script1Id, script2Id],
    }, z.object({ entryId: z.number(), lineup: z.array(z.number()), active: z.boolean() }).passthrough());
    assert.deepEqual(entry.lineup, [script1Id, script2Id]);
    assert.equal(entry.active, true);
    const leaderboard = await call(client1, 'get_leaderboard', { slug: 'team-battle', limit: 50 },
      z.array(z.object({ entryId: z.number(), teamId: z.number().nullable() }).passthrough()));
    assert.ok(leaderboard.some((row) => row.entryId === entry.entryId && row.teamId === teamId));
  });

  await t.test('leave_team 与 archive_script', async () => {
    const left = await call(client2, 'leave_team', { teamId }, z.object({ ok: z.literal(true) }));
    assert.equal(left.ok, true);
    const archived = await call(client2, 'archive_script', { scriptId: script2Id }, z.object({ ok: z.literal(true) }));
    assert.equal(archived.ok, true);
  });
});
