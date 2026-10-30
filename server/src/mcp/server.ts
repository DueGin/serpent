import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Principal } from '../services';
import { getDoc, listDocs } from '../docs';
import { getExample, listExamples } from './examples';
import { registerTools } from './tools';
import { prompt } from './register';

export function createSerpentMcpServer(principal: Principal): McpServer {
  const server = new McpServer(
    { name: 'serpent-arena', version: '1.0.0' },
    { instructions: 'SERPENT 是 Agent 编写 JavaScript 贪吃蛇脚本并参赛的平台。先用 get_rules 和 list_scenarios 了解契约，再 validate_code、dry_run、run_test_match，用 review_match 复盘、get_script_trend 对比版本，最后 join_ladder。所有比赛操作以当前 Agent API Key 的身份执行。' },
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

  for (const summary of listExamples()) {
    const uri = `serpent://examples/${summary.name}`;
    server.registerResource(`example-${summary.name}`, uri, {
      title: summary.title,
      description: summary.description,
      mimeType: 'text/javascript',
    }, async (resourceUri) => {
      const example = getExample(summary.name);
      if (!example) throw new Error('示例不存在');
      return { contents: [{ uri: resourceUri.toString(), text: example.code, mimeType: 'text/javascript' }] };
    });
  }

  prompt(server,'write_snake_script', {
    title: '编写并提交一条有竞争力的贪吃蛇脚本',
    description: '引导 Agent 读规则、参考示例、检测、试跑、测试赛、复盘和比较版本，再加入天梯。',
    argsSchema: {
      mode: z.enum(['solo', 'battle', 'score']).optional().describe('目标模式，缺省 battle'),
      goal: z.string().max(500).optional().describe('额外目标，例如重视生存、抢分或团队协作'),
    },
  }, async ({ mode, goal }) => ({
    description: 'SERPENT 脚本开发与参赛工作流',
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `请为 SERPENT 编写一个可实际参赛的 JavaScript 脚本，目标模式为 ${mode || 'battle'}。${goal ? `额外目标：${goal}。` : ''}\n\n严格按以下流程执行，不要跳过检测：\n1. 调用 get_rules，并读取 serpent://docs/script-api；确认 serpent-script-v1、同步 move(state)、legalMoves、死亡蛇尸体和组队规则。\n2. 调用 list_scenarios；可读取 serpent://examples/flood-fill 和 serpent://examples/team-aware 获取思路，但要根据目标独立实现。\n3. 只使用沙箱允许的同步 JavaScript；禁止 import/export/require/fetch/timer/Promise 返回值。必须处理 legalMoves 为空、head 为 null、死亡蛇记录仍在 snakes 中等边界。\n4. 调 validate_code。逐项修复 fail；warn 也要结合 trap、solo-sim、battle-sim、perf 分析，而不是忽略。\n5. 对关键场景调 dry_run，确认 ok=true、legal=true，并检查日志和耗时。\n6. 用 create_script 保存有效版本，再 run_test_match 对战 greedy/coward；先 review_match 查看关键时刻、死亡归因和建议，再用 get_match_frame 检查候选方向，并用 get_script_trend 对比版本表现，必要时 update_script 迭代。\n7. 确认版本有效且实战稳定后 join_ladder，再 get_leaderboard 核对排名。若目标是团队天梯，先 create_team/join_team，再 set_team_lineup。\n\n始终使用工具返回的真实 scriptId、matchId、teamId、entryId，不要猜测 ID；不要在输出中暴露 API Key。`,
      },
    }],
  }));

  return server;
}
