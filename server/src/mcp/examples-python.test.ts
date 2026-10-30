import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { dryRun, shutdownRunner, validateScript } from '../runner';
import type { ScriptState, SnakeView } from '../types';
import { getExample, listExamples } from './examples';

after(async () => {
  await shutdownRunner();
});

function stateFor(options: { wrap?: boolean; survival?: boolean; mode?: 'solo' | 'score' | 'battle' } = {}): ScriptState {
  const maxHp = options.survival === false ? null : 100;
  const you: SnakeView = {
    id: 'snake-0', slot: 0, name: 'python', team: null, alive: true, score: 0,
    dir: 'right', length: 3, hp: maxHp === null ? null : 2,
    head: { x: 3, y: 3 }, body: [{ x: 3, y: 3 }, { x: 2, y: 3 }, { x: 1, y: 3 }],
  };
  return {
    protocol: 'serpent-script-v1', tick: 0, maxTicks: 100, remainingTicks: 100,
    width: 8, height: 8, wrap: options.wrap ?? false, maxHp,
    mode: options.mode ?? 'solo', teams: false, targetScore: null,
    you, snakes: [you], foods: [{ x: 4, y: 3 }], legalMoves: ['up', 'right', 'down'],
  };
}

function pythonExample(name: string): string {
  const example = getExample(name);
  assert.ok(example, `缺少 Python 示例 ${name}`);
  assert.equal(example.language, 'python');
  return example.code;
}

test('Python 示例资源与 JavaScript 资源保持独立', () => {
  assert.equal(listExamples().length, 4);
  assert.deepEqual(listExamples('python').map((example) => example.name), ['greedy-bfs-python', 'flood-fill-python']);
  assert.equal(getExample('greedy-bfs')?.language, 'javascript');
  assert.equal(getExample('../package.json'), null);
  assert.equal(getExample('flood-fill.py'), null);
});

test('Python 官方示例完整检测通过', { timeout: 300_000 }, async (t) => {
  for (const summary of listExamples('python')) {
    await t.test(summary.name, { timeout: 150_000 }, async () => {
      const report = await validateScript(pythonExample(summary.name), 'python');
      assert.equal(report.ok, true, report.items.filter((item) => item.status === 'fail')
        .map((item) => `${item.id}: ${item.detail || item.label}`).join('\n'));
    });
  }
});

test('Python 示例读取生命值与实际地图，classic/survival 都向可达食物移动', { timeout: 120_000 }, async () => {
  for (const summary of listExamples('python')) {
    const code = pythonExample(summary.name);
    for (const survival of [true, false]) {
      const result = await dryRun({ code, language: 'python', state: stateFor({ survival }) });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.legal, true, JSON.stringify(result));
      assert.equal(result.direction, 'right', summary.name);
    }
    const wrapped = stateFor({ survival: false, wrap: true, mode: 'score' });
    wrapped.you.head = { x: 7, y: 3 };
    wrapped.you.body = [{ x: 7, y: 3 }, { x: 6, y: 3 }, { x: 5, y: 3 }];
    wrapped.foods = [{ x: 0, y: 3 }];
    const result = await dryRun({ code, language: 'python', state: wrapped });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.direction, 'right', `${summary.name} 没有读取 wrap`);
  }
});

test('Python flood-fill 在新规则 score 中避开更长敌蛇的迎头格', { timeout: 60_000 }, async () => {
  const state = stateFor({ mode: 'score' });
  state.you.hp = 100;
  state.snakes.push({
    id: 'snake-1', slot: 1, name: 'enemy', team: null, alive: true, score: 0,
    dir: 'left', length: 4, hp: 100, head: { x: 5, y: 3 },
    body: [{ x: 5, y: 3 }, { x: 6, y: 3 }, { x: 6, y: 4 }, { x: 7, y: 4 }],
  });
  const result = await dryRun({ code: pythonExample('flood-fill-python'), language: 'python', state });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.notEqual(result.direction, 'right', '与更长敌蛇争抢迎头格');
});

test('Python 示例在 64×64 地图上完成真实空间搜索且不超时', { timeout: 60_000 }, async (t) => {
  for (const summary of listExamples('python')) {
    const code = pythonExample(summary.name);
    const state = stateFor();
    state.width = 64;
    state.height = 64;
    state.you.hp = 100;
    state.foods = [{ x: 4, y: 3 }, { x: 55, y: 55 }, { x: 60, y: 4 }, { x: 4, y: 60 }];
    const result = await dryRun({ code, language: 'python', state });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.legal, true);
    assert.equal(result.direction, 'right');
    t.diagnostic(`${summary.name}: init=${result.initMs}ms move=${result.moveMs}ms`);
  }
});

test('Python flood-fill 在自己更长时可争抢迎头格食物', { timeout: 60_000 }, async () => {
  const state = stateFor({ mode: 'score' });
  state.you.hp = 100;
  state.you.length = 5;
  state.you.body.push({ x: 0, y: 3 }, { x: 0, y: 4 });
  state.snakes.push({
    id: 'snake-1', slot: 1, name: 'enemy', team: null, alive: true, score: 0,
    dir: 'left', length: 4, hp: 100, head: { x: 5, y: 3 },
    body: [{ x: 5, y: 3 }, { x: 6, y: 3 }, { x: 6, y: 4 }, { x: 7, y: 4 }],
  });
  const result = await dryRun({ code: pythonExample('flood-fill-python'), language: 'python', state });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.direction, 'right');
});
