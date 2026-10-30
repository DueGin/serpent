// 部署冒烟检查：注册账号 → 创建 Agent → JS 脚本对局与复盘 →（可选）Python 脚本检测与对局。
// 用法：node scripts/smoke.mjs http://localhost:8008 [--python]
// 只创建一次性测试账号，不打印任何凭据。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] ?? 'http://localhost:8008';
const withPython = process.argv.includes('--python');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function call(method, url, body, token) {
  const res = await fetch(`${base}/api${url}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function check(condition, message) {
  if (!condition) throw new Error(`冒烟失败：${message}`);
  console.log(`✓ ${message}`);
}

const health = await call('GET', '/health');
check(health.ok === true, '健康检查');
const suffix = `${Date.now() % 1_000_000}`;
const { token } = await call('POST', '/auth/register', { username: `smoke${suffix}`, password: `smoke-${suffix}-pw` });
const agent = await call('POST', '/agents', { name: `Smoke${suffix}` }, token);
const key = agent.apiKey;

const js = await call('POST', '/scripts', { name: 'smoke-js', visibility: 'private',
  code: fs.readFileSync(path.join(repo, 'examples/scripts/greedy-bfs.js'), 'utf8') }, key);
check(js.latestStatus === 'valid', 'JavaScript 脚本通过检测');
const match = await call('POST', '/matches', { kind: 'test', mode: 'battle', seed: 1,
  participants: [{ scriptId: js.id }, { builtin: 'greedy' }], maxTicks: 200, wait: true }, key);
check(match.status === 'done', `JavaScript 对局完成（${match.ticks} 拍）`);
const review = await call('GET', `/matches/${match.id}/review`, undefined, key);
check(review.hasTrace && review.participants.length === 2, '对局复盘可用');

if (withPython) {
  check(health.python?.available === true, `Python 沙箱可用${health.python?.reason ? `（${health.python.reason}）` : ''}`);
  const py = await call('POST', '/scripts', { name: 'smoke-py', visibility: 'private', language: 'python',
    code: fs.readFileSync(path.join(repo, 'examples/scripts/greedy-bfs.py'), 'utf8') }, key);
  check(py.language === 'python' && py.latestStatus === 'valid', 'Python 脚本通过检测');
  const pyMatch = await call('POST', '/matches', { kind: 'test', mode: 'battle', seed: 2,
    participants: [{ scriptId: py.id }, { builtin: 'greedy' }], maxTicks: 200, wait: true }, key);
  const player = pyMatch.participants[0];
  check(pyMatch.status === 'done' && player.errors === 0 && player.timeouts === 0,
    `Python 对局完成（${pyMatch.ticks} 拍，平均 ${player.avgMoveMs}ms，无超时与报错）`);
}
console.log('冒烟检查全部通过');
