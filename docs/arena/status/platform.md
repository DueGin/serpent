# status: platform

## 服务骨架就绪 / 主链路已完成

- 第9节全部服务与第10节DTO已实现，REST/MCP共用services。`principalFromRequest(req)`异步返回Principal|null，无凭证为null、坏凭证抛401；`principalFromAgentKey`只接受平台Key。
- DB user_version=1迁移、旧agents_legacy保留、全部表索引/约束、5条默认天梯与builtin/house种子（幂等）。Key仅存sha256+12位prefix，明文只创建/轮换返回。
- agents / scripts（不可变版本、检测、试跑、限额、可见性）/ teams（一人一队、队长、邀请、离队停阵容）全部实现。
- matches持久化异步模拟、版本快照、gzip完整Replay（含disqualifications）、public live时间窗、回放/帧；logs/firstError仅所有者；test不广播全局finished且不进公开发现列表。
- ladders openskill PlackettLuce评分与幂等更新、2v2队伍评分、同Agent脚本不共局、队伍共同成员不匹配、个人3入场限额、15s手动冷却；版本切换提高sigma并同步rating。
- solo固定10seed异步基准，按均分/最高分/平均tick排序；重复入场不重复启动同版本基准，新版本替代旧基准；提交模拟前遵守池容量。
- REST全部端点zod校验、匿名Socket.IO、createApp无listen/匹配器副作用、docs+MCP已挂、web/dist托管与优雅退出。

## 已验证

- auth.test.ts：10/10通过（迁移/Key/认证/权限/团队/profile）。
- matches.test.ts：10/10通过（回放/gzip/日志/可见性/限额/异步DB/版本快照/失败/评分）。
- rest.test.ts：12/12通过（REST完整流程、MCP/文档挂载、匿名socket/脱敏、shared资源上限与八场景、重启恢复）。
- scripts-ladders.test.ts：7/7通过（版本、限额、dry-run权限、个人评分、solo10局去重换版本、团队评分/离队）。
- `PORT=8101 DB_PATH=/tmp/serpent-platform.db` 真起index，curl完成注册、显式登录/me、Agent创建/Key轮换、脚本valid、测试赛done、battle入场/queue/排行games+rating变化；SIGTERM code0，8101已释放，不打印凭证。
- 平台四个测试文件并发最终 **39/39通过**，日志 `/tmp/serpent-platform-final-tests.log`。
- 全量 `LADDER_AUTO=0 RUNNER_WORKERS=2 pnpm --filter server exec tsx --test --test-concurrency=1 "src/**/*.test.ts"`：115项，112通过/3失败；全部平台与core测试通过，失败只属MCP（flood-fill六局6:6不满足严格胜出；rules缺“尸体”文字及其父suite），日志 `/tmp/serpent-platform-full-serial.log`。
- 平台/DTO/services/REST/auth源码和平台非装配测试 strict 定向tsc通过（约1s），包含 routes/*.ts、services/index.ts。
- 全仓tsc在MCP新增SDK工具泛型后出现高CPU长时推断（此前约1s）；已停止重复的本方tsc，等待MCP worker/协调者解决类型推断膨胀。尚不宣称全量tsc通过。

## 内部接口

- realtime.ts `arenaEvents` EventEmitter：match:finished / lobby:live / ladder:updated；只发送匿名DTO，且事件层二次剔除日志。
- matches额外导出 createInternalMatch / InternalParticipant / activeMatchCount / waitPendingMatches；内部input可传db确保异步测试隔离。
- ladders额外导出 entryDTO(id,db?)、recordMatchResult(id,db?)、scriptVersionChanged、waitLadderJobs、runMatchmakerOnce、startMatchmaker。
- teams额外导出mustCaptain/unlinkAgentFromTeam；scripts额外导出scriptSummaryDTO/scriptRow/checkCode。
- house entrant_type=builtin,builtin=house,lineup_json=["builtin:greedy","builtin:coward"]；不创建假Agent/Team。
- matches表额外duration_ms，其他schema与第6节一致。

## 口径与剩余风险

- platformStats统计公开可发现脚本/比赛，不含private/test（仅统计口径，不改DTO）。
- 队长离队自动移交给最早成员；最后成员离队自动解散；涉及离队成员的天梯阵容立即暂停。
- dry-run他人listed代码禁止；open可试跑但不返回其logs/error。
- 服务错误不暴露内部异常；未实现持久任务队列（契约仅内存runner），重启中断对局将启动时置error。
- REST严格init/state schema已提升至 `services/script-input.ts`，scripts.dryRun调用checkDryRunOptions，防MCP传自定义资源上限绕过REST校验；服务校验错误统一AppError，DB名称冲突统一CONFLICT。

## 最终交付（platform）

- 平台代码已完成并冻结；最后定向39/39通过，strict平台+REST/services源码类型检查通过，tracked diff --check通过。
- 最后追加修复：暂停的entry在版本切换时同样清solo旧成绩/提升sigma；同entry基准新版本在旧在途模拟结束后才启动，跳过被更新版本替代的排队；关闭匹配器会取消后续基准轮次。
- 全局tsc与完整server测试尚有MCP归属问题，已记录具体失败和日志；platform未修改MCP/core文件。
- 没有执行git写操作，未改package.json；自测8101进程已全部退出。

## 交叉审查修复与最终回归（2026-10-30）

### 团队阵容授权（P1 已修复）

- `lineup=[scriptId,scriptId]` 明确为**两个不同成员的脚本 ID**，不是 Agent ID。
- 新 `services/lineups.ts` 为 join/updateEntry/匹配筛选/内部实际开赛共用校验：当前队员、有效生效版本、非 private 或当前授权者拥有该脚本 Agent；Agent Key 只能授权自己的 private，用户 JWT 可授权名下多个 Agent 的 private。
- entry 保存授权操作者 `authorized_user_id` / `authorized_agent_id`，开赛前根据当前成员、版本、可见性和队长重新检查；不满足则 active=0，并在 `inactive_reason` 持久记录原因，不创建对局、不提交 runner。
- DB `user_version=2` 增量迁移上述三列；既有 v1 团队 entry 因无法还原历史授权身份，安全暂停并记录“阵容授权需要队长重新确认”，队长重新 join/update 后恢复。个人/builtin 不受影响。migration 与认证断言均已同步。

### 生命周期与关机（P2 已修复）

- DB 维度 lifecycle generation/stopping 覆盖尚未执行的整条 benchmark promise 链；runBenchmark、executeBenchmark 入口、每次提交前、容量等待后与汇总写入前重查，不允许停止后重新安装 token。
- `startMatchmaker()` 的停止函数现在返回 `Promise<void>`：同步标记 stopping/清 interval/token，等待所有 benchmark 链 settled、已提交对局与脚本检测完成；`app.close()` 等待 stop 与 HTTP 关闭后才 `shutdownRunner()`。
- create/createInternalMatch/检测/试跑/新增脚本版本在停止生命周期拒绝新作业；重新 startServer 建立新 generation。
- 真实单 worker 回归：先占池，solo v1 等容量，切 v2 后立即 close；**155.7ms** 关闭，benchmark 新增 **0**，总计创建 worker **1**，关闭后活动 worker **0**，200ms 观察窗中新增 worker/DB writes 均 **0**。阻塞表演赛正常 done，不靠直接退出进程掩盖残留。

### Runner 错误与共享额度

- `RUNNER_BUSY`（queue_full / queue_bytes / queue_timeout）及 `RUNNER_UNAVAILABLE` 统一映射 `AppError('RATE_LIMITED', 固定公开文案)` / HTTP **429**；服务层映射使 REST 与 MCP 一致，worker 本机路径等细节不外露。
- validate/dryRun 共用**每身份 2 并发、每滚动 60 秒 20 次**，按 userId 或 agentId 区分；Key 轮换不重置额度，REST/MCP 共用，其他身份不互相占额度；闲置记录按窗口清理。
- 保存新脚本/版本所触发的检测也使用同一额度，避免绕过；限流在插入版本前执行，拒绝不留下脚本/版本记录；runner 实际拒绝则保存检测未完成报告并向调用者返回429，不吞成正常 invalid 成功响应。
- `scriptsSvc.validate(code, principal?)` 保留可选参数的类型兼容，但无身份实际拒401；REST 已传入 principal。协调者已将 MCP validate_code 接为 `validate(code,p)`（platform 未改 MCP 文件）。
- `AgentProfileDTO.stats.moves` 已新增，按所有 done 对局 `SUM(match_participants.moves)` 聚合，与既有 errors/timeouts 的统计范围相同；旧 stats 字段不变。用于 errors/moves 和 timeouts/moves，0 时由前端防除零。

### 新增回归与实测

- 新增 **9 项**：v1→v2迁移保留/暂停；private 阵容 join/update 拒绝与赛前撤销；内部开赛二次校验；同 user 两 private 授权但 Agent Key 不可扩权；单 worker 关机等待链；validate/dry-run 并发共享；20/60s频率与身份隔离/拒绝无副作用；runner 三类忙/不可用错误映射与 slot 释放；真实 REST↔MCP 共享额度。
- Agent profile 既有聚合用例增强：两个 done 参赛记录各100 moves得到200，error 对局100 moves不计入。
- 最终命令：`LADDER_AUTO=0 RUNNER_WORKERS=2 pnpm --filter server exec tsx --test --test-concurrency=1 "src/**/*.test.ts"`，**141/141 pass，0 fail，23.99s**。日志 `/tmp/serpent-platform-review-fixes-final.log`。
- `cd server && npx tsc --noEmit` **通过**（全量）；平台 tracked diff whitespace check通过。新增文件无 any / 双重断言 / non-null assertion。
- 真起 `PORT=8101 DB_PATH=/tmp/serpent-platform.db LADDER_AUTO=0 RUNNER_WORKERS=1`：注册→建Agent→脚本valid→3tick测试赛done→profile.moves=3→battle入场/queue done→第21次检测预算请求 HTTP429/RATE_LIMITED。Key/JWT未打印，进程退出且8101端口释放。运行日志 `/tmp/serpent-platform-curl-check.log`。
- 没有执行任何 git 写操作；未改 package.json、core、web 或 MCP 文件。

### 对接及风险

- web 已由其他 worker 同步 `AgentProfileDTO.stats.moves`；platform 不越范围改 web。
- v1 团队入场升级后必须由队长重新授权，这是刻意的安全迁移行为；inactive_reason目前保存在DB内部，不改变DTO。
- 优雅关机等待已提交作业完成，最坏受 runner 180s 硬超时约束；不宣称 close 总能在固定短时内返回。
- 身份限额为进程内滚动窗口，重启后清空；多实例部署需要共享配额存储（现契约为单进程 SQLite 服务）。
