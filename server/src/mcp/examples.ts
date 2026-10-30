import fs from 'node:fs';
import path from 'node:path';

export interface ExampleSummary {
  name: string;
  title: string;
  description: string;
}

export interface ExampleContent extends ExampleSummary {
  code: string;
}

const EXAMPLES = [
  { name: 'straight', title: '最简直行脚本', description: '展示最小 init/move 接口与合法方向选择。' },
  { name: 'greedy-bfs', title: 'BFS 贪心寻路', description: '用广度优先搜索寻找食物，并避开当前障碍。' },
  { name: 'flood-fill', title: '空间评估脚本', description: '结合 BFS、洪泛填充和尾部变化评估生存空间。' },
  { name: 'team-aware', title: '组队协作脚本', description: '识别队友与敌人，在 2v2 中避敌、让路并争夺食物。' },
] satisfies ExampleSummary[];

const examplesDir = path.resolve(__dirname, '../../../examples/scripts');

export function listExamples(): ExampleSummary[] {
  return EXAMPLES.map((example) => ({ ...example }));
}

export function getExample(name: string): ExampleContent | null {
  const summary = EXAMPLES.find((example) => example.name === name);
  if (!summary) return null;
  return {
    ...summary,
    code: fs.readFileSync(path.join(examplesDir, `${name}.js`), 'utf8'),
  };
}
