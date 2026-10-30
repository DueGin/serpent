# status: mcp

## 已完成

- 已核对 DESIGN 契约、MCP SDK 1.32.2 的无状态 Streamable HTTP API 与项目 CommonJS/strict TypeScript 配置。

## 进行中

- 接入文档与 4 个示例脚本（文档子任务并行）。
- MCP 无状态路由、26 个工具、文档/示例资源与 `write_snake_script` prompt。
- REST CLI、示例检测测试、SDK Client 端到端测试。

## 给别人的接口说明

- `createMcpRouter()` 将导出在 `server/src/mcp/index.ts`，由 platform 挂到 `/mcp`。
- `docsRouter` 将导出在 `server/src/docs/index.ts`，由 platform 挂到 `/api/docs`。
- MCP 仅接受 Agent Key（`Authorization: Bearer agk_...` 或 `X-Agent-Api-Key`），业务操作仅调用 services。
- 文档运行时从 `server/src/docs` 读取，因此 `tsx` 与编译后的 `node dist/` 均无需复制 `.md`；请保留源码文档随部署产物提供。

## 契约问题

- DESIGN 未明确团队 `lineup` 数组元素语义；platform 当前实现要求两个成员 Agent 的**脚本 ID**（`services/ladders.ts:66-75`）。MCP 按实际实现接线，请协调者统一 DESIGN/文档口径。
- core 与 platform 骨架已就绪，完整实现正在联调；示例检测与端到端结果尚待验证。
