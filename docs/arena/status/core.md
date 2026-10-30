# Core 状态

## 完成

- **骨架就绪**：`server/src/types.ts` 与 `server/src/runner/index.ts` 导出 DESIGN 第 3/4/5 节全部类型和函数；平台、MCP 可直接接入。
- 引擎：tick 制 `maxTicks`、全部 DeathReason、击杀、并列排名、FFA 与 2v2 胜负、固定出生点、食物独立种子 RNG、`ENGINE_VERSION = 'serpent-engine-2'`。
- Bot：greedy/coward/random，所有 Bot 不消耗食物 RNG；random 独立派生种子。
- 观察：`buildInitInfo` / `buildScriptState` / `asciiGrid`，包括死亡位置、legalMoves、独立克隆的输入。
- 沙箱：QuickJS 每选手独立 runtime，32MB 默认内存、256KB 栈、init/move interrupt deadline、200 行/500 字日志上限、JSON 安全化、同步接口与模块导出、确定性 Math.random / Date。宿主不读取任意 guest 对象属性，恶意 getter、序列化与错误均在 VM 内处理。
- Runner：worker_threads 池（默认 min(4,cpus-1)，`RUNNER_WORKERS` 可配）、作业硬超时（`RUNNER_JOB_TIMEOUT_MS`，默认 180000）、有界输入/队列/等待时间、启动失败退避/熔断、按需崩溃恢复、并发 shutdown、安全清理。
- 检测：9 个固定检测项；8 个场景（含真实引擎验证的唯一出口）；3 seed solo 与 battle 迷你模拟（每局 100 tick）；dry-run、逐帧回放和 ASCII 复盘。
- 失格：init 错误/超时、连续 50 次失败、累计 CPU 超限。所有选手看到相同拍前局面，失格在拍内原子应用；错误/超时/非法/掉头均保持原方向，不做贪心兜底。

## API 用法

```ts
import {
  defaultConfig, simulate, validateScript, dryRun, listScenarios,
  replayFrames, frameState, shutdownRunner,
} from './runner';

const code = `function move(state) { return state.legalMoves[0] || state.you.dir; }`;
const report = await validateScript(code);
const scenarios = listScenarios();
const trial = await dryRun({ code, scenario: 'solo-open' });
const result = await simulate({
  config: defaultConfig('battle', { seed: 132, maxTicks: 1000, players: 2 }),
  participants: [
    { slot: 0, name: '我的脚本', team: null, source: { kind: 'script', code } },
    { slot: 1, name: '贪心', team: null, source: { kind: 'builtin', bot: 'greedy' } },
  ],
});
const frames = replayFrames(result.replay); // tick 0 含初始阶段/该 tick 的失格
const view = frameState(result.replay, result.ticks, 0); // {ascii,state}
await shutdownRunner(); // 进程退出/测试结束时调用，可再次启动池
```

- team match 必须四个 slot 0..3，team 为 `slot % 2`；普通 match 的 team 必须 null。
- `captureLogs: false` 不返回 logs；默认 true。runner 只返回数据，日志/firstError 的所有者权限由 platform 服务处理。
- `cpuMs`/单局 CPU 预算使用 Node 22 的 `process.threadCpuUsage()`；旧 Node 无此 API 时回退 `process.cpuUsage()`。avgMoveMs/maxMoveMs 为墙钟耗时。

## 回放扩展

`Replay.disqualifications?: Array<{tick:number;slot:number;phase?:'init'|'move'}>` 是兼容新增字段；UDLR 的 moves 无法编码失格。

- tick 是调用脚本前的已走步数。
- 每帧 tick N 表示已经走 N 步、且已应用 tick N 的 init/move 失格、尚未走下一步的状态。`frameState` 使用同一语义。
- init 失格在初始帧前应用；move 失格同样在所记录 tick 的帧内显示（无论是否终局），不新增 tick；die 事件只在死亡 tick 出现一次。
- 回放不执行用户脚本，使用保存的方向与失格事件，故不受执行耗时变化影响。

## 验证与性能

- `game/engine.test.ts`：29 项，覆盖规则、死亡原因、组队、排名、RNG 隔离。
- `runner/index.test.ts`：13 项，覆盖同 seed 同脚本、回放逐帧一致、原子 init/move 失格、50 连续失败、CPU预算、失败清零、检测、试跑、攻击脚本恢复。
- `runner/pool.test.ts`：3 项，独立子进程验证硬超时恢复、活动 worker 意外退出恢复、`tsc` 编译后纯 JavaScript worker（不依赖 tsx）。
- `sandbox/index.test.ts`：15 项，覆盖死循环、内存炸弹、深递归、process/require/构造器逃逸、全局污染、恶意 getter、Promise、日志与返回值安全。
- Core 全部文件含测试与 benchmark 的 strict TypeScript 定向检查通过。
- 全量 `pnpm --filter server test` 曾在服务/MCP测试尚未全部落盘时 87/87 通过；最终并行集成测试结果会在下文追加。
- 全局 `server tsc --noEmit` 在包含 MCP 文件后出现长时间类型实例化，core 定向检查不受影响；此范围外问题已报告协调者。

性能复现：`pnpm --filter server exec tsx src/runner/benchmark.ts`。

本机 Node v22.23.1，4 个相同 BFS JS 脚本，标准 28x20 battle，seed=132，maxTicks=1000：

| 项 | 实测 |
|---|---|
| 结束 | 1000 tick，max_ticks |
| 脚本 move 总次数 | 3050 |
| 冷进程模拟耗时 | 813.254ms |
| 含 worker 启动总耗时 | 896ms |
| 平均 move 耗时（各选手） | 0.200~0.246ms |
| 最大单次 move 耗时 | 2.254ms |
| errors/timeouts/invalidMoves | 均为 0 |
| score（slot 0..3） | 520 / 650 / 320 / 760 |

另一次热池模拟 618ms，独立冷进程在编译器并发负载下 1464ms；不同宿主负载会影响 wall 时间。BFS 检测 9 项均 pass，检测总计 171ms。

## 已知限制与契约解释

- **QuickJS interrupt 是软中断**：C 内存分配/GC 可能延后响应（32MB 内存炸弹曾约 3.5s 才返回，非即时 50ms）。最终实际耗时超限一定判 timeout 并丢弃方向；强终止由 worker 作业硬超时兜底。宿主线程不执行用户代码，不会被死循环阻塞。若产品要求逐拍绝对 50ms 强终止，需要更细粒度的隔离/逐拍 supervisor 设计；本实现不声称达到这一强实时保证。
- 同 seed 的游戏行为、随机流可重现，但触碰真实耗时/CPU限额的脚本仍受机器负载影响；保存的回放始终确定性重现已发生结果。
- 首个沙箱承担一次性 QuickJS 加载 CPU，极低自定义 CPU 预算可能在 init 失格；默认 30s 不受影响。
- Death body 保留在 ScriptState 供复盘，但不再构成障碍，也不阻止生成食物；ASCII 仅画活蛇。这是 DESIGN 未明示处的实现约定。
- team-battle 到 maxTicks 同存活数时比较全队总长度（含死亡蛇），按 DESIGN “队伍总长度”解释。
- 团队 rank 使用 competition ranking：胜队两人并列 1，负队并列 3；平局全为 1。个人分数/长度仍分别记录。
- team-score targetScore 严格按“某条蛇达标”触发，最终比较队伍总分，不以两条蛇合计达标提前结束。
- 没有新增依赖、改 package.json，未执行 git 写操作；仅修改 core 归属目录与本状态文件。

## 最终集成验证（本轮）

- Core 四组测试合跑：**60/60 通过**，8.64s。包括最后对确定性测试扩大正常脚本测试预算（仅测试，不改生产默认 50ms），消除极高并行编译负载导致的测试调度噪声。
- Core 全部源码、测试、benchmark strict 定向 `tsc --noEmit`：通过；`git diff --check` 对已跟踪 core 改动：通过。
- 最后全量 server 测试在其他 worker 新文件落盘后为 115 项；串行运行 **112 pass / 3 fail**，失败均为 MCP 归属：flood-fill 对 greedy 固定六局 6:6（要求严格胜出）、rules 文档缺测试要求的“尸体”文字（及父 suite 失败）。core 与 platform 项均通过，已将日志 `/tmp/serpent-core-serial-full.log` 和归属通知协调者；未修改其他 worker 文件。
- 并行全量曾因 50ms 软预算下高 CPU 争抢导致示例 timeout，串行后全部示例 validate 通过。全局 `server tsc --noEmit` 等待超过 2 分钟无输出，已停止自己启动的该次编译，保留其他 worker 的进程；需 MCP 类型复杂度问题最终收口。
- core 已完成并停止编辑，无待实现的 core API；强实时软中断限制如前述，不能据此宣称逐拍绝对 50ms 强终止。

## 交叉审查修复（完成）

- 已只读审查 platform；2 条高置信发现与真实复现数据见 `docs/arena/status/review-platform.md`，已通知协调者；未改 platform 实现。
- 已修复非终局失格回放错拍：`replayFrames` / `frameState` 在全部 tick 应用同 tick 的失格，终局和非终局统一；回归验证 tick49 的 alive=false、die 事件和 ParticipantResult.deathTick 一致，tick48存活、tick50不再重复die。新增 tick0 move失格案例。
- 沙箱返回值限制：数组只复制前 128 个元素，忽略非索引属性，不保留原稀疏 length；递归预算 500 节点/8 层/单串 5000 字符。整个 raw JSON envelope 限制 **65536 UTF-8 字节**，包含转义、键、值、标点；VM 内计费，宿主再次复核。超限、任何错误或超时一律返回 raw=null、direction=null。日志仍独立受每局 200 行/每行 500 字符上限约束，不计入 raw envelope。
- 队列/输入限制：默认全局 **64 个未完成作业（含执行中）**，对应 JSON UTF-8 输入合计 **8MiB**；排队最多 **30000ms**。可配置 `RUNNER_QUEUE_MAX_JOBS`、`RUNNER_QUEUE_MAX_BYTES`、`RUNNER_QUEUE_TIMEOUT_MS`。满载/字节超限立即拒绝；等待到期移除并拒绝，完成/拒绝/shutdown 清理占用与定时器，不影响执行中作业。
- worker 加载入口后发送 ready 握手，启动期限 10000ms；启动失败按 100ms 指数退避、封顶 2000ms，连续 5 次失败后熔断 30000ms；只在存在等待作业时创建/重试，空队列不主动探测，shutdown 清全部重试/启动/排队/作业计时器。已 ready 的作业崩溃仅拒绝本作业，后续按需恢复，不误计为入口启动失败。

### 新增错误接口（供 platform 映射）

```ts
import { RunnerBusyError, RunnerUnavailableError } from './runner';
// RunnerBusyError: code === 'RUNNER_BUSY'
// reason: 'queue_full' | 'queue_bytes' | 'queue_timeout'
// 建议映射为 AppError('RATE_LIMITED', ...)，HTTP 429。
// RunnerUnavailableError: code === 'RUNNER_UNAVAILABLE'
// retryAfterMs: 熔断剩余毫秒数。建议 503；若保持契约现有错误集则 INTERNAL 500。
```

- 错误只描述池状态，不包含脚本输入；入口启动失败 detail 可能含本机入口路径，应由 platform 使用固定公开错误信息，不向访客原样展示。
- 原 simulate/validateScript/dryRun/shutdownRunner 签名不变。RunnerPool 导出用于故障注入测试，生产调用不需要自行创建池。

### 修复实测与回归

| 场景 | 实测 |
|---|---|
| 1000 个不同 65KB 输入、默认容量、故障入口 | 936 项立即 RUNNER_BUSY；64 项保留，5 次启动失败后全部 RUNNER_UNAVAILABLE |
| 故障恢复 | 约 1519ms 熔断；额外空闲 500ms，创建次数仍为 5；pendingJobs/pendingBytes/queue/workers 均为 0，retryScheduled=false |
| 稀疏数组索引 3000000 | raw 数组 length=128；raw 664B，完整 dry-run 748B，约 2.084ms（修复前约 15MB） |
| 嵌套 12x5000 ASCII 字符 | 正常 raw 60076B，完整 dry-run 60161B |
| 嵌套 40x5000 ASCII 字符 | 字节预算拒绝，raw=null，完整 dry-run 145B，约 17.949ms |
| soft timeout | raw=null，完整 dry-run 114B |
| 非终局/终局 move 失格 | 同为 deathTick=49；frame49 dead+die，frameState49 dead；非终局 frame50 无重复 die |
| 修复后 4 BFS / seed132 / 1000tick | 模拟 668.486ms，含 worker 启动 721ms，3050 moves，errors/timeouts/invalidMoves 均为 0 |

- 新增 17 项回归：pool 从 3 项增至 13 项（数量/字节/等待截止/启动失败/熔断/空队列/shutdown/hung startup/混合失败恢复/配置小数边界），sandbox 新增 serialization.test.ts 6 项（稀疏数组、嵌套/转义/Unicode、超限、timeout raw、真实 worker 大小），runner 增加 tick0失格并强化终局/非终局逐帧断言。
- Core 最终全部 **77/77 通过**，7.07s；日志 `/tmp/serpent-core-review-fixes-final.log`。
- `LADDER_AUTO=0 RUNNER_WORKERS=2 pnpm --filter server test` 全量 **130/130 通过**，15.12s；日志 `/tmp/serpent-core-review-full.log`。
- 补上 pool 最后两个边缘回归后再跑全量：132 项 131 pass / 1 fail；唯一失败是并行 platform 正将 DB schema 升级 v2，而 `auth.test.ts:62` 仍断言 user_version=1（实际2），已通知协调者，未修改他人文件。日志 `/tmp/serpent-core-review-full-final.log`。全部 core 项均通过。
- Core strict 定向 TypeScript 检查通过；**全量 server `tsc --noEmit` 两轮通过**（约 6.9s / 4.1s），先前 MCP 类型复杂度阻塞已不再出现。
- 未执行 git 写操作；未修改 package.json 或 platform 实现。QuickJS C/GC 软中断延迟的已知限制仍如前述，不宣称逐拍绝对 50ms 强实时。
