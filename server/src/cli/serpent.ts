import fs from 'node:fs';
import path from 'node:path';

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
