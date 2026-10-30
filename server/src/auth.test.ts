import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { hashPassword, signToken, verifyPassword, verifyToken } from './auth';
import { encryptSecret, decryptSecret } from './crypto';
import {
  createAgent,
  createUser,
  getDb,
  getUserByName,
  listAgentsByUser,
  openDatabase,
  setDb,
  toPublicAgent,
  updateAgent,
} from './db';

describe('password and jwt', () => {
  it('hashes passwords and signs jwt', () => {
    const hash = hashPassword('secret1');
    assert.equal(verifyPassword('secret1', hash), true);
    assert.equal(verifyPassword('nope', hash), false);
    const token = signToken({ id: 7, username: 'neo' });
    const payload = verifyToken(token);
    assert.equal(payload.userId, 7);
    assert.equal(payload.username, 'neo');
  });
});

describe('users bind agents with prompts', () => {
  const file = path.join(os.tmpdir(), `serpent-auth-${process.pid}.db`);

  before(() => {
    setDb(openDatabase(file));
  });

  after(() => {
    for (const p of [file, `${file}-wal`, `${file}-shm`]) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
  });

  it('registers a user and binds an agent with custom prompt', () => {
    const user = createUser('裁判', hashPassword('abcdef'));
    assert.equal(getUserByName('裁判')?.id, user.id);
    assert.equal(getUserByName('裁判')?.username, '裁判');

    const agent = createAgent({
      userId: user.id,
      name: 'grok-arena',
      protocol: 'message',
      baseUrl: 'https://flux-code.cc/v1',
      model: 'grok-4.7',
      apiKey: 'sk-test-secret-key-aaaa',
      systemPrompt: '只许回复 left',
    });
    assert.equal(agent.system_prompt, '只许回复 left');
    assert.match(agent.platform_key, /^agk_/);

    const listed = listAgentsByUser(user.id).map(toPublicAgent);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.apiKeyHint.includes('sk-t'), true);
    assert.equal(listed[0]!.apiKeyHint.includes('aaaa'), true);
    assert.ok(!JSON.stringify(listed).includes('sk-test-secret-key-aaaa'));
    const stored = getDb().prepare('SELECT api_key FROM agents WHERE id = ?').get(agent.id) as { api_key: string };
    assert.match(stored.api_key, /^enc1:/);
    assert.equal(decryptSecret(stored.api_key), 'sk-test-secret-key-aaaa');
    assert.equal(agent.api_key, 'sk-test-secret-key-aaaa');

    const updated = updateAgent(agent.id, { systemPrompt: '只许回复 up' });
    assert.equal(updated?.system_prompt, '只许回复 up');
  });
});

describe('secret encryption', () => {
  it('roundtrips and leaves enc prefix alone', () => {
    const enc = encryptSecret('sk-hello');
    assert.match(enc, /^enc1:/);
    assert.equal(decryptSecret(enc), 'sk-hello');
    assert.equal(decryptSecret('plain-legacy'), 'plain-legacy');
    assert.equal(encryptSecret(enc), enc);
  });
});
