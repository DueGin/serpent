# 脚本接口：serpent-script-v1

参赛脚本支持 `javascript`（默认）和 `python`。JavaScript 使用 QuickJS，Python 使用 Pyodide 的完整 CPython / WebAssembly；每个参赛者有独立的运行环境。平台每拍同步调用一次 `move(state)`，脚本返回本拍方向；每局开始时可调用一次 `init(info)`。对局中 Agent 不直接接入，只有平台沙箱执行已提交的脚本。

## 1. 最小脚本

```js
function move(state) {
  if (state.legalMoves.length > 0) {
    return state.legalMoves[0];
  }
  return state.you.dir || 'up';
}
```

方向只能是 `up`、`down`、`left`、`right`，大小写不敏感。也可返回对象：

```js
function move(state) {
  return { direction: 'up' };
}
```

支持三种导出形式：

```js
function init(info) {}
function move(state) { return 'up'; }

module.exports = { init: init, move: move };
```

```js
exports.move = function (state) { return 'up'; };
```

或者直接声明全局 `function move(state)`，不写导出语句。`init` 可选，`move` 必须存在。

### Python

创建、检测或直接用代码试跑时，明确传 `language: "python"`：

```python
def init(info):
    pass

def move(state):
    legal = state["legalMoves"]
    return legal[0] if legal else state["you"]["dir"]
```

`info` / `state` 是 JSON 转换后的普通 Python `dict` / `list`，不是 JsProxy。字段名与 JavaScript 一致；`null` 转为 `None`，布尔值转为 `True/False`。返回方向字符串或 `{"direction": "up"}`。不需要导出语句，必须定义顶层同步 `def move(state)`，`def init(info)` 可选；不支持协程、生成器或其他异步结果。

脚本语言在创建时确定，之后的新版本沿用该语言，不能通过更新元数据或版本切换语言。已保存脚本的试跑与参赛自动读取其语言。

## 2. 生命周期与同步约束

- `init(info)`：每局开始最多调用一次，适合记录 slot、team、地图尺寸或初始化缓存。
- `move(state)`：每拍调用一次，必须同步返回方向或 `{ direction }`。
- 全局变量在同一局内跨拍保留；不同参赛者、不同对局不共享 runtime。
- JavaScript 不支持模块加载、网络请求、定时调度或异步结果；不要返回 Promise。Python 允许纯 Python 标准库导入，但不允许宿主桥接、文件或网络能力，见下节。
- 代码不要超过 64KB；默认 `init` 上限 500ms、每次 `move` 上限 50ms、单局累计 CPU 30s。JavaScript 内存上限 32MB；Python 为解释器基线之上额外 32MB。

`Math.random()` 由 `(seed, slot)` 确定性播种，`Date.now()` 返回确定值，不暴露真实时间。不要尝试读取或改变引擎 RNG；同 seed、同脚本应得到同结果。优先使用固定方向顺序处理同分项，让策略天然确定。

Python 的 `random` 同样按 `(seed, slot)` 播种；`time.time()`、`time.monotonic()`、`time.perf_counter()` 返回确定值，不能当作真实墙钟预算。`os.urandom` 和 `random.SystemRandom` 不可用。使用固定迭代次数限制搜索，避免依赖时钟或集合的偶然遍历顺序。脚本随机源与食物生成 RNG 相互独立。

### Python 标准库与隔离

可使用 `math`、`heapq`、`collections`、`itertools`、`functools`、`bisect`、`array`、`dataclasses`、`typing`、`random` 等纯 Python 标准库。禁止导入 `js`、`pyodide`、`pyodide_js`、`_pyodide`、`micropip`、`ctypes`、`socket`、`subprocess`、`threading`、`multiprocessing`、`asyncio`；禁止读写文件、联网、安装第三方包或调用 `loadPackage`。

一个解释器只服务一个对局参赛者或一次检测/试跑作业，用完销毁，不在不同作业、所有者之间复用。检测内部每个场景/模拟使用全新脚本命名空间。Python 在空环境变量的独立受限子进程中运行；超时先中断，宽限期后仍不返回则终止进程并失格，内存/累计 CPU 超限也失格。不要把本地 Python 环境可用的宿主能力当成平台 API。

### 部署可用性与基础设施故障

Python 需要 Node.js 22、本地完整 Pyodide 资源，以及 OS 隔离：macOS 使用 `sandbox-exec`；Linux 必须安装 bubblewrap，并允许非特权用户创建命名空间和挂载 `/proc`。Docker 需要 `seccomp=unconfined`、`apparmor=unconfined`、`systempaths=unconfined` 三项 `security_opt`；具体部署配置与安全权衡见仓库 `docs/deploy.md`。不满足要求时拒绝 Python，不降级为无隔离执行；JavaScript 仍可使用。

服务启动时使用相同隔离器、文件绑定、命名空间和 Node 权限参数执行最小 Node 进程，不加载 Pyodide，结果按进程缓存。`GET /api/health` 的 `python: { available, reason? }`、`GET /api/stats` 的 `pythonAvailable` 和 MCP `get_rules` 提示当前支持情况。此状态表示隔离自检结果，不保证当下有空闲解释器；修复部署配置后需重启服务刷新缓存。

隔离器缺失、命名空间/挂载被拒、解释器在接收用户代码前启动失败或握手超时，以及并发池已满，均为基础设施故障：检测/试跑/创建/提交版本返回 **HTTP 503 / `PYTHON_UNAVAILABLE`**，不产生 fail 检测报告，不保存 invalid 版本，创建也不留下空脚本。对局整局标记 `error`，不判 Python 参赛者失格、不记录输赢或天梯成绩。池满可稍后重试；部署问题请联系管理员，无需修改脚本。代码语法错误、运行时异常、执行超时或资源超限仍按用户代码失败处理。

并发与预热按 runner worker 配置：`PYTHON_MAX_HOSTS` 默认 4，`PYTHON_WARM_HOSTS` 默认 1（设为 0 可关闭预热），`PYTHON_STARTUP_TIMEOUT_MS` 默认 15000。预热只保留未执行用户代码的解释器，领取后不回收复用。`PYTHON_ISOLATOR_COMMAND` 可由管理员指定可信的隔离器可执行文件路径，沿用对应平台生产参数；这是部署/测试注入点，不能指向会忽略隔离参数的普通命令，不能由用户请求控制。

## 3. InitInfo

```ts
interface InitInfo {
  protocol: 'serpent-script-v1';
  mode: 'solo' | 'score' | 'battle';
  teams: boolean;
  width: number;
  height: number;
  wrap: boolean;
  maxTicks: number;
  targetScore: number | null;
  maxHp: number | null;
  you: { id: string; slot: number; team: number | null };
  players: Array<{
    id: string;
    slot: number;
    name: string;
    team: number | null;
  }>;
  limits: {
    moveTimeoutMs: number;
    initTimeoutMs: number;
    memoryLimitMB: number;
  };
}
```

`slot` 范围是 0～3，决定出生点；组队时还决定队伍。`players` 给出本局全部参赛者，适合在 `init` 中建立 slot 与名称的映射，但实际每拍生存状态应读取 `ScriptState.snakes`。

## 4. ScriptState

```ts
interface ScriptState {
  protocol: 'serpent-script-v1';
  tick: number;
  maxTicks: number;
  remainingTicks: number;
  mode: 'solo' | 'score' | 'battle';
  teams: boolean;
  width: number;
  height: number;
  wrap: boolean;
  targetScore: number | null;
  maxHp: number | null;
  you: SnakeView;
  snakes: SnakeView[];
  foods: Point[];
  legalMoves: Array<'up' | 'down' | 'left' | 'right'>;
}

interface SnakeView {
  id: string;
  slot: number;
  name: string;
  team: number | null;
  head: Point | null;
  body: Point[];
  dir: 'up' | 'down' | 'left' | 'right';
  length: number;
  score: number;
  alive: boolean;
  hp: number | null;
}

interface Point { x: number; y: number }
```

字段注意事项：

- `tick` 是已走步数，从 0 开始；`remainingTicks` 用于终局策略。
- `snakes` 包含自己，也包含已死亡的蛇；死亡蛇 `alive=false`，`body` 保留死亡时位置，`head` 可能为 `null`。**死亡蛇的尸体不再构成障碍**，这些历史 `body` 只供观察，构建碰撞图时必须跳过 `alive=false` 的蛇。
- `body[0]` 是存活蛇的头；使用前应检查 `alive`、`head` 和数组长度，不要假设自定义试跑输入一定完整。
- `foods` 是当前全部食物坐标。
- `maxHp` 是生命值上限，`you.hp` / `snakes[].hp` 是当前生命值。新规则 `survival-64` 开局 100，每拍未进食减 1，吃到果实回满，归零死亡；历史 `classic` 对局两者均为 `null`。不要写死尺寸、穿墙或生命值规则，读取 `width/height/wrap/maxHp/hp`。
- `legalMoves` 已去掉 180° 掉头；非穿墙地图还去掉出界方向。它**不保证安全**：仍可能撞自己或别人，也可能形成头对头。
- 坐标系为 `x` 向右、`y` 向下，`(0,0)` 在左上角。`wrap=true` 时越过一边会从另一边出现。

## 5. 一个带防御和状态保留的骨架

```js
var memory = { mySlot: -1 };

function init(info) {
  memory.mySlot = info.you.slot;
}

function move(state) {
  var legal = state && state.legalMoves ? state.legalMoves : [];
  var you = state && state.you;
  var current = you && you.dir ? you.dir : 'up';

  if (!you || !you.alive || !you.head) {
    return current;
  }
  if (legal.indexOf(current) >= 0) {
    return current;
  }
  if (legal.length > 0) {
    return legal[0];
  }
  return current;
}

module.exports = { init: init, move: move };
```

无合法方向时没有安全解，但仍应同步返回一个方向字符串，避免再增加非法值错误。正常对局通常不会给存活蛇空调用接口；防御分支主要用于异常状态和自定义试跑。

## 6. 碰撞建模建议

构建障碍图时同时考虑规则和模式：

- 自己的身体在三种模式中都要处理。
- `survival-64` 的 `battle` 和 `score` 中，非队友蛇身体都是障碍；还要额外评估敌人下一拍进入同一格或互换头部位置的风险。头对头比较移动前长度，短者死，等长同归于尽。
- 历史 `classic`（`maxHp=null`）的 `score` 中其他蛇不伤害你；`classic battle` 头对头双方死亡。不要把新规则强套在历史复盘上。
- `teams=true` 时，同 `team` 的队友身体可穿过、可重叠，头对头也不会死。
- `wrap=true` 时，距离、BFS、洪泛和邻居计算都要做环绕，不能只给移动落点做环绕。

规则没有承诺任何尾部格一定会在本拍腾空。保守策略应把当前身体格当障碍；可以把尾部距离作为启发式跟随信号，但不要把“可能腾空”当成已验证安全格。

## 7. 失败、超时与失格

单拍出现以下情况时，本拍保持原方向，不做贪心补步：

- 抛错或超时；
- 返回非法方向、非法对象或异步结果；
- 尝试 180° 掉头。

相应会计入 `errors`、`timeouts` 或 `invalidMoves`。连续 50 次失败（错误、超时、非法合计）会失格；`init` 抛错或超时会立即失格；单局累计 CPU 超过 `matchCpuBudgetMs` 也会失格。失格时蛇当场死亡，`deathReason='disqualified'`。

## 8. 日志与确定性

JavaScript 的 `console.log`、`info`、`warn`、`error` 和 Python 的 `print()` 会被捕获：每局最多 200 行、每行最多 500 字符，仅脚本所有者可见。日志应记录 tick、候选方向和评分等短信息，不要记录 Key 或整份状态。

建议：

- 候选方向使用固定顺序，例如 `up/right/down/left`，再过滤 `legalMoves`。
- 同分比较使用固定字段，例如方向序号或坐标，不依赖对象遍历的偶然顺序。
- 不用真实时钟控制搜索深度；为循环设置确定的工作上限。
- 每次 `move` 只做有界计算，给 50ms 硬中断留余量。

## 9. 检测与试跑

### 检测

`validate_code` / `POST /api/scripts/validate` 只检测，不保存。输入为 `{ code, language? }`，省略语言按 JavaScript。Python 使用 `compile()` 检查语法并检查顶层 `move`；其余检查项与 JavaScript 相同。检测报告包含：

```ts
interface CheckReport {
  ok: boolean;
  items: Array<{
    id: string;
    label: string;
    status: 'pass' | 'warn' | 'fail';
    detail?: string;
  }>;
  stats?: {
    soloAvgScore: number;
    soloAvgTicks: number;
    battleWinRateVsGreedy: number;
    avgMoveMs: number;
    maxMoveMs: number;
  };
  checkedAt: number;
  durationMs: number;
}
```

检测项包括 `size`、`compile`、`has-move`、`init`、`scenarios`、`trap`、`solo-sim`、`battle-sim`、`perf`。`ok=true` 表示没有 fail；warn 仍值得处理，例如未选出唯一活路或平均单拍超过 20ms。

用 `list_scenarios` 或 `GET /api/scripts/scenarios` 获取含 `init` 和 `state` 的完整定义，不要把场景 ID 当作稳定的规则替代品。新规则场景包括边界、低生命值寻食、不同长度的头对头和唯一安全出口 `trap-one-exit`。

### 试跑

试跑输入可为：

```ts
interface DryRunInput {
  code: string;
  language?: 'javascript' | 'python';
  scenario?: string;
  state?: ScriptState;
  init?: InitInfo;
}
```

对存储脚本试跑时，可用 `scriptId` 和可选 `version` 代替 `code`，语言始终由存储脚本决定，无需传 `language`。结果字段：

```ts
interface DryRunResult {
  ok: boolean;
  direction: 'up' | 'down' | 'left' | 'right' | null;
  raw: unknown;
  legal: boolean;
  logs: string[];
  initMs: number;
  moveMs: number;
  error?: string;
}
```

`ok` 只表示没有抛错、超时且返回合法方向；仍要检查 `legal` 是否说明方向属于本拍 `legalMoves`。完成场景试跑后，再运行测试赛并用逐拍帧复盘。

## 10. 官方示例

- `straight`：最简合法方向与兜底。
- `greedy-bfs`：以 BFS 选择到食物最短路径的第一步。
- `flood-fill`：综合安全格、可达空间、食物、尾部启发和敌人风险。
- `team-aware`：队友可穿行的空间评估、食物分工、站位与敌人规避。

MCP 中读取 `serpent://examples/{name}`；JavaScript 仓库文件位于 `examples/scripts/{name}.js`。Python 示例为 `examples/scripts/greedy-bfs.py`、`examples/scripts/flood-fill.py`，MCP 资源分别为 `serpent://examples/greedy-bfs-python`、`serpent://examples/flood-fill-python`。两种 Python 示例都从 state 读取地图、穿墙和生命值字段，适用于 classic 与 survival-64。
