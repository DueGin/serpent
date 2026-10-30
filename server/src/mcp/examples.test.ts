import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { getExample, listExamples } from './examples';
import { defaultConfig, shutdownRunner, simulate, validateScript } from '../runner';

after(async () => {
  await shutdownRunner();
});

test('全部示例通过 validateScript', { timeout: 180_000 }, async (t) => {
  for (const summary of listExamples()) {
    await t.test(summary.name, { timeout: 180_000 }, async () => {
      const example = getExample(summary.name);
      assert.ok(example, `缺少示例 ${summary.name}`);
      const report = await validateScript(example.code);
      assert.equal(report.ok, true, report.items
        .filter((item) => item.status === 'fail')
        .map((item) => `${item.id}: ${item.detail || item.label}`)
        .join('\n'));
    });
  }
});

test('flood-fill 在固定 seed 的 battle 中优于内置 greedy', { timeout: 180_000 }, async () => {
  const example = getExample('flood-fill');
  assert.ok(example);
  const seeds = [41, 173, 509, 907, 1601, 3001];
  let floodPoints = 0;
  let greedyPoints = 0;
  let summary = '';

  for (let index = 0; index < seeds.length; index += 1) {
    const seed = seeds[index];
    assert.ok(seed !== undefined);
    const floodFirst = index % 2 === 0;
    const participants = floodFirst
      ? [
          { slot: 0, name: 'flood-fill', team: null, source: { kind: 'script' as const, code: example.code } },
          { slot: 1, name: 'greedy', team: null, source: { kind: 'builtin' as const, bot: 'greedy' as const } },
        ]
      : [
          { slot: 0, name: 'greedy', team: null, source: { kind: 'builtin' as const, bot: 'greedy' as const } },
          { slot: 1, name: 'flood-fill', team: null, source: { kind: 'script' as const, code: example.code } },
        ];
    const result = await simulate({
      config: defaultConfig('battle', { seed, maxTicks: 500, players: 2 }),
      participants,
      captureLogs: false,
    });
    const flood = result.participants.find((participant) => participant.slot === (floodFirst ? 0 : 1));
    const greedy = result.participants.find((participant) => participant.slot === (floodFirst ? 1 : 0));
    assert.ok(flood && greedy);
    floodPoints += flood.rank < greedy.rank ? 2 : flood.rank === greedy.rank ? 1 : 0;
    greedyPoints += greedy.rank < flood.rank ? 2 : greedy.rank === flood.rank ? 1 : 0;
    summary += `seed=${seed} flood(rank=${flood.rank},score=${flood.score},alive=${flood.alive}) greedy(rank=${greedy.rank},score=${greedy.score},alive=${greedy.alive})\n`;
  }

  assert.ok(floodPoints > greedyPoints, `flood-fill ${floodPoints} 分，greedy ${greedyPoints} 分\n${summary}`);
});
