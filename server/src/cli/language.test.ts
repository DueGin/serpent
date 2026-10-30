import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);

describe('CLI script languages', () => {
  let server: http.Server;
  let base: string;
  let directory: string;
  const requests: Array<{ route: string; body: unknown }> = [];
  let listedLanguage: 'javascript' | 'python' | null = null;

  before(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'serpent-cli-language-'));
    await writeFile(path.join(directory, 'snake.py'), 'def move(state):\n    return "right"\n');
    await writeFile(path.join(directory, 'snake.js'), 'function move(state) { return "right"; }');
    server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      requests.push({ route: req.url ?? '', body });
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && req.url === '/api/scripts') {
        res.end(JSON.stringify({ data: listedLanguage ? [{ id: 7, name: 'snake', language: listedLanguage }] : [] }));
      } else res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function cli(...args: string[]) {
    return execute(process.execPath, ['--import', 'tsx', path.join(__dirname, 'serpent.ts'), ...args], {
      env: { ...process.env, SERPENT_URL: base, SERPENT_API_KEY: 'agk_cli_test_placeholder' },
    });
  }

  it('recognizes Python and JavaScript for validate and dry-run, and permits an explicit language', async () => {
    const python = path.join(directory, 'snake.py'), javascript = path.join(directory, 'snake.js');
    for (const [args, language, route] of [
      [['validate', python], 'python', '/api/scripts/validate'],
      [['validate', javascript], 'javascript', '/api/scripts/validate'],
      [['validate', javascript, '--language', 'python'], 'python', '/api/scripts/validate'],
      [['dry-run', python, '--scenario', 'solo-open'], 'python', '/api/scripts/dry-run'],
    ] as const) {
      requests.length = 0;
      await cli(...args);
      const sent = requests[0];
      assert.ok(sent);
      assert.equal(sent.route, route);
      assert.ok(typeof sent.body === 'object' && sent.body !== null && 'language' in sent.body);
      assert.equal(sent.body.language, language);
    }
    requests.length = 0;
    await assert.rejects(cli('validate', python, '--language', 'ruby'), /--language/);
    assert.equal(requests.length, 0);
  });

  it('sets language on creation, reuses the existing language, and refuses cross-language versions', async () => {
    const python = path.join(directory, 'snake.py');
    requests.length = 0;
    listedLanguage = null;
    await cli('push', python, '--script', 'snake');
    const created = requests.find(request => request.route === '/api/scripts' && request.body !== undefined);
    assert.ok(created && typeof created.body === 'object' && created.body !== null && 'language' in created.body);
    assert.equal(created.body.language, 'python');

    requests.length = 0;
    listedLanguage = 'python';
    await cli('push', python, '--script', 'snake', '--note', 'v2');
    const updated = requests.find(request => request.route === '/api/scripts/7/versions');
    assert.ok(updated && typeof updated.body === 'object' && updated.body !== null);
    assert.equal('language' in updated.body, false);

    requests.length = 0;
    listedLanguage = 'javascript';
    await assert.rejects(cli('push', python, '--script', 'snake'), /不能提交 python 版本/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.body, undefined);
  });
});
