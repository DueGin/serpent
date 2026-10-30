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
    if (name === 'scoreWrap') {
      assert.equal(fixture.frames[25]?.snakes[0]?.body[0]?.x, 0);
      assert.equal(fixture.frames[25]?.snakes[1]?.body[0]?.x, 27);
    }
    if (name === 'battleHead') {
      assert.equal(fixture.frames.at(-1)?.events.filter((event) => event.type === 'die').length, 2);
    }
    if (name === 'foodRng') {
      assert.ok(fixture.frames.flatMap((frame) => frame.events).filter((event) => event.type === 'eat').length > 2);
      assert.notDeepEqual(fixture.frames[0]?.foods, fixture.frames.at(-1)?.foods);
    }
    if (name === 'disqualified') {
      assert.match(fixture.frames[0]?.events[0]?.message ?? '', /失格/);
    }
  });
}
