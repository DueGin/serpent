import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

interface CliOptions {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

interface ScriptSummary {
  id: number;
  name: string;
}

function parseArgs(argv: string[]): CliOptions {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (flags.has(key)) throw new Error(`--${key} 不能重复指定`);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags.set(key, true);
    } else {
      flags.set(key, next);
      index += 1;
    }
  }
  return { positionals, flags };
}

function requiredString(flags: Map<string, string | boolean>, name: string): string {
  const value = flags.get(name);
  if (typeof value !== 'string' || !value.trim()) throw new Error(`缺少 --${name} 参数`);
  return value;
}

function optionalString(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

function apiUrl(route: string): string {
  const base = (process.env.SERPENT_URL || 'http://localhost:8008').replace(/\/+$/, '');
  return `${base}/api${route}`;
}

function payloadMessage(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || !('error' in payload)) return null;
  const error = payload.error;
  if (typeof error !== 'object' || error === null || !('message' in error)) return null;
  return typeof error.message === 'string' ? error.message : null;
}

async function request(route: string, init: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<unknown> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const apiKey = process.env.SERPENT_API_KEY;
  if (init.auth !== false) {
    if (!apiKey) throw new Error('请先设置 SERPENT_API_KEY=agk_...');
    headers.authorization = `Bearer ${apiKey}`;
  }
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(apiUrl(route), {
    method: init.method || (init.body === undefined ? 'GET' : 'POST'),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payloadMessage(payload) || `HTTP ${response.status} ${response.statusText}`);
  }
  return payload;
}

function readCode(file: string): string {
  // pnpm --filter 会把 cwd 切到 server/，相对路径按用户调用处解析（INIT_CWD）
  const base = process.env.INIT_CWD || process.cwd();
  return fs.readFileSync(path.resolve(base, file), 'utf8');
}

function listScripts(): Promise<unknown> {
  return request('/scripts');
}

function scriptItems(payload: unknown): ScriptSummary[] {
  if (typeof payload !== 'object' || payload === null || !('data' in payload) || !Array.isArray(payload.data)) {
    throw new Error('脚本列表响应格式不正确');
  }
  return payload.data.filter((item): item is ScriptSummary => {
    return typeof item === 'object' && item !== null && 'id' in item && typeof item.id === 'number'
      && 'name' in item && typeof item.name === 'string';
  });
}

async function findScript(name: string): Promise<ScriptSummary | undefined> {
  const scripts = scriptItems(await listScripts());
  return scripts.find((script) => script.name.toLowerCase() === name.toLowerCase());
}

async function requireScript(name: string): Promise<ScriptSummary> {
  const script = await findScript(name);
  if (!script) throw new Error(`找不到脚本「${name}」，请先用 push 创建`);
  return script;
}

async function scriptId(value: string): Promise<number> {
  if (/^[1-9]\d*$/.test(value)) {
    const result = z.number().int().positive().safe().safeParse(Number(value));
    if (!result.success) throw new Error('脚本 ID 必须为正整数');
    return result.data;
  }
  return (await requireScript(value)).id;
}

function integerFlag(flags: Map<string, string | boolean>, name: string, min: number, max: number): number | undefined {
  if (!flags.has(name)) return undefined;
  const raw = flags.get(name);
  const result = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(min).max(max)).safeParse(raw);
  if (!result.success) throw new Error(`--${name} 必须为 ${min}–${max} 的整数`);
  return result.data;
}

function checkOptions(options: CliOptions, allowed: string[], usage: string): void {
  if (options.positionals.length !== 1) throw new Error(`用法：${usage}`);
  for (const name of options.flags.keys()) {
    if (!allowed.includes(name)) throw new Error(`未知参数 --${name}；用法：${usage}`);
  }
  if (options.flags.has('json') && options.flags.get('json') !== true) {
    throw new Error('--json 不接受参数值');
  }
}

const reviewSummarySchema = z.object({
  matchId: z.number(), ticks: z.number(), hasTrace: z.boolean(),
  participants: z.array(z.object({
    name: z.string(), slot: z.number(), rank: z.number().nullable(), score: z.number(), length: z.number(),
    deathReason: z.enum(['wall', 'self', 'snake', 'head', 'starve', 'disqualified']).nullable(),
    stats: z.object({ survivalTicks: z.number(), timeouts: z.number(), errors: z.number(), riskyMoves: z.number() }),
  })),
  moments: z.array(z.object({ severity: z.enum(['critical', 'warn', 'info']), message: z.string() })),
  advice: z.array(z.string()),
});

const trendSummarySchema = z.object({
  scriptId: z.number(), scriptName: z.string(), recent: z.array(z.unknown()),
  versions: z.array(z.object({
    version: z.number(), matches: z.number(), winRate: z.number(), avgRank: z.number(), avgScore: z.number(),
    survivalRate: z.number(), timeoutRate: z.number(), errorRate: z.number(), avgMoveMs: z.number(),
  })),
});

function printReview(payload: unknown): void {
  const review = reviewSummarySchema.parse(payload);
  const deathLabels = { wall: '撞墙', self: '咬到自己', snake: '撞到敌蛇', head: '头对头碰撞', starve: '生命值耗尽', disqualified: '失格' };
  const lines = [`对局 #${review.matchId}：共 ${review.ticks} 拍，${review.hasTrace ? '含决策遥测' : '旧对局没有决策遥测'}。`];
  for (const player of review.participants) {
    lines.push(`${player.name}（位置 ${player.slot}）：名次 ${player.rank ?? '无'}，分数 ${player.score}，身长 ${player.length}，存活 ${player.stats.survivalTicks} 拍，死因 ${player.deathReason ? deathLabels[player.deathReason] : '无'}，超时/报错 ${player.stats.timeouts}/${player.stats.errors}，风险决策 ${player.stats.riskyMoves} 次。`);
  }
  const moments = review.moments.filter((moment) => moment.severity !== 'info').slice(0, 20);
  if (moments.length) lines.push('', '关键时刻：', ...moments.map((moment) => `- ${moment.message}`));
  if (review.advice.length) lines.push('', '改进建议：', ...review.advice.map((advice) => `- ${advice}`));
  process.stdout.write(`${lines.join('\n')}\n`);
}

function printTrend(payload: unknown): void {
  const trend = trendSummarySchema.parse(payload);
  const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
  const lines = [`脚本「${trend.scriptName}」（#${trend.scriptId}）：最近 ${trend.recent.length} 局。`];
  for (const version of trend.versions) {
    lines.push(`v${version.version}：${version.matches} 局，胜率 ${percent(version.winRate)}，平均名次 ${version.avgRank.toFixed(2)}，平均分 ${version.avgScore.toFixed(1)}，存活率 ${percent(version.survivalRate)}，超时/报错率 ${percent(version.timeoutRate)}/${percent(version.errorRate)}，平均耗时 ${version.avgMoveMs.toFixed(2)}ms。`);
  }
  if (!trend.versions.length) lines.push('当前筛选范围没有已完成对局。');
  process.stdout.write(`${lines.join('\n')}\n`);
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const [command, ...rest] = args;
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(`SERPENT CLI（SERPENT_URL、SERPENT_API_KEY）\n\n` +
      `  whoami\n` +
      `  push <file> --script <name> [--note <text>]\n` +
      `  validate <file>\n` +
      `  dry-run <file> --scenario <id>\n` +
      `  test <scriptName> --mode battle --vs greedy,coward\n` +
      `  review <matchId> [--slot N] [--json]\n` +
      `  trend <script> [--mode battle] [--limit 50] [--json]\n` +
      `  ladder join <slug> --script <name>\n` +
      `  leaderboard <slug>\n`);
    return;
  }

  if (command === 'whoami') {
    print(await request('/agents/me'));
    return;
  }

  if (command === 'leaderboard') {
    const slug = rest[0];
    if (!slug) throw new Error('用法：leaderboard <slug>');
    print(await request(`/ladders/${encodeURIComponent(slug)}/leaderboard`, { auth: false }));
    return;
  }

  const { positionals, flags } = parseArgs(rest);

  if (command === 'review') {
    checkOptions({ positionals, flags }, ['slot', 'json'], 'review <matchId> [--slot N] [--json]');
    const match = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().positive().safe()).safeParse(positionals[0]);
    if (!match.success) throw new Error('用法：review <matchId> [--slot N] [--json]；matchId 必须为正整数');
    const slot = integerFlag(flags, 'slot', 0, 3);
    const query = slot === undefined ? '' : `?slot=${slot}`;
    const payload = await request(`/matches/${match.data}/review${query}`);
    if (flags.has('json')) print(payload);
    else printReview(payload);
    return;
  }

  if (command === 'trend') {
    checkOptions({ positionals, flags }, ['mode', 'limit', 'json'], 'trend <script> [--mode battle] [--limit 50] [--json]');
    const script = positionals[0];
    if (!script) throw new Error('用法：trend <script> [--mode battle] [--limit 50] [--json]');
    const mode = optionalString(flags, 'mode');
    if (flags.has('mode') && !z.enum(['solo', 'score', 'battle']).safeParse(mode).success) {
      throw new Error('--mode 仅支持 solo、score、battle');
    }
    const limit = integerFlag(flags, 'limit', 1, 200);
    const query = new URLSearchParams();
    if (mode !== undefined) query.set('mode', mode);
    if (limit !== undefined) query.set('limit', String(limit));
    const id = await scriptId(script);
    const payload = await request(`/scripts/${id}/trend${query.size ? `?${query.toString()}` : ''}`);
    if (flags.has('json')) print(payload);
    else printTrend(payload);
    return;
  }

  if (command === 'validate') {
    const file = positionals[0];
    if (!file) throw new Error('用法：validate <file>');
    print(await request('/scripts/validate', { body: { code: readCode(file) } }));
    return;
  }

  if (command === 'dry-run') {
    const file = positionals[0];
    if (!file) throw new Error('用法：dry-run <file> --scenario <id>');
    print(await request('/scripts/dry-run', {
      body: { code: readCode(file), scenario: requiredString(flags, 'scenario') },
    }));
    return;
  }

  if (command === 'push') {
    const file = positionals[0];
    if (!file) throw new Error('用法：push <file> --script <name> [--note <text>]');
    const name = requiredString(flags, 'script');
    const code = readCode(file);
    const note = optionalString(flags, 'note');
    const existing = await findScript(name);
    print(existing
      ? await request(`/scripts/${existing.id}/versions`, { body: { code, note } })
      : await request('/scripts', { body: { name, code, note } }));
    return;
  }

  if (command === 'test') {
    const name = positionals[0];
    if (!name) throw new Error('用法：test <scriptName> --mode battle --vs greedy,coward');
    const script = await requireScript(name);
    const mode = optionalString(flags, 'mode') || 'battle';
    if (!['solo', 'score', 'battle'].includes(mode)) throw new Error('--mode 仅支持 solo、score、battle');
    const opponents = (optionalString(flags, 'vs') || '').split(',').map((item) => item.trim()).filter(Boolean);
    const participants: Array<{ scriptId: number } | { builtin: string }> = [{ scriptId: script.id }];
    for (const opponent of opponents) {
      if (!['greedy', 'coward', 'random'].includes(opponent)) {
        throw new Error(`未知内置对手「${opponent}」；可选 greedy、coward、random`);
      }
      participants.push({ builtin: opponent });
    }
    print(await request('/matches', {
      body: { kind: 'test', mode, participants, wait: true },
    }));
    return;
  }

  if (command === 'ladder' && positionals[0] === 'join') {
    const slug = positionals[1];
    if (!slug) throw new Error('用法：ladder join <slug> --script <name>');
    const script = await requireScript(requiredString(flags, 'script'));
    print(await request(`/ladders/${encodeURIComponent(slug)}/entries`, { body: { scriptId: script.id } }));
    return;
  }

  throw new Error(`未知命令「${command}」，运行 pnpm serpent -- help 查看用法`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : '命令执行失败';
  process.stderr.write(`SERPENT CLI：${message}\n`);
  process.exitCode = 1;
});
