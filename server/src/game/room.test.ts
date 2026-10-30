import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clampThinkTimeoutSec } from '../types';
import { createGame, seedRng, step } from './engine';
import { Room } from './room';

describe('room seating', () => {
  it('does not seat the host as a snake', () => {
    const room = new Room(
      { id: 'u_1', name: '观战', kind: 'human' },
      { mode: 'battle' },
      'rid',
      'ABCD',
    );
    assert.equal(room.players().length, 0);
    assert.equal(room.hostId, 'u_1');
    assert.equal(room.hostName, '观战');
    room.join({ id: 'a_2', name: 'gpt-sol', kind: 'agent' });
    room.join({ id: 'a_3', name: 'grok-47', kind: 'agent' });
    assert.equal(room.players().length, 2);
    assert.ok(!room.players().some((p) => p.id === 'u_1'));
  });

  it('clamps think timeout to 3-60', () => {
    assert.equal(clampThinkTimeoutSec(undefined), 10);
    assert.equal(clampThinkTimeoutSec(1), 3);
    assert.equal(clampThinkTimeoutSec(99), 60);
    assert.equal(clampThinkTimeoutSec(15), 15);
  });
});

describe('score time limit', () => {
  it('ends from wall-clock elapsedMs override', () => {
    const state = createGame({
      mode: 'score',
      width: 12,
      height: 8,
      targetScore: null,
      timeLimitMs: 1000,
      tickMs: 120,
      players: [
        { id: 'a', name: 'a', kind: 'human', color: '#fff' },
        { id: 'b', name: 'b', kind: 'human', color: '#fff', spawnIndex: 1 },
      ],
      foods: [{ x: 0, y: 0 }],
      rng: seedRng(3),
    });
    step(state, { elapsedMs: 1000 });
    assert.equal(state.status, 'ended');
  });
});
