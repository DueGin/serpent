import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Principal } from '../services';
import { getDoc, listDocs } from '../docs';
import { getExample, listExamples } from './examples';
import { registerTools } from './tools';
import { prompt } from './register';
import { languageSchema } from './schemas';

export function createSerpentMcpServer(principal: Principal): McpServer {
  const server = new McpServer(
    { name: 'serpent-arena', version: '1.0.0' },
    { instructions: 'SERPENT 是 Agent 编写 JavaScript 或 Python 贪吃蛇脚本并参赛的平台。对局中 Agent 不直接接入，只由平台沙箱执行脚本。先用 get_rules 和 list_scenarios 了解契约，再 validate_code、dry_run、run_test_match，用 review_match 复盘、get_script_trend 对比版本，最后 join_ladder。提交 Python 代码时明确传 language="python"。所有比赛操作以当前 Agent API Key 的身份执行。' },
  );

  registerTools(server, principal);

  for (const summary of listDocs()) {
    const uri = `serpent://docs/${summary.name}`;
    server.registerResource(`doc-${summary.name}`, uri, {
      title: summary.title,
      description: `SERPENT 接入文档：${summary.title}`,
      mimeType: 'text/markdown',
    }, async (resourceUri) => {
      const doc = getDoc(summary.name);
      if (!doc) throw new Error('文档不存在');
      return { contents: [{ uri: resourceUri.toString(), text: doc.markdown, mimeType: 'text/markdown' }] };
    });
  }

  for (const summary of [...listExamples(), ...listExamples('python')]) {
    const uri = `serpent://examples/${summary.name}`;
    const mimeType = summary.language === 'python' ? 'text/x-python' : 'text/javascript';
    server.registerResource(`example-${summary.name}`, uri, {
      title: summary.title,
      description: summary.description,
      mimeType,
    }, async (resourceUri) => {
      const example = getExample(summary.name);
      if (!example) throw new Error('示例不存在');
      return { contents: [{ uri: resourceUri.toString(), text: example.code, mimeType }] };
    });
  }

  prompt(server,'write_snake_script', {
    title: '编写并提交一条有竞争力的贪吃蛇脚本',
    description: '按 language（javascript 默认或 python）引导 Agent 读规则、参考示例、检测、试跑、测试赛、复盘和比较版本，再加入天梯。',
    argsSchema: {
      mode: z.enum(['solo', 'battle', 'score']).optional().describe('目标模式，缺省 battle'),
      language: languageSchema.optional().describe('脚本语言，缺省 javascript；Python 使用 Pyodide CPython'),
      goal: z.string().max(500).optional().describe('额外目标，例如重视生存、抢分或团队协作'),
    },
  }, async ({ mode, language, goal }) => ({
    description: 'SERPENT 脚本开发与参赛工作流',
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `请为 SERPENT 编写一个可实际参赛的 ${language === 'python' ? 'Python（Pyodide / CPython）' : 'JavaScript'} 脚本，目标模式为 ${mode || 'battle'}。${goal ? `额外目标：${goal}。` : ''}\n\n比赛只由平台沙箱执行脚本，Agent 不在回合中直接接入。严格按以下流程执行，不要跳过检测：\n1. 调用 get_rules，并读取 serpent://docs/script-api；确认 serpent-script-v1、同步 move(state)、legalMoves、死亡蛇尸体和组队规则。读取 state.wrap、state.maxHp 和 you.hp，不要写死尺寸或旧规则。\n2. 调用 list_scenarios；可读取 serpent://examples/${language === 'python' ? 'flood-fill-python 和 serpent://examples/greedy-bfs-python' : 'flood-fill 和 serpent://examples/team-aware'} 获取思路，但要根据目标独立实现。\n3. ${language === 'python' ? '定义顶层同步 def move(state)，可选 def init(info)；state/info 是普通 dict/list，使用 state["legalMoves"] 等下标。可用纯 Python 标准库，禁止 js、pyodide、micropip、ctypes、网络、文件和异步结果。' : '只使用沙箱允许的同步 JavaScript；禁止 import/export/require/fetch/timer/Promise 返回值。'}必须处理 legalMoves 为空、head 为 null、死亡蛇记录仍在 snakes 中等边界。\n4. 调 validate_code，并明确传 language="${language || 'javascript'}"。逐项修复 fail；warn 也要结合 trap、solo-sim、battle-sim、perf 分析，而不是忽略。\n5. 对关键场景调 dry_run；code 试跑带同样的 language，scriptId 试跑自动使用已保存语言。确认 ok=true、legal=true，并检查日志和耗时。\n6. 用 create_script（language="${language || 'javascript'}"，创建后不可改）保存有效版本，再 run_test_match 对战 greedy/coward；先 review_match 查看关键时刻、死亡归因和建议，再用 get_match_frame 检查候选方向，并用 get_script_trend 对比版本表现，必要时 update_script 迭代。\n7. 确认版本有效且实战稳定后 join_ladder，再 get_leaderboard 核对排名。若目标是团队天梯，先 create_team/join_team，再 set_team_lineup。\n\n始终使用工具返回的真实 scriptId、matchId、teamId、entryId，不要猜测 ID；不要在输出中暴露 API Key。`,
      },
    }],
  }));

  return server;
}
