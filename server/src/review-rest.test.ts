import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { after, before, describe, it } from 'node:test';
import { z } from 'zod';
import { openDatabase, setDb, createUser } from './db';
import { shutdownRunner } from './runner';
import * as agents from './services/agents';
import * as matches from './services/matches';
import type { Principal } from './services/principal';
import type { MatchDetailDTO } from './api-types';
import { reviewQuery, trendQuery } from './routes/schemas';

const logSchema = z.object({ tick: z.number(), text: z.string() });
const participantSchema = z.object({ slot: z.number(), logs: z.array(logSchema).optional(), firstError: z.string().optional(),
  stats: z.object({ errors: z.number() }) });
const seriesSchema = z.object({ slot: z.number(), score: z.array(z.number()), decision: z.array(z.string().nullable()),
  moveMs: z.array(z.number().nullable()) });
const reviewSchema = z.object({ matchId: z.number(), hasTrace: z.boolean(), participants: z.array(participantSchema),
  moments: z.array(z.object({ slot: z.number().nullable() })), advice: z.array(z.string()),
  series: z.array(seriesSchema).optional(), seriesRange: z.object({ from: z.number(), to: z.number() }).optional() });
const trendSchema = z.object({ scriptId: z.number(), mode: z.string().nullable(),
  recent: z.array(z.object({ matchId: z.number(), kind: z.string(), mode: z.string(), version: z.number().nullable(),
    rank: z.number().nullable(), score: z.number() })),
  versions: z.array(z.object({ version: z.number(), matches: z.number(), wins: z.number(), winRate: z.number(),
    avgScore: z.number(), decisions: z.number(), timeoutRate: z.number(), errorRate: z.number() })) });
const errorSchema = z.object({ error: z.object({ code: z.string() }) });

describe('复盘和趋势查询参数', () => {
  it('严格校验位置、闭区间、窗口与重复参数', () => {
    assert.deepEqual(reviewQuery.parse({ slot: '0', series: '1', from: '0', to: '2' }), { slot: 0, series: '1', from: 0, to: 2 });
    for (const input of [{ series: '0' }, { slot: '4' }, { slot: ['0', '1'] }, { from: '-1' },
      { from: '2', to: '1' }, { from: '0', to: '5001' }, { from: '0', owner: '1' }]) {
      assert.equal(reviewQuery.safeParse(input).success, false);
    }
    assert.deepEqual(trendQuery.parse({ mode: 'score', limit: '200' }), { mode: 'score', limit: 200 });
    for (const input of [{ limit: '0' }, { limit: '201' }, { mode: 'other' }, { limit: ['1', '2'] }, { private: '1' }]) {
      assert.equal(trendQuery.safeParse(input).success, false);
    }
  });
});

describe('复盘与趋势 REST', { concurrency: false }, () => {
  const db = openDatabase(':memory:');
  let server: http.Server;
  let base: string;
  let owner: Principal;
  let apiKey: string;
  let otherApiKey: string;
  let siblingApiKey: string;
  let scriptId: number;
  let privateScriptId: number;
  let publicMatch: MatchDetailDTO;
  let testMatch: MatchDetailDTO;
  let legacyMatch: MatchDetailDTO;
  let duplicateMatch: MatchDetailDTO;

  function insertScript(agentId: number, name: string, visibility: 'listed' | 'private'): number {
    const now = Date.now();
    const code = 'function move(s) { console.log("复盘所有者日志", s.tick); throw new Error("复盘私有错误"); }';
    const id = Number(db.prepare('INSERT INTO scripts(agent_id,name,visibility,created_at,updated_at) VALUES(?,?,?,?,?)')
      .run(agentId, name, visibility, now, now).lastInsertRowid);
    const versionId = Number(db.prepare(`INSERT INTO script_versions(script_id,version,code,code_hash,size,status,created_at)
      VALUES(?,1,?,?,?,'valid',?)`).run(id, code, createHash('sha256').update(code).digest('hex'), Buffer.byteLength(code), now).lastInsertRowid);
    db.prepare('UPDATE scripts SET active_version_id=?,latest_version_id=? WHERE id=?').run(versionId, versionId, id);
    return id;
  }

  async function request(route: string, credential?: string): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`${base}${route}`, { headers: credential ? { Authorization: `Bearer ${credential}` } : {} });
    const body: unknown = await response.json();
    return { status: response.status, body };
  }

  before(async () => {
    setDb(db);
    const user = createUser('review-owner', 'test-hash');
    owner = { kind: 'user', userId: user.id };
    const agent = await agents.create(owner, { name: '复盘 Agent' });
    apiKey = agent.apiKey;
    siblingApiKey = (await agents.create(owner, { name: '复盘同用户另一个 Agent' })).apiKey;
    const otherUser = createUser('review-other', 'test-hash');
    otherApiKey = (await agents.create({ kind: 'user', userId: otherUser.id }, { name: '复盘其他用户 Agent' })).apiKey;
    scriptId = insertScript(agent.id, '复盘公开脚本', 'listed');
    privateScriptId = insertScript(agent.id, '复盘私有脚本', 'private');
    publicMatch = await matches.create(owner, { kind: 'exhibition', mode: 'battle', maxTicks: 6, seed: 1,
      participants: [{ scriptId }, { builtin: 'greedy' }], wait: true });
    testMatch = await matches.create(owner, { kind: 'test', agentId: agent.id, mode: 'solo', maxTicks: 5, seed: 1,
      participants: [{ scriptId }], wait: true });
    legacyMatch = await matches.create(owner, { kind: 'exhibition', mode: 'solo', maxTicks: 4, seed: 1,
      participants: [{ scriptId }], wait: true });
    db.prepare('UPDATE matches SET trace_blob=NULL WHERE id=?').run(legacyMatch.id);
    duplicateMatch = await matches.create(owner, { kind: 'exhibition', mode: 'score', maxTicks: 2, seed: 1,
      participants: [{ scriptId }, { scriptId }], wait: true });
    const { createApp } = await import('./app');
    server = http.createServer(createApp());
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await matches.waitPendingMatches(db);
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await shutdownRunner();
    db.close();
  });

  it('保存 gzip 决策遥测，逐拍复盘与 frames 选项对齐', async () => {
    const row = db.prepare('SELECT trace_blob FROM matches WHERE id=?').get(publicMatch.id) as { trace_blob: Buffer };
    assert.ok(Buffer.isBuffer(row.trace_blob));
    const trace: unknown = JSON.parse(gunzipSync(row.trace_blob).toString('utf8'));
    const parsed = z.object({ v: z.literal(1), codes: z.array(z.string()), ms: z.array(z.array(z.number().nullable())) }).parse(trace);
    assert.equal(parsed.codes[0], 'eb');
    assert.equal(parsed.codes.length, publicMatch.ticks);
    const result = await request(`/api/matches/${publicMatch.id}/review?slot=0&series=1&from=1&to=3`);
    assert.equal(result.status, 200);
    const review = reviewSchema.parse(result.body);
    assert.equal(review.hasTrace, true);
    assert.deepEqual(review.participants.map(participant => participant.slot), [0]);
    assert.ok(review.moments.every(moment => moment.slot === 0));
    assert.deepEqual(review.seriesRange, { from: 1, to: 3 });
    assert.equal(review.series?.length, 1);
    assert.equal(review.series?.[0]?.score.length, 3);
    assert.deepEqual(review.series?.[0]?.decision, ['error', 'error', 'error']);
    assert.ok(review.advice.every(advice => !advice.includes('greedy')));
    const frame = await request(`/api/matches/${publicMatch.id}/frames/1?viewer=0`);
    assert.equal(frame.status, 200);
    const parsedFrame = z.object({ review: z.object({ tick: z.number(), slot: z.number(), decision: z.string().nullable(),
      options: z.array(z.object({ dir: z.string(), legal: z.boolean(), chosen: z.boolean(), space: z.number() })) }).nullable() }).parse(frame.body);
    assert.equal(parsedFrame.review?.tick, 1);
    assert.equal(parsedFrame.review?.decision, 'error');
    assert.equal(parsedFrame.review?.options.length, 3);
    assert.equal(parsedFrame.review?.options.filter(option => option.chosen).length, 1);
    const final = await request(`/api/matches/${publicMatch.id}/frames/${publicMatch.ticks}?viewer=0`);
    assert.equal(z.object({ review: z.null() }).safeParse(final.body).success, true);
    const summary = await request(`/api/matches/${publicMatch.id}/review`);
    assert.equal(reviewSchema.parse(summary.body).series, undefined);
  });

  it('按调用者追加私有字段，缓存不能泄漏日志或被返回对象污染', async () => {
    const owned = reviewSchema.parse((await request(`/api/matches/${publicMatch.id}/review`, apiKey)).body);
    assert.match(owned.participants[0]?.firstError ?? '', /复盘私有错误/);
    assert.equal(owned.participants[0]?.logs?.length, publicMatch.ticks);
    assert.ok(owned.advice.some(advice => advice.includes('行日志')));
    for (const credential of [undefined, otherApiKey, siblingApiKey]) {
      const anonymous = reviewSchema.parse((await request(`/api/matches/${publicMatch.id}/review`, credential)).body);
      assert.equal(anonymous.participants[0]?.firstError, undefined);
      assert.equal(anonymous.participants[0]?.logs, undefined);
      assert.ok(anonymous.advice.every(advice => !advice.includes('行日志')));
    }
    const copy = await matches.review(owner, publicMatch.id, { includeSeries: true });
    copy.advice.push('污染缓存');
    const first = copy.participants[0];
    if (first) first.stats.errors = -999;
    const firstSeries = copy.series?.[0];
    if (firstSeries) firstSeries.score[0] = -999;
    const frame = await matches.frame(owner, publicMatch.id, 0, 0);
    const firstOption = frame.review?.options[0];
    if (firstOption) firstOption.space = -999;
    const again = await matches.review(null, publicMatch.id, { includeSeries: true });
    assert.ok(!again.advice.includes('污染缓存'));
    assert.equal(again.participants[0]?.stats.errors, publicMatch.ticks);
    assert.equal(again.series?.[0]?.score[0], 0);
    assert.ok((await matches.frame(null, publicMatch.id, 0, 0)).review?.options.every(option => option.space >= 0));
  });

  it('旧对局无遥测时仍能分析，状态与 query 错误返回稳定错误码', async () => {
    const legacy = await request(`/api/matches/${legacyMatch.id}/review?series=1`);
    assert.equal(legacy.status, 200);
    const review = reviewSchema.parse(legacy.body);
    assert.equal(review.hasTrace, false);
    assert.ok(review.series?.every(series => series.decision.every(code => code === null)));
    assert.ok(review.series?.every(series => series.moveMs.every(ms => ms === null)));
    const whole = reviewSchema.parse((await request(`/api/matches/${publicMatch.id}/review?series=1`)).body);
    assert.deepEqual(whole.seriesRange, { from: 0, to: publicMatch.ticks });
    assert.equal(whole.series?.[0]?.score.length, publicMatch.ticks + 1);
    const single = reviewSchema.parse((await request(`/api/matches/${publicMatch.id}/review?series=1&from=2&to=2`)).body);
    assert.deepEqual(single.seriesRange, { from: 2, to: 2 });
    assert.equal(single.series?.[0]?.score.length, 1);
    const id = Number(db.prepare(`INSERT INTO matches(kind,mode,status,seed,config_json,created_at)
      VALUES('exhibition','solo','running',1,?,?)`).run(JSON.stringify(publicMatch.config), Date.now()).lastInsertRowid);
    const unfinished = await request(`/api/matches/${id}/review`);
    assert.equal(unfinished.status, 409);
    assert.equal(errorSchema.parse(unfinished.body).error.code, 'CONFLICT');
    for (const query of ['slot=2', 'series=1&from=4&to=1', 'series=1&from=0&to=9', 'series=1&extra=x', 'slot=0&slot=1']) {
      const result = await request(`/api/matches/${publicMatch.id}/review?${query}`);
      assert.equal(result.status, 422, query);
      assert.equal(errorSchema.parse(result.body).error.code, 'VALIDATION_ERROR');
    }
  });

  it('趋势按脚本可见性与对局类型过滤，窗口按不同对局计数', async () => {
    for (const credential of [undefined, otherApiKey, siblingApiKey]) {
      const privateAnonymous = await request(`/api/scripts/${privateScriptId}/trend`, credential);
      assert.equal(privateAnonymous.status, 404);
      assert.equal(errorSchema.parse(privateAnonymous.body).error.code, 'NOT_FOUND');
    }
    assert.equal((await request(`/api/scripts/${privateScriptId}/trend`, apiKey)).status, 200);
    const publicResult = await request(`/api/scripts/${scriptId}/trend`);
    assert.equal(publicResult.status, 200);
    const publicTrend = trendSchema.parse(publicResult.body);
    assert.ok(publicTrend.recent.every(match => match.kind !== 'test'));
    assert.equal(publicTrend.recent.filter(match => match.matchId === duplicateMatch.id).length, 1);
    assert.ok(!publicTrend.recent.some(match => match.matchId === testMatch.id));
    const otherTrend = trendSchema.parse((await request(`/api/scripts/${scriptId}/trend`, otherApiKey)).body);
    assert.ok(otherTrend.recent.every(match => match.kind !== 'test'));
    const ownTrend = trendSchema.parse((await request(`/api/scripts/${scriptId}/trend`, apiKey)).body);
    assert.ok(ownTrend.recent.some(match => match.matchId === testMatch.id));
    const limited = trendSchema.parse((await request(`/api/scripts/${scriptId}/trend?limit=2`, apiKey)).body);
    assert.equal(limited.recent.length, 2);
    assert.equal(limited.versions.reduce((sum, version) => sum + version.matches, 0), 2);
    const [version] = limited.versions;
    assert.equal(version?.wins, limited.recent.filter(match => match.rank === 1).length);
    assert.equal(version?.avgScore, limited.recent.reduce((sum, match) => sum + match.score, 0) / 2);
    const filtered = trendSchema.parse((await request(`/api/scripts/${scriptId}/trend?mode=score&limit=1`, apiKey)).body);
    assert.equal(filtered.mode, 'score');
    assert.deepEqual(filtered.recent.map(match => match.matchId), [duplicateMatch.id]);
    for (const query of ['limit=201', 'mode=invalid', 'owner=1']) assert.equal((await request(`/api/scripts/${scriptId}/trend?${query}`)).status, 422);
  });

  it('多版本汇总和 recent 使用相同的可见对局窗口', async () => {
    const agentId = publicMatch.participants[0]?.agentId;
    assert.equal(typeof agentId, 'number');
    if (agentId === null || agentId === undefined) throw new Error('缺少测试 Agent');
    const id = insertScript(agentId, '复盘多版本脚本', 'listed');
    db.prepare(`INSERT INTO script_versions(script_id,version,code,code_hash,size,status,created_at)
      SELECT script_id,2,code,code_hash,size,status,created_at FROM script_versions WHERE script_id=? AND version=1`).run(id);
    const first = await matches.create(owner, { kind: 'exhibition', mode: 'solo', maxTicks: 2, seed: 1,
      participants: [{ scriptId: id, version: 1 }], wait: true });
    const second = await matches.create(owner, { kind: 'exhibition', mode: 'solo', maxTicks: 3, seed: 1,
      participants: [{ scriptId: id, version: 2 }], wait: true });
    const third = await matches.create(owner, { kind: 'test', agentId, mode: 'solo', maxTicks: 4, seed: 1,
      participants: [{ scriptId: id, version: 1 }], wait: true });
    const own = trendSchema.parse((await request(`/api/scripts/${id}/trend?limit=2`, apiKey)).body);
    assert.deepEqual(own.recent.map(match => match.matchId), [third.id, second.id]);
    assert.deepEqual(own.versions.map(version => [version.version, version.matches, version.decisions, version.errorRate]),
      [[2, 1, 3, 1], [1, 1, 4, 1]]);
    const publicTrend = trendSchema.parse((await request(`/api/scripts/${id}/trend?limit=2`)).body);
    assert.deepEqual(publicTrend.recent.map(match => match.matchId), [second.id, first.id]);
    assert.deepEqual(publicTrend.versions.map(version => [version.version, version.matches, version.decisions, version.errorRate]),
      [[2, 1, 3, 1], [1, 1, 2, 1]]);
    const one = trendSchema.parse((await request(`/api/scripts/${id}/trend?limit=1`, apiKey)).body);
    assert.deepEqual(one.versions.map(version => version.version), [1]);
    assert.equal(one.versions[0]?.wins, Number(third.participants[0]?.rank === 1));
  });

  it('复盘缓存最多保留 64 局，命中刷新最近访问顺序', async () => {
    const insert = db.prepare(`INSERT INTO matches(kind,mode,status,seed,config_json,ticks,replay_blob,trace_blob,created_at)
      SELECT 'test',mode,status,seed,config_json,ticks,replay_blob,trace_blob,created_at FROM matches WHERE id=?`);
    const ids = Array.from({ length: 65 }, () => Number(insert.run(publicMatch.id).lastInsertRowid));
    const first = ids[0], second = ids[1], last = ids[64];
    assert.equal(typeof first, 'number');
    assert.equal(typeof second, 'number');
    assert.equal(typeof last, 'number');
    for (const id of ids.slice(0, 64)) assert.equal((await matches.review(null, id)).hasTrace, true);
    // 测试中用数据库标记辨认是否重新计算；生产中的已完成对局保持不可变。
    db.prepare('UPDATE matches SET trace_blob=NULL WHERE id IN (?,?)').run(first, second);
    assert.equal((await matches.review(null, first)).hasTrace, true);
    await matches.review(null, last);
    assert.equal((await matches.review(null, first)).hasTrace, true);
    assert.equal((await matches.review(null, second)).hasTrace, false);
  });
});
