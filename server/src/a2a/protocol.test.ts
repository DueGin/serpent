import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyIntent, parseIntent, upsertTask } from './protocol';
import { GameManager } from '../game/manager';

describe('parseIntent', () => {
  it('parses chinese and english actions', () => {
    assert.deepEqual(parseIntent('up'), { type: 'act', direction: 'up' });
    assert.deepEqual(parseIntent('向左'), { type: 'act', direction: 'left' });
    assert.deepEqual(parseIntent('play solo'), { type: 'create', mode: 'solo' });
    assert.deepEqual(parseIntent('创建对战'), { type: 'create', mode: 'battle' });
    assert.deepEqual(parseIntent('join AB12'), { type: 'join', room: 'AB12' });
    assert.deepEqual(parseIntent('观察'), { type: 'observe' });
    assert.deepEqual(
      parseIntent('', { action: 'act', direction: 'down' }),
      { type: 'act', direction: 'down' },
    );
  });
});

describe('A2A play loop', () => {
  it('creates a solo game and accepts a move', () => {
    const manager = new GameManager();
    const agent = manager.registerAgent('unit-bot');
    const task = upsertTask({ agentId: agent.id, playerId: agent.id });
    const created = applyIntent(manager, task, { type: 'create', mode: 'solo' }, agent.name);
    assert.ok(created.observation);
    assert.ok(created.task.roomCode);
    assert.equal(created.observation!.mode, 'solo');
    const moved = applyIntent(manager, task, { type: 'act', direction: 'up' }, agent.name);
    assert.ok(moved.observation);
    assert.equal(moved.observation!.you.alive, true);
    manager.getRoom(created.task.roomCode!).stop();
  });
});
