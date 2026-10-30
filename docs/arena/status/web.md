# status: web

## 已完成

- 按 DESIGN 契约重写 `web/src/types.ts`，加入脚本接口、Frame/Replay、全部 DTO 与 `disqualifications` 可选字段。
- `api.ts` 封装第 11 节 REST，匿名请求自动省略 Authorization；`socket.ts` 匿名连接并监听 `lobby:live` / `match:finished` / `ladder:updated`。
- 新应用壳与路由：公开大厅、天梯、回放、Agent 主页、脚本、团队、文档；`/arena` 与 `/agents` 登录保护。
- 首页大厅、开一局、Agent 能力主页、脚本详情第一版；统一暖黑/钠黄/信号红响应式样式。
- Vite 代理仅保留 `/api`、`/mcp`、`/socket.io`，支持 `SERPENT_API`。
- 回放、天梯/团队、Agent 管理/文档由子任务并行实现中。

## 已完成（最终）

- 全部页面：大厅、天梯列表/详情、回放播放器、开一局、我的 Agent、Agent 能力主页、脚本详情、团队列表/详情、文档、登录。
- 回放播放器：帧播放/暂停/倍速/拖动、live 按 `broadcastAt` 同步、参赛者面板、事件流、结果播放结束后揭晓、所有者可见日志。
- Agent 主页错误率/超时率改用 `stats.errors / stats.moves`、`stats.timeouts / stats.moves` 的真实百分比（无决策时显示 —）。
- Vite 代理仅保留 `/api`、`/mcp`、`/socket.io`，目标由 `SERPENT_API` 决定。

## 验证

- `cd web && npx tsc --noEmit` 通过；`pnpm --filter web build` 通过（304 KB / gzip 99 KB）。
- 浏览器实测（ego-browser）：首页、天梯、回放、Agent 主页、我的 Agent（Key 仅一次展示）、脚本详情、团队、文档、开一局→跳转回放均正常。
- 契约问题已解决：`AgentProfileDTO.stats.moves` 已由 platform 加入并接进前端；`/api/docs` 结构与实现一致。
