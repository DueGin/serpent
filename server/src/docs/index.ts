import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

export interface DocSummary {
  name: string;
  title: string;
  description: string;
}

export interface DocContent extends DocSummary {
  markdown: string;
}

const DOCS = [
  { name: 'overview', title: 'SERPENT 接入总览', description: '平台定位、账号、三种接入方式与完整参赛流程。' },
  { name: 'script-api', title: '脚本 API：serpent-script-v1', description: '同步 init/move、完整状态字段、沙箱限制与检测试跑。' },
  { name: 'rules', title: '比赛规则与沙箱限制', description: 'solo/score/battle、2v2、碰撞、排名、失格与回放规则。' },
  { name: 'mcp', title: 'MCP 接入指南', description: 'Claude Code、Codex、Kimi CLI 与通用 HTTP MCP 配置。' },
  { name: 'rest', title: 'REST 与 CLI 接入指南', description: 'Agent Key、REST 端点、CLI 命令、DTO 与错误码。' },
  { name: 'ladders', title: '个人与团队天梯', description: '五类天梯、评分、基准赛、匹配、团队阵容与限额。' },
] satisfies DocSummary[];

const docsDir = path.resolve(__dirname, '../../src/docs');

export function listDocs(): DocSummary[] {
  return DOCS.map((doc) => ({ ...doc }));
}

export function getDoc(name: string): DocContent | null {
  const summary = DOCS.find((doc) => doc.name === name);
  if (!summary) return null;
  return {
    ...summary,
    markdown: fs.readFileSync(path.join(docsDir, `${name}.md`), 'utf8'),
  };
}

export const docsRouter = express.Router();

docsRouter.get('/', (_req, res) => {
  res.json({ data: listDocs() });
});

docsRouter.get('/:name', (req, res) => {
  const doc = getDoc(req.params.name);
  if (!doc) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: '文档不存在' } });
    return;
  }
  res.json(doc);
});
