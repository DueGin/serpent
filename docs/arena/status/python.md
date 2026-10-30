# Python 工人 B 状态

## 威胁模型（实现前）

- 用户代码完全不可信；攻击者可能控制源码、返回值、异常、日志和反射，试图读取凭据/源码、写宿主文件、联网、生成 JS、启动进程或读取其他参赛者状态。
- Python 的 import 黑名单不是安全边界。安全边界为独立 OS 子进程 + Node 权限模型 + 无宿主文件系统挂载的 WASM；Python 模块过滤与 JS 全局清理只作纵深防御。
- 每个参赛者/检测场景使用未接触过用户代码的新解释器；预热池只能提供未使用解释器，使用后销毁，不跨所有者复用。
- 限制父子 IPC 消息、日志、代码和返回值；CPU、内存、中断失败均 fail closed，宿主进程不执行用户对象的方法。

## 预定架构

- 保留 QuickJS 同步路径；语言分派到 Python 异步沙箱。
- Node 子进程以空 env、权限模型、只读白名单和禁止字符串生成代码启动；可信入口从本地固定版本 Pyodide 加载完整 CPython，不允许运行时下载。
- 子进程内可信 worker 运行解释器，共享中断缓冲由监督线程触发；超时先中断，宽限期后父进程杀死子进程。内存超过解释器基线 32 MiB 时失格。
- JSON-only 输入输出，Python dict/list；确定性 random/time；Python 导入防护、去除宿主 JS 全局与 NODEFS。
- 宿主池并发受限且提供未使用实例预热；构建复制可信入口与 Python bootstrap 到 dist。

## 实现与取舍

- 固定 `pyodide@0.28.3`（完整 CPython/WASM），本地读取 asm.js/wasm/stdlib.zip/lock；运行时不下载任何资源。`pnpm install --registry=https://registry.npmmirror.com`、添加依赖同样指定镜像。
- 每个 Python 对局参赛者、检测场景、模拟、试跑独占一次性解释器；比契约“检测内复用解释器但换命名空间”更强，代价是完整检测冷启动较多。`__main__` 是新 ModuleType，dataclasses 可正常工作。
- 子进程 `env:{}`（额外删除 macOS 自动注入的 CoreFoundation 环境项）；Node `--permission` 仅只读 Pyodide/入口/bootstrap、`--allow-worker`、`--disallow-code-generation-from-strings`；不授权写入、child_process、addon、WASI。
- 监督主线程运行中断/资源监控，WASM 在该进程的可信 worker 运行；50ms/500ms 先写 SharedArrayBuffer=2，200ms 宽限仍不返回则杀进程并失格；父 IPC 断开子进程退出。runner 终止/服务退出不遗留宿主。
- Node 22 权限模型**不限制网络**，且原生 Worker 可用 `execArgv:[]` 规避 Node 权限，故必须叠加 OS 边界。macOS Seatbelt 精确只读 Node/资源/入口/系统库，拒绝网络、全部写入、fork；Linux bubblewrap 最小文件系统、只读绑定、空环境、独立 network/PID/IPC/UTS namespace。无隔离器拒绝 Python，不悄悄降级。
- 清理 JS process/require/fetch/WebSocket/Worker/crypto/loadPyodide/_createPyodideModule 等全局，移除 NODEFS/NATIVEFS/SOCKFS 等非 MEMFS、禁止 mount/loadPackage。Python 审计钩子 + import 检查 + sys.modules 封锁，清 JsFinder/JsLoader 及残留 bridge 模块能力；不把 Python 黑名单当安全边界。
- 返回值 JSON-only，普通 dict/list；返回结构深度/节点/数组/字节限制，日志实际换行计数 200 行×500 字符，半行在调用结束冲刷。超量日志不能造成宿主无界增长。
- 内存同时有 5ms RSS 监督与 **dlmalloc baseline+32MiB 硬上限**。额外安装 CPython RAW/MEM/OBJ 三域可信 WASM allocator 回调：分配失败保留 JS sticky fatal，哪怕用户捕获 MemoryError 或清除 frame tracing，仍立即失格。未采用可被 Python 反射关闭的 tracer。单局 CPU 用子进程 cpuUsage（不计解释器冷启动），用户顶层源码 CPU 计费。
- random.seed/Random(None) 确定化，random 按 seed/slot 播种，PYTHONHASHSEED=0；time.time/monotonic/perf_counter=0.12×tick；os.urandom/SystemRandom 禁用。JS Date/Math.random/performance 在隔离 worker 也确定化，不影响监督计时。
- 预热池仅保留未执行用户代码的新解释器，默认每 runner worker `PYTHON_WARM_HOSTS=1`、`PYTHON_MAX_HOSTS=4`，满时拒绝，不跨作业/所有者回收；修复预热启动期间不可领取导致第四选手被挤出的竞争。
- JS QuickJS 执行实现与 classic 引擎/trace 配置不改；仅语言分派和 runner await 接口。测试进程并发改为 2，避免几十个冷 CPython 与 JS 壁钟预算测试互相争抢 CPU，**没有放宽 50ms 脚本限制**。
- language 从创建持久化且不可修改，版本继承；REST/MCP/CLI/DTO/source/validate/dry-run 全贯通，scriptId 试跑取 DB 语言。未修改共享类型/DB 迁移/工人 A 或 C 文件。

## 文件清单

- 沙箱：`server/src/sandbox/index.ts`、`python.ts`、`python-host.cjs`、`python-bootstrap.py`、`python.test.ts`、`python-confinement-probe.cjs`、`python-benchmark.ts`。
- runner：`server/src/runner/index.ts`、`worker.ts`、`jobs.ts`、`python.test.ts`、`python-escape-review.test.ts`。
- 业务/REST：`server/src/services/scripts.ts`、`matches.ts`、`script-input.ts`；`server/src/routes/arena.ts`、`schemas.ts`、`language.test.ts`、`python-rest.test.ts`。
- MCP：`server/src/mcp/examples.ts`、`schemas.ts`、`server.ts`、`tools.ts`、`mcp.test.ts`、`examples-python.test.ts`（没有修改 A 的 examples.test.ts）。
- CLI：`server/src/cli/serpent.ts`、`language.test.ts`；Python 示例 `examples/scripts/greedy-bfs.py`、`flood-fill.py`。
- 文档：`server/src/docs/script-api.md`、`overview.md`、`mcp.md`、`rest.md`；依赖/构建 `server/package.json`、`pnpm-lock.yaml`；本状态文件。

## 逃逸测试清单

`server/src/sandbox/python.test.ts` + `runner/python-escape-review.test.ts`：

- 每个禁用模块逐个直接导入；__import__、__builtins__、importlib、sys.modules。
- gc.get_objects、object.__subclasses__、JsFinder.jsproxies、JsLoader.jsproxy、残留模块桥函数 `_pyodide_core.to_js`，并复现曾经可恢复 allocator 的具体攻击再断言无法恢复。
- open('/etc/passwd')、仓库源码、/tmp 秘密哨兵、io.FileIO、os.open；写哨兵/创建宿主文件。
- js.process、js.fetch、NODEFS 挂载、urandom/SystemRandom；真实 localhost 监听端口统计连接数。
- **主动绕过所有 Python 守卫**，用同一生产 Node/OS 启动命令跑 raw Node 探针：fs 读写、网络、spawn、原生 addon、Function 动态代码、Worker(execArgv:[])。确认读取/写入/网络均被 OS/Node 第二层阻止，而不只是 Python 抛异常。
- 无限循环中断后全局状态保留；吞 KeyboardInterrupt 继续循环在宽限后杀进程；深递归；80MiB 内存炸弹；捕获 MemoryError；frame.f_trace=None 后捕获 MemoryError；大量 print 与超大返回对象。
- 同局两个解释器与后续新作业全局秘密不可见，确定性、Random(None)、多参数日志、纯 Python 标准库/dataclass。
- **每个攻击条目**验证宿主哨兵内容不变、目标宿主文件不存在、没有连接被监听器接受，且返回/日志不包含秘密；隔离条目还直接扫描另一个解释器秘密。不是只断言“异常了”。

## 验证

- 安装：`pnpm install --registry=https://registry.npmmirror.com` 成功；`pnpm --filter server add --save-exact pyodide@0.28.3 --registry=https://registry.npmmirror.com` 成功。
- `pnpm --filter server test`：**242 tests / 20 suites / 242 pass / 0 fail / 0 skipped，127093.099ms**；包含 JS 沙箱、serialization、runner/trace.test.ts 两个哈希、MCP、REST、Python 逃逸与资源限制。
- allocator 两处只读审查小修（失败时统一 fatal、size_t unsigned）后，`MemoryError/可信分配器` 定向复跑通过；最后全量再次复跑结果见交付追加。
- `cd server && npx tsc --noEmit` 等价执行 `pnpm --filter server exec tsc --noEmit`：exit 0，无输出。
- `pnpm build`：server `tsc && cp src/sandbox/python-host.cjs src/sandbox/python-bootstrap.py dist/sandbox/` 成功；web `tsc && vite build`，96 modules，index.html 0.70kB / CSS51.50kB / JS334.45kB，gzip0.42/10.75/109.04kB，最终 Vite 467ms（再次构建输出将在交付追加）。
- `git diff --check`：通过。测试及联调进程完成后检查 8122 无监听，Python host 无遗留。

## 性能实测

环境：macOS arm64，Node22.23.1，Pyodide0.28.3；只报告当前 worktree 测得值，不假装已合并 A 的引擎。

可复现命令：`pnpm --filter server exec tsx src/sandbox/python-benchmark.ts`。

| 项目 | 最终实测 |
|---|---|
| 单解释器冷加载（含 OS/进程/用户源码） | **871.538ms**；Pyodide启动807.279ms |
| 解释器 RSS 基线（含监督/worker） | **205848576 bytes = 196.31MiB**；WASM20MiB |
| 完成预热后领取+源码加载 | **3.293ms**（预热本身781.063ms，后台支付；不是消灭冷启动成本） |
| 64×64、无穿墙、4 Python×1000拍 | **3832.259ms**；4000次成功决策，errors/timeouts均0；平均0.085ms/次，最大0.508ms；各子进程CPU89.578–92.267ms |
| flood-fill.py 完整检测 | **13123.984ms**，ok=true；平均move0.438ms，最大1.251ms |
| 64×64 官方示例单拍（独立 dry-run） | greedy约3.3–5.3ms，flood-fill约6.7–9.0ms；均在50ms内 |

上述1000拍容量基准明确使用 **classic配置**（64×64、wrap=false、无生命值、四果实、沿边路径），确保四条蛇都真正作出1000次决策。新 survival-64 引擎在工人 A 的独立 worktree；需要协调者合并后另测真实 survival-64 四人1000拍（含策略、饥饿与碰撞），不伪造本分支没有的行为。新规则自定义 state 的 Python 试跑已覆盖64×64/生命值/头对头/score阻挡。

## 生产构建真实 REST

在 `PORT=8122 DB_PATH=/tmp/serpent-python.db LADDER_AUTO=0 node server/dist/index.js`：

- 注册用户/创建 Agent HTTP201（Key/JWT只保留验收 Node 进程内存，无打印/提交）。
- 创建 Python greedy-bfs.py：HTTP201，language=python、activeVersion=1、valid；约14.89s。
- 检测：HTTP200，9项全部pass，约15.54s；按scriptId试跑HTTP200，ok/legal=true，right，约810ms。
- 对greedy的100拍battle：HTTP201、done，Python errors=0/timeouts=0；reviewHTTP200、hasTrace=true。
- 加固后的最终构建再做同一链路，结果在交付追加；用完终止8122服务。

## 部署资源

`pnpm build` 将可信入口/bootstrap复制到 `server/dist/sandbox/`，TypeScript输出 `python.js` 同目录。运行 `cd server && node dist/` 时，必须提供 `server/node_modules/pyodide` 符号链接及实际 pnpm target（完整asm.js/wasm/stdlib/lock），以及现有 `server/src/docs/`、仓库 `examples/scripts/`。安装/打包阶段允许联网；比赛运行不允许。

## 残余风险与协调事项

1. **OS/Node/V8/WASM/Pyodide 是 TCB**：不是形式化证明。Python 标准反射不能当能力隔离保证；已针对发现的真实桥恢复做能力清理，生产仍应在独立低权限账号/容器、外部网络拒绝与 cgroup/pid/内存限制下运行。
2. **Linux 尚未在本机验收**：bubblewrap策略已实现且缺失时fail closed，但目标机需有可用user namespace并跑完整逃逸套件。尤其 Node `--allow-worker` 可能绕Node权限，Linux生产建议再加 seccomp 禁止派生进程/命名空间与 cgroup 资源硬配额；macOS已实测OS拒fork、文件写和网络，原生Worker绕Node权限仍读不到哨兵。
3. 并发是**每runner worker**上限，不是全服务器单一全局池。默认4 workers×4活跃Python约3.1GiB解释器基线，另有预热；需按内存配置RUNNER_WORKERS/PYTHON_*。同worker超限直接fail closed可能使参赛者初始化失格，不承诺无界排队。
4. 任意脚本的真实CPU/GC/OS调度不可完全确定，过预算附近可能受负载影响；规则/随机/时间确定性与无超时正常策略的Replay一致性已验证。因并发全量测试曾使JS示例壁钟超时，测试收敛为2个进程并发，而非改变脚本预算。
5. 本轮未改共享类型、db迁移、A/C归属文件。协调者合并A后需运行全套并复测survival-64性能、场景检测和Linux部署；现有classic哈希不可更新来掩盖差异。

## 最终交付追加

- 最后代码（含 allocator 异常路径统一失格、unsigned size_t、关闭 frame tracing 的攻击回归）执行 `pnpm --filter server test`：**242 tests / 20 suites / 242 pass / 0 fail / 0 skipped，119827.030ms**。
- `cd server && npx tsc --noEmit`：通过；`pnpm build` 再次通过，server tsc/资源复制成功，web96 modules、Vite467ms，产物尺寸同上。`git diff --check` 通过。
- 最后生产 dist、8122、`/tmp/serpent-python.db` 再次完整真实 HTTP：create201（python/activeVersion1，12644ms）→validate200（9项pass，12704ms）→dry200（ok/legal=true/right，772ms）→battle201（100tick、0错误0超时，853ms）→review200（24ms）。服务已停止，凭据未输出/写文件。
- 最新性能数据来自可信 allocator（已移除 Python tracer），不是存在可关闭 trace 的中间实现；曾复现的 `JsFinder` 桥恢复和 caught-MemoryError/`f_trace=None` 漏洞均有回归。
- 提交在 `python-scripts` 分支，不 push、不切换 master；提交 hash 见最后回复。状态文件和实现同一交付提交。

## 协调者跟进：基础设施故障分类（2026-10-31）

- 已先读取根 `AGENTS.md`、`RULES-V2.md` 和本记录，`git merge master` 快进至 `ec6cece`（含新规则、前端与 bubblewrap 镜像安装）；依赖通过 `pnpm install --registry=https://registry.npmmirror.com` 检查。此轮只改服务端和文档，未改 web、Dockerfile、compose、CI，也未 push。
- 新增 `sandbox/python-availability.ts`：`PythonUnavailableError.code='PYTHON_UNAVAILABLE'`；隔离器命令生成与原生产权限参数共用，缺少隔离器/运行资源、命名空间或挂载被拒、用户源码执行前启动失败/握手超时、池满均为基础设施故障。Node/Pyodide 执行用户源码前额外发送 `started` 确认，区分 ready 之后但尚未执行源码的退出；用户语法/运行错误、超时、内存/CPU 限制继续沿用原判罚。
- 错误类型穿过 inspect、dry-run、validation、simulation 与 runner worker IPC，`http.ts` 映射 HTTP503。REST 返回统一错误体，MCP 返回标准 `isError` 与结构化错误并提示“不是用户代码错误”，CLI 打印错误码和中文消息。Python 创建/提交在检测完成后才写 DB，因此不可用时既无 invalid/pending 版本，也无空脚本，旧 active/latest、时间戳和版本内容均不变。对局复用现有 runner admission 错误处理，整局 error，无排名、失格、回放/遥测、公开广播或积分变动。
- `createApp()` 触发一次轻量隔离自检：同 bwrap/sandbox-exec 参数运行最小 Node（不加载 Pyodide），10 秒上限、结果缓存；runner worker 在自身预热入口同样缓存自检。`GET /api/health` 增加 `python:{available,reason?}`，stats 增加 `pythonAvailable`，MCP `get_rules` 文本显示支持情况。缓存描述的是隔离自检，不是实时空闲容量或完整 Pyodide 加载保证；部署修复需重启刷新。
- 测试注入点为仅管理员可配置的 `PYTHON_ISOLATOR_COMMAND`（传入可信可执行文件，仍带平台原生产参数）；`PYTHON_STARTUP_TIMEOUT_MS` 默认15000，可在测试中缩短。新增测试以临时隔离器模拟 `No permissions to create new namespace`、缺失可执行文件、握手前退出/fatal/挂起、ready后源码前退出、并发池满与释放后重试；真实 HTTP/MCP/CLI 断言503/错误码、完整DB快照不变、对局error、天梯积分/场次不变、health缓存与无Pyodide host，且JS仍可用。额外回归确认真实Python语法错仍保存invalid，正常部署health为available。
- 文档 `script-api.md` / `rest.md` / `mcp.md` 补齐故障语义、健康字段、缓存/重试与Linux bubblewrap/非特权用户命名空间要求，列出Docker三项 `security_opt`（seccomp/apparmor/systempaths=unconfined），具体配置引向协调者维护的 `docs/deploy.md`，本轮未修改部署文件。
- 首轮全量：267 tests / 21 suites / 267 pass / 0 fail / 0 skipped，154821.785875ms。补 `started` 确认及语法错误回归后全量：269 tests / 21 suites / 269 pass / 0 fail / 0 skipped，163403.588125ms；新增天梯无归因断言单独7项通过。最终完整代码复跑结果在后续追加。
- `cd server && npx tsc --noEmit`、`pnpm --filter server build`、`git diff --check` 均通过；未构建或改动前端。Linux真实容器安全/逃逸验收沿用协调者报告，本机macOS不冒充完成Linux真实部署复验。
- 最终270项第一次复跑269通过/1失败：高负载下轻量隔离器进程未能在任意设定的3秒内返回，health正确报不可用但测试期待的具体namespace错误变为超时。将独立隔离自检上限调至10秒，避免启动负载造成永久缓存的假阴性；不改用户源码50/500ms预算，修正后重新全量验证。
- **最终交付验证**：`pnpm --filter server test` 全部 **270 tests / 21 suites / 270 pass / 0 fail / 0 skipped，170882.107792ms**；`cd server && npx tsc --noEmit`、服务端构建、`git diff --check` 通过。包含14项新增回归（13项基础设施与1项真实语法错误），结束后无Python宿主或模拟隔离器遗留进程。本地提交至 `python-scripts`，不 push。

