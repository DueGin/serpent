'use strict';
// Test fixture: deliberately bypass every Python-level guard and attack from raw Node.
// It runs under exactly the same OS/Node command as a real Python host.
const fs = require('node:fs');
const net = require('node:net');
const cp = require('node:child_process');
const { Worker } = require('node:worker_threads');
for (const key of Object.keys(process.env)) delete process.env[key];
const [sentinel, output, port] = process.argv.slice(3);
const results = {};
for (const [name, fn] of Object.entries({
  read: () => fs.readFileSync(sentinel, 'utf8'),
  write: () => fs.writeFileSync(output, 'changed'),
  spawn: () => cp.spawnSync(process.execPath, ['-e', 'process.exit(0)']),
  native: () => process.dlopen({}, '/tmp/serpent-evil-addon.node'),
  eval: () => Function('return process')(),
})) {
  try { fn(); results[name] = false; }
  catch { results[name] = true; }
}
results.emptyEnv = Object.keys(process.env).length === 0;
const worker = new Worker(`const fs=require('node:fs');let blocked=false;try{fs.readFileSync(${JSON.stringify(sentinel)})}catch{blocked=true}require('node:worker_threads').parentPort.postMessage(blocked)`,
  { eval: true, execArgv: [] });
let networkDone = false;
const finish = () => {
  if (networkDone && 'worker' in results) { process.send(results); process.disconnect(); }
};
worker.on('message', blocked => { results.worker = blocked; finish(); });
const socket = net.connect({ host: '127.0.0.1', port: Number(port) });
socket.on('connect', () => { results.network = false; socket.destroy(); });
socket.on('error', () => { results.network = true; });
socket.on('close', () => { networkDone = true; finish(); });
setTimeout(() => { socket.destroy(); }, 500).unref();
