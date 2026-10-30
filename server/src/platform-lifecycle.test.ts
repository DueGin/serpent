import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { afterEach, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createUser, getDb, openDatabase, setDb } from './db';
import { AppError } from './http';

process.env.LADDER_AUTO = '0';
process.env.RUNNER_WORKERS = '1';

afterEach(async () => {
  const ladders = await import('./services/ladders'), matches = await import('./services/matches');
  const { shutdownRunner } = await import('./runner');
  await ladders.waitLadderJobs();
  await matches.waitPendingMatches();
  await shutdownRunner();
  const db = getDb();
  if (db.open) db.close();
});

it('close cancels waiting v1/v2 benchmark chains before shutdown and leaves no workers or later DB writes', async () => {
  const { shutdownRunner } = await import('./runner');
  const agents = await import('./services/agents'), ladders = await import('./services/ladders');
  const matches = await import('./services/matches'), scripts = await import('./services/scripts');
  await shutdownRunner();
  const db = openDatabase(':memory:');
  setDb(db);
  const workerIds = new Set<number>();
  let workersCreated = 0;
  const hook = createHook({
    init(id, type) { if (type === 'WORKER') { workerIds.add(id); workersCreated++; } },
    destroy(id) { workerIds.delete(id); },
  }).enable();
  const { startServer } = await import('./app');
  const server = await startServer({ port: 0, host: '127.0.0.1' });
  try {
    const owner = createUser('close-owner', 'hash');
    const agent = await agents.create({ kind: 'user', userId: owner.id }, { name: 'Close Agent' });
    const p = { kind: 'agent', userId: owner.id, agentId: agent.id } as const;
    const now = Date.now();
    const scriptId = Number(db.prepare('INSERT INTO scripts(agent_id,name,created_at,updated_at) VALUES(?,?,?,?)')
      .run(agent.id, 'Lifecycle', now, now).lastInsertRowid);
    const code = 'function move(s) { return s.legalMoves[0] || s.you.dir; }';
    const versions = [1, 2].map(version => Number(db.prepare(`INSERT INTO script_versions
      (script_id,version,code,code_hash,size,status,created_at) VALUES(?,?,?,'fixture',?,'valid',?)`)
      .run(scriptId, version, code, code.length, now).lastInsertRowid));
    db.prepare('UPDATE scripts SET active_version_id=?,latest_version_id=? WHERE id=?').run(versions[0], versions[1], scriptId);
    const blocker = await matches.create(p, { kind: 'exhibition', mode: 'score',
      participants: [{ builtin: 'greedy' }, { builtin: 'coward' }], maxTicks: 5000 });
    assert.equal(matches.activeMatchCount(db), 1);
    const entry = await ladders.join(p, 'solo', { scriptId });
    await delay(1);
    assert.equal(matches.activeMatchCount(db), 1);
    await scripts.update(p, scriptId, { activeVersion: 2 });
    const benchmarkCount = () => (db.prepare("SELECT count(*) AS n FROM matches WHERE kind='benchmark'").get() as { n: number }).n;
    assert.equal(benchmarkCount(), 0);
    const start = performance.now();
    await server.close();
    const closedMs = performance.now() - start;
    assert.equal((await matches.get(p, blocker.id)).status, 'done');
    assert.equal(benchmarkCount(), 0);
    assert.equal(ladders.entryDTO(entry.entryId).games, 0);
    assert.equal(matches.activeMatchCount(db), 0);
    const totalAtClose = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    const workersAtClose = workersCreated;
    assert.ok(workersAtClose > 0);
    await delay(200);
    assert.equal(workerIds.size, 0);
    assert.equal(workersCreated, workersAtClose);
    assert.equal(benchmarkCount(), 0);
    assert.equal((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, totalAtClose);
    await assert.rejects(matches.create(p, { kind: 'exhibition', mode: 'solo', participants: [{ builtin: 'greedy' }] }),
      error => error instanceof AppError && error.code === 'RATE_LIMITED');
    console.info(`[platform shutdown] close=${closedMs.toFixed(1)}ms benchmark=0 workers-created=${workersCreated} active-workers=${workerIds.size} post-close-writes=0`);
  } finally { await server.close(); hook.disable(); }
});
