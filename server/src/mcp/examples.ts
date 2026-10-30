import fs from 'node:fs';
import path from 'node:path';
import type { ScriptLanguage } from '../types';

export interface ExampleSummary {
  name: string;
  title: string;
  description: string;
  language: ScriptLanguage;
}

export interface ExampleContent extends ExampleSummary {
  code: string;
}

const EXAMPLES = [
  { name: 'straight', title: '最简直行脚本', description: '展示最小 init/move 接口与合法方向选择。', language: 'javascript' },
  { name: 'greedy-bfs', title: 'BFS 贪心寻路', description: '用广度优先搜索寻找食物，并避开当前障碍。', language: 'javascript' },
  { name: 'flood-fill', title: '空间评估脚本', description: '结合 BFS、洪泛填充和尾部变化评估生存空间。', language: 'javascript' },
  { name: 'team-aware', title: '组队协作脚本', description: '识别队友与敌人，在 2v2 中避敌、让路并争夺食物。', language: 'javascript' },
  { name: 'greedy-bfs-python', title: 'Python BFS 贪心寻路', description: 'Python 标准库 BFS，读取地图、穿墙和生命值字段寻食。', language: 'python' },
  { name: 'flood-fill-python', title: 'Python 空间评估脚本', description: 'Python 洪泛填充，结合生命值、空间、尾部和头对头风险。', language: 'python' },
] satisfies ExampleSummary[];

const examplesDir = path.resolve(__dirname, '../../../examples/scripts');

export function listExamples(language: ScriptLanguage = 'javascript'): ExampleSummary[] {
  return EXAMPLES.filter((example) => example.language === language).map((example) => ({ ...example }));
}

export function getExample(name: string): ExampleContent | null {
  const summary = EXAMPLES.find((example) => example.name === name);
  if (!summary) return null;
  return {
    ...summary,
    code: fs.readFileSync(path.join(examplesDir, summary.language === 'python'
      ? `${name.replace(/-python$/, '')}.py`
      : `${name}.js`), 'utf8'),
  };
}
