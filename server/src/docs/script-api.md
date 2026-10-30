# 脚本接口：serpent-script-v1

每个参赛脚本在独立沙箱 runtime 中运行。平台每拍同步调用一次 `move(state)`，脚本返回本拍方向；每局开始时可调用一次 `init(info)`。

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

## 2. 生命周期与同步约束

- `init(info)`：每局开始最多调用一次，适合记录 slot、team、地图尺寸或初始化缓存。
- `move(state)`：每拍调用一次，必须同步返回方向或 `{ direction }`。
- 全局变量在同一局内跨拍保留；不同参赛者、不同对局不共享 runtime。
- 不支持模块加载、网络请求、定时调度或异步结果；不要返回 Promise。
- 代码不要超过 64KB；默认 `init` 上限 500ms、每次 `move` 上限 50ms、内存 32MB、单局累计 CPU 30s。

`Math.random()` 由 `(seed, slot)` 确定性播种，`Date.now()` 返回确定值，不暴露真实时间。不要尝试读取或改变引擎 RNG；同 seed、同脚本应得到同结果。优先使用固定方向顺序处理同分项，让策略天然确定。

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
}

interface Point { x: number; y: number }
```

字段注意事项：

- `tick` 是已走步数，从 0 开始；`remainingTicks` 用于终局策略。
- `snakes` 包含自己，也包含已死亡的蛇；死亡蛇 `alive=false`，`body` 保留死亡时位置，`head` 可能为 `null`。**死亡蛇的尸体不再构成障碍**，这些历史 `body` 只供观察，构建碰撞图时必须跳过 `alive=false` 的蛇。
- `body[0]` 是存活蛇的头；使用前应检查 `alive`、`head` 和数组长度，不要假设自定义试跑输入一定完整。
- `foods` 是当前全部食物坐标。
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

构建障碍图时按模式区分：

- 自己的身体在三种模式中都要处理。
- `battle` 中，非队友蛇身体是障碍；还要额外评估敌人下一拍进入同一格的头对头风险。
- `score` 中，其他蛇不伤害你，不要把它们误判成实体墙；咬自己仍会死。
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

`console.log`、`info`、`warn`、`error` 会被捕获：每局最多 200 行、每行最多 500 字符，仅脚本所有者可见。日志应记录 tick、候选方向和评分等短信息，不要记录 Key 或整份状态。

建议：

- 候选方向使用固定顺序，例如 `up/right/down/left`，再过滤 `legalMoves`。
- 同分比较使用固定字段，例如方向序号或坐标，不依赖对象遍历的偶然顺序。
- 不用真实时钟控制搜索深度；为循环设置确定的工作上限。
- 每次 `move` 只做有界计算，给 50ms 硬中断留余量。

## 9. 检测与试跑

### 检测

`validate_code` / `POST /api/scripts/validate` 只检测，不保存。检测报告包含：

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

内置场景至少有：`solo-open`、`solo-corner`、`food-adjacent`、`trap-one-exit`、`long-body-self-trap`、`battle-headon`、`score-wrap`、`team-mate-adjacent`。用 `list_scenarios` 或 `GET /api/scripts/scenarios` 获取含 `init` 和 `state` 的完整定义。

### 试跑

试跑输入可为：

```ts
interface DryRunInput {
  code: string;
  scenario?: string;
  state?: ScriptState;
  init?: InitInfo;
}
```

对存储脚本试跑时，可用 `scriptId` 和可选 `version` 代替 `code`。结果字段：

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

MCP 中读取 `serpent://examples/{name}`；仓库文件位于 `examples/scripts/{name}.js`。
