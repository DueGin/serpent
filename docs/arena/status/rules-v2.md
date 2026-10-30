# 规则工人 A 状态：survival-64

## 完成

- 引擎版本 `serpent-engine-3`，默认规则为 64×64 有边界、HP 100、每人 4 果实、score/battle 同步碰撞。撞墙、自撞、他蛇身、同格/交换头对头（移动前身长比较）、队友穿行、死亡旧身本拍/下拍语义、击杀和第 100 拍饥饿均有测试。
- `serpent-engine-2` 回放按 classic 规则重放；四套冻结 fixture 覆盖 score 穿墙、battle 双亡、14 次进食补齐与 RNG、初始化失格。两个旧 trace 哈希均保持通过。classic 模拟仍写 engine-2 标记，survival 写 engine-3。
- 天梯配置从 `defaultConfig` 生成；每局人数决定果实数，旧存储配置经 `normalizeConfig`；复盘提供 HP 序列、minHp、lowHpTicks、低 HP 饥饿时刻及死亡建议，趋势只统计 survival-64。更新 bot、场景、benchmark、JS 示例和规则/天梯/复盘文档。
- `score-wrap` 场景更名 `edge-wall`，保留 `trap-one-exit`，新增低 HP 与长/短头对头场景。未改共享类型、数据库迁移或前端/Python 文件。

## 文件清单

- 引擎/测试：`server/src/game/engine.ts`、`bot.ts`、`review.ts`、`review.test.ts`、`survival.test.ts`。
- runner/fixture：`server/src/runner/config.ts`、`replay.ts`、`replay-classic.test.ts`、`fixtures/classic-*.json`、`scenarios.ts`、`benchmark.ts`、`index.test.ts`；为维护 classic trace 字节兼容，`runner/jobs.ts` 仅一处改动按规则集选择回放版本（此文件原归工人 B，合并时需协调者检查）。
- 天梯：`server/src/services/ladders.ts`、`trends.ts`、`server/src/db.ts` 的 `seedLadders`。
- 示例/文档：`examples/scripts/greedy-bfs.js`、`flood-fill.js`、`team-aware.js`、`server/src/mcp/examples.test.ts`（沿用固定 seed 严格占优断言）、`server/src/docs/rules.md`、`ladders.md`、`review.md`。

## 取舍与兼容

- `createGame` 保留可注入食物与非标准配置，方便测试/历史回放；默认配置及天梯严格为 survival-64。classic 走独立的旧结算路径，不改变旧行为。
- 头对头胜者只豁免其击败者本拍身体，仍受其他敌蛇身体阻挡。撞墙者旧身在本拍有效，死亡后下一拍不阻挡。
- 示例 64×64 用限制搜索步数的寻食 BFS 配合洪泛空间评估，避免 QuickJS move 超时；对低 HP 优先食物。文档有 `hadSafeAlternative`/`trappedSince` 说明。

## 验证

- `pnpm --filter server test`：187/187 通过，0 失败（含 2 个旧 trace 哈希、4 个 classic 回放 fixture、8 个 survival 新测试、JS 示例 validateScript 和固定六 seed 对 greedy 严格占优）。
- `cd server && npx tsc --noEmit`：通过；`cd web && npx tsc --noEmit`：通过；`pnpm build`：server tsc + web Vite 成功（96 模块）。
- `cd server && npx tsx src/runner/benchmark.ts`：64×64 四人模拟 seed=132，409 拍，模拟 313.187ms、总耗时 360ms；四脚本 errors/timeouts/invalidMoves 全 0，最高 move 1.574ms。
- 构造 64×64、4 人、1000 拍、无食物、`maxHp=2000` 的完整 survival 回放，`buildMatchReview` 实测 1125.10ms，低于 1500ms；该非标准 HP 仅用于确保完整千拍以测最坏复盘量，不是正式默认规则。
- 未启动 HTTP 联调服务；没有占用 8008/3308/8121 或遗留进程。

## 遗留/集成提醒

- 工人 B 的 Python runner 改动应保留 `runner/jobs.ts` 的 classic engine-2 / survival engine-3 标记逻辑；合并后重跑两个 trace 哈希和 fixture。
- 跨 worktree 合并时共享类型/API、数据库迁移由协调者维护；历史 score/battle 回放必须继续走 classic。状态文件位于协调者归属的 `docs/arena/**`，本轮按交付要求单独生成。

## 2026-10-31 JS 示例性能跟进

- 先快进合并 `master`（`b812f42`，含撞身体 slot 顺序修复和前端）。仅修改三个 JS 策略、示例测试、benchmark 与此状态文件。
- 三个寻路脚本使用每局复用的 `Int32Array` 邻接索引、`Uint8Array` 棋盘/访问位图和整数 BFS 队列；寻食 BFS 最多处理 2400 个节点，空间洪泛达到 `max(64, 2 * (身长 + 3))` 后停止。组队脚本一次寻食 BFS 做队友竞争评估，不再按方向计算队友/敌人的距离图。
- 本机 M 系列，64×64、4 人、1000 拍，battle/team-battle 各 seed 41、173、509（共 6 局），加权平均 / 六局最大单拍，单位 ms：`straight` 0.068–0.104 / 1.093；`greedy-bfs` 0.206–0.210 / 5.477；`flood-fill` 0.982–1.015 / 8.472；`team-aware` 0.986–1.014 / 8.060。六局所有脚本 timeouts/errors 均为 0；每脚本平均 <3ms、峰值 <10ms。
- 改前实测（协调者反馈）：`greedy-bfs` 平均 1.2 / 峰值 8；`flood-fill` 平均 2–2.5 / 偶发 21；`team-aware` 平均 24 / 峰值 31、整局 CPU 3.6–5.4s。优化后分别约 0.21 / 5.48、约 1.0 / 8.47、约 1.0 / 8.06；`straight` 无改前基线。
- `examples.test.ts` 保留全部 validateScript 与固定六 seed flood-fill 严格优于 greedy，新增固定 seed 中 flood-fill 零超时及四示例在三 seed 的 battle/team-battle 零超时。`pnpm --filter server test` 189/189 通过；`cd server && npx tsc --noEmit` 通过。`benchmark.ts` 现打印各模式、种子、脚本的 avg/max 和超时数。
