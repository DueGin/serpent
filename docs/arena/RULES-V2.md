# 规则 v2（survival-64）与 Python 脚本契约

用户已确认的决策：

- 新规则应用到**全部模式**（solo / score / battle，含 2v2），天梯积分与基准成绩**清零**（历史对局保留、仍可回放复盘）。
- 果实数 = **参赛人数 × 4**。
- 蛇头撞到**非队友**的蛇身出局；头对头**短者出局、等长同归于尽**；score 与 battle 都适用，**队友仍可互相穿过**。
- Python 运行时用 **Pyodide（完整 CPython，WebAssembly）**。
- 对局中 Agent 不直接接入：比赛只由平台沙箱里的脚本执行；Agent 通过 MCP / REST / CLI 提交代码、检测、开赛、查看回放与复盘。这一点现状已满足，只需在文档中写明。

协调者已提交的部分（**不要改语义**；如确需新增，只做可选增量并在状态文件说明）：

- `server/src/types.ts`：`ScriptLanguage`、`Ruleset`、`CURRENT_RULESET='survival-64'`、`DEFAULT_MAX_HP=100`、`DeathReason` 新增 `'starve'`、`MatchConfig.ruleset/maxHp`、`ParticipantInput.source.language?`、`FrameSnake.hp`、`SnakeView.hp`、`InitInfo.maxHp`、`ScriptState.maxHp`、`DryRunInput.language?`。
- `server/src/api-types.ts`：`ScriptSummaryDTO.language`、`ReviewSeries.hp`、`ReviewParticipantStats.minHp/lowHpTicks`、`ScriptTrendDTO.ruleset`。`web/src/types.ts` 为拷贝。
- `server/src/db.ts`：`user_version=4`，`scripts.language`（默认 `javascript`，CHECK），天梯条目积分/场次/基准成绩清零。
- `runner/config.ts`：`normalizeConfig()`（旧配置补 `ruleset:'classic'`、`maxHp:null`），已用于 `services/matches.ts` 读取配置与回放。
- 脚手架：引擎 `Snake.hp` 初始化为 `config.maxHp`（尚无扣减逻辑），观测/帧/复盘把 `hp` 透传；`defaultConfig` **暂时仍生成 classic**；各处死因标签已含 `starve`。
- `runner/trace.test.ts` 的两个哈希基线已改为冻结的 classic 配置：它们证明“classic 规则对局逐字节不变”，**必须保持通过**。

---

## 1. 规则 survival-64（工人 A）

### 1.1 地图与果实

- 所有模式 `width=64, height=64, wrap=false`；越界即撞墙（`'wall'`）。
- `foodCount = 4 × 参赛人数`（solo 4、2 人 8、3 人 12、4 人 16）。开局随机生成；被吃后立即在随机空格补齐。食物只由 `config.seed` 派生的引擎 RNG 决定，脚本与内置 bot 不得消耗它。
- 只有一种果实：吃到 **长度 +1、分数 +10、生命值回满**。
- `createGame` 的校验放宽到 `foodCount ≤ 64`。`maxTicks` 维持 solo 1500 / score 500 / battle 1000。出生点仍在四角附近（现有 `spawnPose` 公式），朝向不变。

### 1.2 生命值

- `maxHp=100`，开局 `hp=100`。
- 每拍对**本拍碰撞结算后仍存活**的蛇：吃到果实 → `hp = maxHp`；否则 `hp -= 1`；`hp` 降到 0 → 死亡，原因 `'starve'`，死亡事件 message 用“生命值耗尽”。一口不吃的蛇在第 100 拍死亡。
- 同拍因碰撞死亡的蛇不再判饥饿。`classic`（`maxHp=null`）完全不涉及生命值。

### 1.3 碰撞（score 与 battle 相同；solo 只有墙 / 自己 / 饥饿）

所有判定都是“同时结算”：先算出每条存活蛇本拍移动后的新头与新身体（吃到则不去尾），再统一判死。

1. **撞墙**：新头越界 → `'wall'`。
2. **头对头**：两条**非队友**蛇的新头在同一格，或二者互换位置（A 的新头是 B 的旧头且 B 的新头是 A 的旧头） → 比较**本拍移动前**的长度：短者 `'head'` 死亡，击杀记给长者；等长则双方都 `'head'` 死亡，不记击杀。三条及以上新头同格：唯一最长者存活，其余死；最长者并列则全部死亡。头对头的胜者本拍不会因败者的身体（包括互换时败者的新颈部）而死。
3. **撞自己**：新头落在自己新身体（不含新头）上 → `'self'`。
4. **撞他蛇**：新头落在某条**非队友**蛇的新身体上（不含其新头；新头相遇属于第 2 条） → `'snake'`，击杀记给身体的主人。被撞的蛇若本拍撞墙等原因死亡，用其旧身体判定（与现有引擎一致）。
5. 队友之间不阻挡、不发生头对头。死亡蛇的身体从下一拍起不再是障碍。

### 1.4 引擎版本与兼容

- `ENGINE_VERSION = 'serpent-engine-3'`。`runner/replay.ts` 同时接受 `serpent-engine-2`（其配置经 `normalizeConfig` 后为 classic）与 `serpent-engine-3`。
- `ruleset === 'classic'` 时引擎行为必须与 engine-2 **逐字节一致**（包括 score 模式穿墙、蛇之间互不伤害、头对头双亡、`foodCount ≤ 4` 的旧配置）。动手前先用当前代码生成至少一个 classic 回放 fixture（含 score 穿墙与 battle 对撞）存进测试，改完后断言重放帧完全相同。
- `defaultConfig` 改为生成 `ruleset:'survival-64', maxHp:100`、64×64、无穿墙、`foodCount = 4 × players`。`db.ts` 的 `seedLadders` 不要手写配置，改为调用 `defaultConfig`（这是唯一允许改 `db.ts` 的地方）；`services/ladders.ts` 中覆盖 `foodCount` 的地方改为同一规则，读取 `config_json` 时用 `normalizeConfig`。
- `game/observe.ts` 的 `asciiGrid` 在 64×64 下保持可读（每行 66 字符）；如需新增图例在 rules 文档说明。

### 1.5 其他

- 内置 bot：greedy / coward / random 适配新规则（score 模式不再穿过他蛇；coward 在 hp 低于到最近果实的安全距离时也去吃；头对头时避开不短于自己的蛇头）。不得消耗食物 RNG。
- 试跑场景 `runner/scenarios.ts` 改为 64×64：保留 id `trap-one-exit`（唯一安全出口仍为 `right`，`jobs.ts` 依赖它）；`score-wrap` 改为 `edge-wall`（score 模式贴边，不能穿墙）；新增 `low-hp-food`（hp 很低、最近果实可达，应朝果实走）、`head-on-longer`（自己更长，可以迎头）、`head-on-shorter`（自己更短，必须避开）。
- `runner/benchmark.ts` 的 BFS 脚本适配无穿墙与生命值。
- JS 示例 `examples/scripts/*.js` 适配：读取 `state.maxHp` / `you.hp`（为 null 时按 classic 处理）、`state.wrap`；flood-fill 在生命值不足时优先吃，头对头时利用长度优势。验收：全部通过 `validateScript`；flood-fill 在固定 seed 的 battle 中对 greedy 严格占优且无超时（`mcp/examples.test.ts`）。
- 复盘 `game/review.ts`：`hp` 序列与 `minHp`、`lowHpTicks`（存活且 `hp ≤ 25`）；`starving` 时刻改为“存活且 `hp ≤ 25` 且（最近果实不可达或 `foodDist ≥ hp`）的连续段首拍”，severity `warn`；`starve` 死亡给出建议（引用 hp、最近果实距离、上次进食拍）；`classic` 对局保持原逻辑。64×64、1000 拍、4 人整局复盘目标 < 1500ms（报告实测）。
- 趋势 `services/trends.ts`：只统计 `ruleset = 当前规则集` 的对局（`json_extract(m.config_json,'$.ruleset')`；缺失视为 classic），`ruleset` 字段返回当前规则集。
- 文档：`server/src/docs/rules.md`、`ladders.md`（新赛季清零说明）、`review.md`。

## 2. Python 脚本（工人 B）

### 2.1 接口 `serpent-script-v1`（Python）

```python
def init(info):          # 可选，每局一次
    pass

def move(state):         # 必须，每拍一次
    legal = state["legalMoves"]
    return legal[0] if legal else state["you"]["dir"]
```

- `info` / `state` 是普通 `dict` / `list`（JSON 转换，**不是** JsProxy），字段与 JS 完全相同。
- 返回 `"up" | "down" | "left" | "right"`（大小写不敏感）或 `{"direction": ...}`；`print()` 进入日志（每局 200 行、每行 500 字符，仅所有者可见）。
- 限制与 JS 相同：代码 64KB、init 500ms、move 50ms、单局 CPU 30s；内存为**解释器基线之上** 32MB。超时 / 报错 / 非法返回 / 掉头：保持原方向；连续 50 次失败失格（同 JS）。
- 确定性：`random` 按 `seed/slot` 播种；`time.time / monotonic / perf_counter` 返回确定值（与 JS 的 `Date.now()` 一致思路，文档提示不要用墙钟做预算）；`os.urandom`、`random.SystemRandom` 禁用或确定化。
- 可用纯 Python 标准库（math、heapq、collections、itertools、functools、bisect、array、dataclasses、typing、random 等）。禁止：`js`、`pyodide`、`pyodide_js`、`_pyodide`、`micropip`、`ctypes`、`socket`、`subprocess`、`threading`、`multiprocessing`、`asyncio`、文件写入、网络、`loadPackage`。

### 2.2 安全（必须多层，任何一层失效都不能直接触达宿主）

1. **一个解释器只服务一个作业**：一个对局里的一个参赛者，或一次检测 / 试跑；用后销毁，绝不在不同所有者或不同对局之间复用。检测作业内部可复用，但每个场景 / 模拟使用全新的 `__main__` 命名空间。
2. **进程隔离**：解释器在独立子进程中运行，`env` 为空；启用 Node 权限模型（只读 Pyodide 资源与宿主入口文件，禁止写文件、子进程、原生插件）；加 `--disallow-code-generation-from-strings`；加载完成后清除 JS 全局上的 `process`、`require`、`fetch`、`WebSocket` 等，并移除 Emscripten 的 `NODEFS` 等宿主文件系统；Python 侧阻断 2.1 中的禁用模块。
3. **超时**：用 Pyodide 中断缓冲（SharedArrayBuffer）触发 `KeyboardInterrupt`，计为 timeout 并保留脚本状态；宽限期内仍不返回则杀进程并失格，`firstError` 说明原因。
4. 内存或 CPU 超限 → 失格；返回值与日志的大小限制同 JS（`MAX_SANDBOX_RESULT_BYTES` 等）。
5. **逃逸测试**至少覆盖：导入每个禁用模块；通过 `sys.modules`、`__import__`、`importlib`、`gc.get_objects()`、`object.__subclasses__()`、`__builtins__` 等找回被禁模块；`open('/etc/passwd')` 与读取仓库源码；写文件；`js.process`、`js.fetch`；挂载 `NODEFS`；死循环、深递归、内存炸弹、超量 `print`、返回超大对象；同局两个 Python 参赛者互相读取对方全局变量。每条测试断言**宿主未受影响**，而不只是“抛了错”。在状态文件中写明残余风险。

### 2.3 集成

- `ScriptSandbox` 接口按语言分派；runner 调用可以改为 `await`（`runSimulation` 已是 async）。JS 路径行为不得改变（现有沙箱测试与 trace 哈希基线必须通过）。
- 冷启动用预热池隐藏；并发上限可配置（如 `PYTHON_WARM_HOSTS`、`PYTHON_MAX_HOSTS`），写进文档。报告：单个解释器启动耗时与内存、一局 4 个 Python 参赛者 1000 拍的总耗时、Python 脚本完整检测耗时。
- 依赖：`pyodide`（固定版本）。安装命令必须带 `--registry=https://registry.npmmirror.com`。运行时**不得联网**下载任何东西。说明 `node dist/` 部署时 Pyodide 资源与宿主入口文件的路径。
- `validateScript(code, language)`：Python 编译检查用 `compile()`，`has-move` 检查顶层 `move`；其余检测项与 JS 相同。
- 语言贯通：`services/scripts.ts`（创建时确定 `language`，之后不可改；`ScriptSummaryDTO.language`）、`services/matches.ts`（参赛者 source 带上 language）、`services/script-input.ts`、`routes/**`（create / validate / dry-run 接受 `language`；dry-run 用 `scriptId` 时由脚本决定）、MCP 工具（`validate_code`、`dry_run`、`create_script` 加 `language`，描述与 `write_snake_script` prompt 加语言参数，`serpent://examples/*` 增加 Python 示例）、CLI（`push`/`validate`/`dry-run` 按 `.py` 扩展名识别）。
- Python 示例：`examples/scripts/greedy-bfs.py`、`flood-fill.py`，与 JS 版策略同等；策略只读 `state` 字段（`wrap`、`maxHp`、`hp`），不要写死规则，以便同时适配 classic 与 survival-64。新测试放在独立文件（如 `mcp/examples-python.test.ts`），不要改 `mcp/examples.test.ts`。
- 文档：`server/src/docs/script-api.md`（含 `hp`/`maxHp` 字段与 Python 接口）、`overview.md`（写明对局中 Agent 不直接接入）、`mcp.md`、`rest.md`。

## 3. 前端（工人 C，只改 `web/src/**`）

- 规则文案：开一局 / 大厅 / 天梯等处凡提到 24×16、28×20、穿墙、蛇之间互不伤害的地方改为新规则；天梯页提示“新赛季（survival-64）积分已清零”。
- 棋盘 `Arena.tsx`：64×64 下清晰可读（小格时弱化网格线、蛇头仍醒目、果实最多 16 个）；可选用透明度表示低生命值。
- 参赛者卡片：按当前帧 `snakes[].hp` 与 `config.maxHp` 显示生命条，`hp ≤ 25` 用警示色；`hp === null`（classic）时不显示。
- 复盘区：新增生命值折线（含 `maxHp` 参考线）；`starving` 时刻与 `starve` 死因的中文标签（`DEATH_LABEL` 已含）；`minHp`、`lowHpTicks` 显示在当前拍检查器 / 参赛者汇总中。classic 对局隐藏生命值相关 UI。
- 脚本语言：创建脚本处提供 JavaScript / Python 选择（创建后不可改），列表与脚本页显示语言徽标，代码编辑区按语言给出模板和占位提示；`api.ts` 的创建 / 检测 / 试跑请求带 `language`。
- 趋势面板注明“仅统计当前规则（survival-64）”。
- 不新增依赖；1280px 与 390px 不溢出。

## 4. 文件归属

| 工人 | 独占文件 |
|---|---|
| A 规则 | `server/src/game/**`、`runner/config.ts`、`runner/replay.ts`、`runner/scenarios.ts`、`runner/benchmark.ts`、`services/ladders.ts`、`services/trends.ts`、`db.ts` 中的 `seedLadders`、`examples/scripts/*.js`、`mcp/examples.test.ts`、docs `rules.md`/`ladders.md`/`review.md`，以及相应测试 |
| B Python | `server/src/sandbox/**`、`runner/jobs.ts`、`runner/index.ts`、`runner/worker.ts`、`services/scripts.ts`、`services/matches.ts`、`services/script-input.ts`、`routes/**`、`mcp/**`（`examples.test.ts` 除外）、`cli/**`、`examples/scripts/*.py`、`server/package.json` 与 `pnpm-lock.yaml`、docs `script-api.md`/`overview.md`/`mcp.md`/`rest.md`，以及相应测试 |
| C 前端 | `web/src/**`（`types.ts` 只读） |
| 协调者 | 共享类型、`db.ts` 迁移、`AGENTS.md`、`README.md`、`docs/arena/**`、合并与集成验收 |

三人各在独立 worktree / 分支工作，合并由协调者完成。只改自己的文件；发现需要他人配合时写进自己的状态文件。

---

## 后续调整：规则集 `survival`（取代 survival-64 作为当前规则）

用户在验收后调整：

- 地图：solo、个人 score、个人 battle 为 **16×16**；2v2 团队赛（score / battle）为 **32×32**。
- score 也在只剩一条蛇（2v2 为只剩一队）存活时结束（`endReason='last_alive'`），名次仍按分数（2v2 按全队总分）。
- 天梯积分与基准成绩再次清零（DB `user_version=5`），历史对局保留。

实现上新增规则集 `survival`（`CURRENT_RULESET`），而不是修改 `survival-64`：已记录的 survival-64 对局必须按原结束条件逐拍重放，否则回放会出现“对局结束后仍有方向记录”的错误。生命值、碰撞结算对 `survival-64` 与 `survival` 相同（`hasHitPoints(ruleset)`），只有提前结束仅对 `survival` 生效。引擎版本仍为 `serpent-engine-3`，行为由配置中的 `ruleset` 区分。
