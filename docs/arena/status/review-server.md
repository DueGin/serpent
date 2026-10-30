# 复盘服务端交付

日期：2026-10-30。接手已有未完成改动后逐项审查、保留正确实现并补齐回归验证；以 `docs/arena/REVIEW.md` 和协调者提供的共享类型为准。

## 完成内容

- runner 按观察帧 tick 记录紧凑决策码和两位小数耗时；包含失格直接结束比赛时没有对应 move 的最后一轮。遥测独立于 Replay，不消耗引擎或脚本 RNG。
- SQLite 迁移到 `user_version=3`，新增可空 `matches.trace_blob`，与回放一并 gzip 持久化；v2 历史回放原始字节保留，NULL 遥测可正常复盘。
- 纯函数复盘提供空间、安全方向、食物距离、每拍三个方向的引擎一步反事实、关键时刻、死亡归因、统计和中文建议。重放通过同一个可变 GameState 增量推进，未逐拍从头重放。
- 服务层提供 `matches.review()`、带 `review` 的 `matches.frame()`、`scripts.trend()`；每数据库最多 64 局 LRU 缓存公开分析，返回前追加对应所有者的日志和 firstError，再按 slot/series/from/to 裁剪。返回的嵌套数据不与缓存共享可变引用。
- REST 新增整局复盘和脚本趋势接口，query 使用 strict Zod 校验；MCP 增加两个工具、候选方向表和推荐流程；CLI 增加摘要/JSON 命令、脚本名或 ID 解析及参数校验。
- 注册复盘文档资源，并更新 REST、MCP、概览和 AGENTS.md 的参赛流程与接口地图。

## 文件清单

| 范围 | 文件 |
|---|---|
| 遥测和重放 | `server/src/runner/jobs.ts`、`server/src/runner/replay.ts` |
| 数据库 | `server/src/db.ts` |
| 纯函数分析 | `server/src/game/review.ts` |
| 业务服务 | `server/src/services/matches.ts`、`server/src/services/trends.ts`、`server/src/services/scripts.ts`、`server/src/services/index.ts` |
| REST | `server/src/routes/arena.ts`、`server/src/routes/schemas.ts` |
| MCP | `server/src/mcp/tools.ts`、`server/src/mcp/server.ts` |
| CLI | `server/src/cli/serpent.ts` |
| 文档 | `server/src/docs/review.md`、`server/src/docs/index.ts`、`server/src/docs/rest.md`、`server/src/docs/mcp.md`、`server/src/docs/overview.md`、`AGENTS.md` |
| 测试 | `server/src/game/review.test.ts`、`server/src/runner/trace.test.ts`、`server/src/runner/index.test.ts`、`server/src/review-rest.test.ts`、`server/src/auth.test.ts`、`server/src/mcp/mcp.test.ts` |

共享类型 `server/src/types.ts`、`server/src/api-types.ts` 使用协调者已有定义，没有新增或改变字段；没有修改 `web/**`。`mcp/register.ts` 编译边界保持原样。没有新增依赖，没有 commit/push，没有修改 `server/data/`。

## 指标及边界说明

- `space` 不含起点蛇头；阻挡格按契约排除尾尖、死亡蛇、队友，score 排除其他蛇且使用 wrap。`safeMoves` 是静态下一格检查，风险决策另用引擎反事实评估。
- 反事实深拷贝状态，使用独立 `seedRng(0)`；其他参赛者按该拍实际方向移动。结果只表示一步死亡/空间，不能保证未来安全。
- 回放帧包含本 tick 的 move 失格。失格的 `decisionTick=deathTick`，该帧已经死亡，依照 ReviewTick 仅适用于存活且有实际 move 的条件，init/move 失格的 `death.decision` 都为 null；move 失格当轮的决策码、耗时仍保留在 series 和统计中。
- `trappedSince` 取死亡前最后一段连续低空间的起点，脱困即重置；`lastTicks` 最多取死亡前 8 帧。同拍撞墙的对手在碰撞判定时仍可能是凶手，killerSlot 与引擎顺序一致。
- `from/to` 只裁剪逐拍序列，闭区间两端都保留；slot 裁剪参与者、时刻、序列和建议。摘要请求可以覆盖超过 5000 拍的整局，请求序列或显式区间时跨度不得超过 5000。
- 趋势窗口按不同对局计数，同一脚本同局占多个位置时取最小 slot 代表该局；versions 和 recent 使用相同的可见窗口。胜场仅按 `rank===1`，失败率分母为持久化的 move 决策数，平均耗时按该决策数加权。无逐拍遥测的历史局仍可使用已有聚合数据参与趋势。
- 耗时统计为非空脚本 move 耗时，P95 使用排序后 `ceil(n*0.95)-1` 对应值。无遥测或内置 bot 的逐拍耗时汇总为 null；没有 trace 的复盘决策计数为 0。

## 验证结果

环境：Node.js v22.23.1，pnpm 10.30.2。

| 验证 | 结果 |
|---|---|
| `pnpm --filter server test` | **175/175 通过**，18 个 suite，0 失败/取消/跳过，约 11.26 秒 |
| `cd server && npx tsc --noEmit` | **通过**，退出码 0，无诊断 |
| `git diff --check` | **通过** |
| MCP SDK 与真实 CLI/REST 集成 | 工具可发现、资源可读、返回结果/摘要/选项表、prompt、权限和非法参数覆盖；包含于全量测试 |
| 数据迁移与服务/REST 定向验证 | **19/19 通过**；含 v2 升级、旧 NULL trace、LRU 淘汰和返回对象污染隔离 |

遥测测试将无限循环超时和正常返回码分开测试，避免正常脚本在 2ms 的测试专用预算下受调度负载影响。另覆盖 error/invalid/reverse/ok/builtin/dead、非连续 slot、自然死亡、初始化失格和终局多一轮。

实际在内存转译并运行无遥测的旧版 runner，与当前 runner 比较两组含脚本局面的 Replay JSON 字节，均完全一致；测试保留旧版 SHA-256 作为回归基线：

- 双脚本连续非法、tick 49 失格：`99e16c64adf04a3155ea5f82c9187d13804fce52955eccc31baaa3ec6c81739b`。
- 含脚本随机选择和 greedy 吃食物的 60 拍对局：`33deab2ee828b1b027e8522b1abeab77051935923a264144d6792f2409d18`。

全量测试日志：`/tmp/serpent-review-tests-final.log`；tsc 日志：`/tmp/serpent-review-tsc-final.log`。

## 性能实测

基准：28×20、4 条存活蛇、1000 拍 battle，食物为 0，蛇沿固定安全环移动，整局计算 12000 次反事实一步推演；使用完整复盘入口计算所有序列、统计、时刻和建议，不命中缓存。

- 最终独立运行：**135.11ms**，达到小于 300ms 的目标；此前独立运行 134.42ms、143.99ms。
- 最终全套并行测试负载下：**440.62ms**；宽松 CI 断言为小于 1500ms，验证通过。
- 独立性能命令：`cd server && pnpm exec tsx --test --test-name-pattern '1000-tick' src/game/review.test.ts`。
- 性能日志：`/tmp/serpent-review-performance-final.log`。该测量对应固定基准，不代表所有身长和食物布局下的最坏耗时。

## 遗留问题

本次服务端契约无未完成项。前端由并行工人负责，本交付未修改或验证前端构建。集成测试使用自动分配的本机端口和内存数据库，服务及 runner 在测试结束后关闭；没有启动 8008/3308/8112 常驻服务。
