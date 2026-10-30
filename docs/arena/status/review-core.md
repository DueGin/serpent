# Core 交叉审查

- 审查基线：core commit `3eda5f0`；对照 DESIGN 第 2~5 节。
- 审查范围：`server/src/types.ts`、`game/**`、`sandbox/**`、`runner/**`，只读源码；未修改实现、测试或执行 git 写操作。
- 结论：**有阻断风险**。确认 4 个高置信问题，其中两个涉及资源消耗边界，一个涉及回放 tick 一致性，一个涉及故障恢复。
- 验证环境：Node v22.23.1，独立子进程，RUNNER_WORKERS=1；临时复现脚本只写入 /tmp，审查结束时删除。

## 发现

### 1. [P1][高] runner 等待队列无限制，少量时间内可保留任意数量完整代码及 Promise

- 位置：`server/src/runner/index.ts:85`、`server/src/runner/index.ts:89`；排队项只有被取出时才在 `server/src/runner/index.ts:78` 启动作业超时。
- 问题：池大小只限制执行中的 worker，不限制主线程里的 queue 数量、总输入字节或排队时间。调用者可以让一个慢检测占住 worker，再不断提交独立 64KB 代码；每个请求都保持输入和 Promise，即使它很久也不可能开始执行。
- 实际入口：REST `/api/scripts/validate` / `/api/scripts/dry-run` 和对应 MCP 工具调用服务后直接调用 runner；现有版本/测试赛限额不覆盖这两个入口。
- 复现：独立真实 runner（没有 mock worker），单 worker；循环提交 1000 个不同的约 65KB 脚本，每个脚本顶层 `while(true){}`、另带合法 move，立即记录内存；600ms 后 shutdown 清理。
- 观察：1000 项提交约 **52.7ms**，GC 后主线程 heap 增长 **66,020,720 bytes**，RSS 增长 **121,307,136 bytes**；只完成 1 项，其余 999 项直到 shutdown 才被取消。扩大请求数会线性持有更多主进程内存。
- 影响：持有合法账号或 Agent Key 即可通过未限额的检测/试跑持续积压，导致主进程内存耗尽及所有正常用户的作业饥饿；单作业硬超时不能约束等待项。
- 建议：runner 层增加全局队列长度/总字节上限与排队截止时间，满载拒绝；服务入口再加每身份并发/频率限制。验收应证明超量请求被及时拒绝且保留内存有界。

### 2. [P1][高] 返回值 sanitizer 保留稀疏数组巨大索引，节点预算被绕过；超时结果仍将大 raw 传回主线程

- 位置：`server/src/sandbox/index.ts:121`、`server/src/sandbox/index.ts:125`、`server/src/sandbox/index.ts:359`；向外传播于 `server/src/runner/jobs.ts:212`。
- 问题：sanitize 的 500 节点预算只数 enumerable keys。输出仍创建 Array，并原样赋值数字索引，因而只有一个键 `3000000` 就会把输出 length 撑到 3,000,001；JSON.stringify 会把 holes 展开为 null。invoke 虽随后标记超时，却仍返回已经构造的大 raw，dryRun 又原样送过 worker 边界。
- 最小脚本：`function move(){let a=[];a[3000000]=1;return {direction:'up',a}}`（不足 100 字节，默认32MB/50ms）。
- 复现：分别以索引 100000、500000、1000000、2000000、3000000 调用真实 `runner.dryRun`。
- 观察：索引 **100000** 时 `ok=true`、move约18ms，响应约 **500,110 bytes**；索引 **3000000** 时 `ok=false`、`move() 超时`、move约350ms，但结果仍含 length=3,000,001 的数组，JSON响应 **15,000,138 bytes**。索引1000000也已返回约5MB，尽管标记超时。
- 影响：极小脚本把输出/复制/HTTP序列化与主线程内存放大到多MB；500节点预算不是真正的输出容量上限，超时也未丢弃结果。此处不是宣称VM逃逸或无穷内存；是在现有32MB客体上限内仍能大量向宿主输出，和无界队列叠加会放大DoS。
- 建议：数组按有界紧凑元素复制，限制最大数组长度及总序列化字节数；超时或错误时丢弃 raw。验收必须包含极高稀疏索引、多层大字符串、超时后 raw为空，以及跨worker结果大小有界。

### 3. [P2][高] 非终局 move 失格在回放中延后一个 tick，和 ParticipantResult.deathTick 不一致

- 位置：`server/src/runner/replay.ts:57`、`server/src/runner/replay.ts:60`、`server/src/runner/replay.ts:79`。
- 问题：move失格被应用到当前 tick 后，却只在 `applyNext` 前进一格后把状态和die事件写入下一帧；`frameState` 同样只有最后一拍补当前tick失格。若失格结束整局，末帧特殊逻辑又会在原tick显示，导致同一种死亡的tick语义随对手是否还活着而变化。
- 复现：score、seed22、maxTicks52；slot0脚本恒返 `bad`，slot1保持原方向。slot0第50次非法决策在 tick49 失格，对手继续。
- 观察：模拟结果 `deathTick=49`，Replay记录 `{tick:49,slot:0,phase:'move'}`；但 `replayFrames()[49].snakes[0].alive=true` 且没有die事件，`frameState(replay,49,0).state.you.alive=true`；直到 frame50 才显示失格。若两条蛇都恒返 bad，比赛 tick49 结束，frame49 又会显示两条蛇均已死亡。
- 影响：网页/ASCII逐拍复盘在明确记录的死亡tick仍显示蛇存活，事件流错拍，不能准确定位失格发生时刻。
- 建议：统一每帧是对应tick决策前还是失格处理后，并让所有 tick（不只是末帧）的状态、事件、frameState与deathTick一致；回归同时覆盖终局及非终局失格。

### 4. [P2][高] worker 持续启动失败时无退避重建，即使队列已空也无限创建新线程

- 位置：`server/src/runner/index.ts:57`、`server/src/runner/index.ts:67`。
- 问题：error/exit一律立即创建替代slot；替代worker如果仍在入口加载阶段失败，又立即重建，既无退避/次数上限/熔断，也不检查是否还有等待作业。
- 真实故障复现：在 /tmp 定向编译 runner index（不包含未被静态import的worker入口），模拟部署包缺少 worker 文件；保持依赖NODE_PATH正确后调用一次 dryRun，并仅观察 worker 创建次数。
- 观察：首个请求已收到 `Cannot find module '.../runner/worker.ts'` 后，不再提交任何新任务；**500ms 内创建20个worker**，仍在循环。另一次故障注入（每次新worker立即终止）250ms内创建97个，确认不是模块解析特例。
- 影响：部署遗漏入口、依赖损坏、worker初始化失败等持续故障，会让单个失败请求引发长期线程创建/退出风暴，持续占CPU，且API已拒绝的任务不能自动终止这类恢复循环。
- 建议：有界指数退避；区分作业崩溃与启动失败；无待处理工作时不主动重启；连续失败后熔断并可观测地报告unavailable。测试应覆盖持久启动失败、队列为空与shutdown期间退避timer清理。

## 验证与未列为发现的范围

- 现有 core 四组回归：`tsx --test --test-concurrency=1 src/game/engine.test.ts src/sandbox/index.test.ts src/runner/index.test.ts src/runner/pool.test.ts`，**60/60通过**，约6.1s。日志：`/tmp/serpent-review-core-tests.log`。
- 已检查碰撞/头对头/队友/死亡蛇/击杀/并列排名/组队胜负与RNG隔离；本轮没有确认其他高置信规则缺陷。
- 恶意getter/原型修改/返回值/日志/Promise/宿主constructor路径作补充试验，未确认宿主对象或process泄漏；这不构成沙箱绝对安全证明。
- 已知QuickJS C/GC软中断延迟、极低CPU预算受冷加载影响在core状态文件中已有披露，本轮未把同一已知限制重复作为新发现。
- 未进行真实宿主OOM破坏性测试；问题1仅验证约66MB队列保留，问题2最大只验证15MB结果，再通过shutdown清理。
