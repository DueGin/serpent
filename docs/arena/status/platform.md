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
