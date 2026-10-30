# Platform 交叉审查

- 基线：`5384e91`；对照 DESIGN 第 6~11 节。仅只读审查实现，未修改 platform 代码、未执行 git 写操作。
- 结论：确认 2 个高置信问题：团队引用 private 脚本越权、关闭后排队基准任务仍启动。
- 复现环境：Node v22.23.1，`LADDER_AUTO=0 RUNNER_WORKERS=1`，真实 runner、内存 SQLite；临时脚本由 `pnpm --filter server exec tsx /tmp/serpent-review-platform.cjs` 执行，已删除。

## 发现

### 1. [P1][高] 队长可未经授权使用其他队员的 private 脚本参赛

- 位置：`server/src/services/ladders.ts:67`、`server/src/services/ladders.ts:74`；执行绕过点：`server/src/services/matches.ts:151`。
- 问题：`validLineup` 只验证队长身份、有效版本和队员关系，不验证脚本可见性/所有权；随后内部天梯比赛跳过 private 权限检查。
- 触发：用户 A 的 Agent 是队长，用户 B 的 Agent 加入其队伍；B 有有效的 private 脚本 S。A 的 Agent Key 直接读取 S 得 NOT_FOUND，直接创建含 S 的测试赛得 FORBIDDEN，但调用 `ladders.join(p, 'team-battle', {teamId, lineup:[A的脚本ID,S]})` 成功，随后 `queue` 真正执行 S。
- 实测：队伍 entryId=12；对局 id=1、status=done，participants 中包含 B 的 `private-member` 脚本。使用真实脚本执行、非 mock。
- 影响：猜测/获知顺序 scriptId 即可使用同队员不愿授权的私有代码；`updateEntry` 同样调用此缺少检查的函数，无法通过仅限制首次入场解决。
- 契约：第 8 节 private 只有所有者可见可用。协调者已明确：加入队伍不代表授权全部 private 脚本；每个阵容脚本还必须满足非 private，或归当前操作者所有。
- 修复方向：对每个阵容脚本统一执行成员关系、有效版本和 private/所有者检查；考虑已存在阵容的可见性变更，避免历史入场持续绕过授权。
- 置信度：高（完整复现，权限口径已确认）。

### 2. [P2][高] 停止匹配器只清当前 token，等待旧版本的基准任务仍在 shutdown 后启动

- 位置：`server/src/services/ladders.ts:263`、`server/src/services/ladders.ts:276`、`server/src/services/ladders.ts:334`；关闭调用点：`server/src/app.ts:67`。
- 问题：停止函数只清 `benchmarkTokens`，但替换版本的 `benchmarkJobs` 还在等待前一个 promise。旧任务取消完成后，等待链没有停止标志检查，进入 `executeBenchmark` 并重新设置 token。若 runner 已关闭，则新的任务会再次启动线程池。
- 触发：单 worker 先运行占容量的对局；solo 入场 v1 的基准等待容量；切换为 v2，让 v2 在旧 promise 后排队；立即调用 `startMatchmaker()` 返回的 stop，再 `shutdownRunner()`。这与 `startServer.close()` 的停止顺序相同。
- 实测：shutdown 返回时只有 1 局原有 exhibition；随后在没有新请求、没有重启匹配器的情况下，自动新增并完成 **10 局 benchmark**，solo entry.games 从 0 变成 10。原 exhibition 因 shutdown 正常成为 error。
- 影响：优雅关闭取消不完整；`close()` 返回后仍可重建 worker/写数据库、在测试或嵌入式使用中留下活动线程。CLI 立即 process.exit 时可能截断而不是完成这些新任务。
- 修复方向：以 db/匹配器生命周期的停止 generation/token 覆盖尚未开始的等待链，启动 execute 前与每次提交前复查；关闭时等待所有已取消的后台任务 settled，再关闭 runner。
- 置信度：高（真实池与真实 DB 重现，10 局均 done）。

## 已核对且未确认其他问题

- Agent Key 只存 SHA-256，创建/轮换一次返回明文；轮换撤销旧 Key；agent principal 不能操作同 user 的 sibling Agent。
- SQL 查询使用参数绑定；列/排序动态片段来自固定枚举，未确认 SQL 注入。
- 对局 get/list、realtime payload 的 logs/firstError 按脚本所有者脱敏；test 不进入匿名发现/全局 finished。按 DESIGN，拿到 test id 的访客能看结果与回放，不作为越权报告。
- 普通 matches.create 拒绝他人的 private 脚本；个人天梯 join/updateEntry 强制脚本归当前操作者；dryRun 限制非所有者只能执行 open 代码。
- openskill 的 rank 方向正确（rank 1 获胜时 mu 上升）；团队按 entry 聚合评分；rating_before 标记在同一事务内阻止重复记分。
- 匹配器提交前标 busy，按 Agent/队员集去重；测试赛和版本限额在同步事务中预占，未确认并发绕过。
- 迁移保留旧 users，旧 agents 重命名 agents_legacy；默认天梯与 builtin/house 种子幂等。
- live 时间窗使用 broadcastAt + ticks*120；回放不含源代码。公开 CheckReport 为契约 DTO，未把诊断报告可见本身作为代码泄露漏洞。
- 本轮聚焦审查与定向复现，未重新跑全量 server 测试/tsc；原 platform 测试结果见 `docs/arena/status/platform.md`。未进行真实 OOM 或破坏性压力测试。
