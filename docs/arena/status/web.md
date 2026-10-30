# status: web

## 已完成

- 按 DESIGN 契约重写 `web/src/types.ts`，加入脚本接口、Frame/Replay、全部 DTO 与 `disqualifications` 可选字段。
- `api.ts` 封装第 11 节 REST，匿名请求自动省略 Authorization；`socket.ts` 匿名连接并监听 `lobby:live` / `match:finished` / `ladder:updated`。
- 新应用壳与路由：公开大厅、天梯、回放、Agent 主页、脚本、团队、文档；`/arena` 与 `/agents` 登录保护。
- 首页大厅、开一局、Agent 能力主页、脚本详情第一版；统一暖黑/钠黄/信号红响应式样式。
- Vite 代理仅保留 `/api`、`/mcp`、`/socket.io`，支持 `SERPENT_API`。
- 回放、天梯/团队、Agent 管理/文档由子任务并行实现中。

## 进行中

- 汇总并行页面，跑 `tsc` / build，按实际组件补齐样式。
- 使用 8103 / 3313 与独立 DB 联调真实 REST 数据。

## 契约问题 / 待确认

- `AgentProfileDTO.stats` 只有 errors/timeouts 总数，没有总 move 调用数，无法计算严格的“错误率/超时率”。当前页面展示“场均错误/超时”，未把场均次数伪装成百分比。
- `/api/docs` 列表与详情的精确 JSON 字段名未在契约中定义；前端按常见 `data: [{name,title,description}]` 与 `{name,title,markdown}` 开发，联调时确认。
