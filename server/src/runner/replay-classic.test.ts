import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Frame, Replay } from '../types';
import { replayFrames } from './replay';

const fixtureDir = join(__dirname, 'fixtures');
for (const name of ['scoreWrap', 'battleHead', 'foodRng', 'disqualified']) {
  test(`classic ${name} engine-2 frames remain byte-for-byte unchanged`, () => {
    const fixture = JSON.parse(readFileSync(join(fixtureDir, `classic-${name}.json`), 'utf8')) as { replay: Replay; frames: Frame[] };
    assert.equal(fixture.replay.engine, 'serpent-engine-2');
    assert.deepEqual(replayFrames(fixture.replay), fixture.frames);
  });
}
