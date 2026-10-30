import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const options = { seed: 1, slot: 0, moveTimeoutMs: 50, initTimeoutMs: 500, memoryLimitMB: 32 };

async function fixture(mode: string, program: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'serpent-python-startup-'));
  try {
    const command = join(directory, 'isolator');
    // The probe succeeds, but the real host then fails before receiving source.
    await writeFile(command, `#!${process.execPath}
if (process.argv.includes('-e')) process.exit(0);
${mode}
`, { mode: 0o755 });
    const { stdout } = await execute(process.execPath, ['--import', 'tsx', '-e', `
require('tsx/cjs');
const assert = require('node:assert/strict');
const {createSandbox, inspectScript} = require(${JSON.stringify(join(__dirname, 'index.ts'))});
const {shutdownPythonHosts, pythonHostDiagnostics} = require(${JSON.stringify(join(__dirname, 'python.ts'))});
const {getPythonAvailability} = require(${JSON.stringify(join(__dirname, 'python-availability.ts'))});
const {runDryRun, runSimulation, runValidation} = require(${JSON.stringify(join(__dirname, '../runner/jobs.ts'))});
const {defaultConfig} = require(${JSON.stringify(join(__dirname, '../runner/config.ts'))});
const options = ${JSON.stringify(options)};
const code = 'def move(state):\\n    return "right"';
const unavailable = e => e.code === 'PYTHON_UNAVAILABLE' && /请联系管理员/.test(e.message);
(async () => { try { ${program} console.log('verified'); } finally { shutdownPythonHosts(); } })()
  .catch(e => { console.error(e); process.exitCode = 1; });
`], { env: { ...process.env, PYTHON_ISOLATOR_COMMAND: command, PYTHON_WARM_HOSTS: '0', PYTHON_MAX_HOSTS: '1',
      PYTHON_STARTUP_TIMEOUT_MS: '250' }, timeout: 20_000 });
    assert.match(stdout, /verified/);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('a missing isolator executable is infrastructure failure, not a compilation report', async () => {
  await fixture('process.exit(1);', `
    process.env.PYTHON_ISOLATOR_COMMAND += '-missing';
    assert.equal((await getPythonAvailability()).available, false);
    await assert.rejects(inspectScript(code, {}, 'python'), unavailable);
    assert.equal(pythonHostDiagnostics().hosts, 0);
  `);
});

for (const [name, mode] of [
  ['host exits before handshake', 'process.exit(1);'],
  ['host reports startup fatal before handshake', 'process.send({fatal:true,error:"boot failed"}); setInterval(() => {}, 1000);'],
  ['host never handshakes', 'setInterval(() => {}, 1000);'],
  ['host dies after handshake but before executing source', 'process.send({ready:true}); process.on("message", () => process.exit(1));'],
] as const) {
  test(`${name}: inspection, validation, dry-run and simulation reject as unavailable`, async () => {
    await fixture(mode, `
      assert.equal((await getPythonAvailability()).available, true);
      for (const operation of [
        () => inspectScript(code, {}, 'python'),
        () => runValidation(code, 'python'),
        () => runDryRun({code, language:'python'}),
        () => runSimulation({config:defaultConfig('solo', {maxTicks:1}), participants:[
          {slot:0,name:'python',team:null,source:{kind:'script',code,language:'python'}}]}),
      ]) await assert.rejects(operation(), unavailable);
      assert.equal(pythonHostDiagnostics().hosts, 0);
    `);
  });
}

test('a full Python host pool rejects checks and matches as retryable infrastructure errors', async () => {
  await fixture(`
process.send({ready:true});
process.on('message', m => process.send({id:m.id,hasMove:true,hasInit:false,cpuMs:0}));
`, `
    const held = await createSandbox(code, options, 'python');
    try {
      assert.equal(pythonHostDiagnostics().hosts, 1);
      for (const operation of [
        () => inspectScript(code, {}, 'python'),
        () => runValidation(code, 'python'),
        () => runDryRun({code, language:'python'}),
        () => runSimulation({config:defaultConfig('solo', {maxTicks:1}), participants:[
          {slot:0,name:'python',team:null,source:{kind:'script',code,language:'python'}}]}),
      ]) await assert.rejects(operation(), e => unavailable(e) && /并发池已满/.test(e.message));
    } finally { held.dispose(); }
    const retry = await createSandbox(code, options, 'python');
    retry.dispose();
    assert.equal(pythonHostDiagnostics().hosts, 0);
  `);
});
