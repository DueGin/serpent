import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { jevEndpoint, pickJevDirection, pickLayaDirection } from './llm-client';

describe('jev protocol', () => {
  it('builds the TypeSafe systemone endpoint', () => {
    assert.equal(jevEndpoint('https://api.typesafe.ai'), 'https://api.typesafe.ai/v1/systemone');
    assert.equal(jevEndpoint('https://api.typesafe.ai/v1'), 'https://api.typesafe.ai/v1/systemone');
    assert.equal(jevEndpoint('https://api.typesafe.ai/v1/systemone'), 'https://api.typesafe.ai/v1/systemone');
  });

  it('picks the highest noul among legal directions', () => {
    const dir = pickJevDirection({
      up: { type: 'noul', noul: 0.2 },
      down: { type: 'noul', noul: 0.9 },
      left: { type: 'noul', noul: 0.95 },
      right: { type: 'noul', noul: 0.1 },
    }, ['up', 'down', 'right']);
    assert.equal(dir, 'down');
  });

  it('reads a Laya choice answer and falls back to probabilities', () => {
    assert.equal(pickLayaDirection({
      type: 'choice',
      choice: 'left',
      probabilities: { left: 0.7, right: 0.3 },
    }, ['left', 'right']), 'left');
    assert.equal(pickLayaDirection({
      type: 'choice',
      probabilities: { up: 0.1, down: 0.8 },
    }, ['up', 'down']), 'down');
  });
});
