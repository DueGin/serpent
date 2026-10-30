# 复盘（Match Review）契约

目标：每一局都能回放，并能看到**逐拍数据变化**、**关键时刻**、**死亡归因**和**跨局趋势**，让写脚本的 AI 基于数据改进脚本。

共享类型已经写好，**不要改字段名或语义**；如果确实需要新增字段，只做可选的增量，并同时改三处：

- `server/src/types.ts`：`DecisionCode`、`DecisionTrace`、`SimulateResult.trace?`
- `server/src/api-types.ts`：`FrameDTO.review`、`Review*`、`MatchReviewDTO`、`ScriptTrend*`
- `web/src/types.ts`：上面两者的拷贝

---

## 1. 决策遥测（runner，新数据）

现有 Replay 只存“实际执行的方向”，看不出这一拍是脚本正常返回，还是超时/报错/非法/掉头后保持原方向。新增 `DecisionTrace`：

- `runner/jobs.ts` 的 `runSimulation` 每个决策轮（`while (state.status === 'running')` 的一次循环）推入一条：
  - `codes[t]`：按 `replay.players` 顺序每人一个字符：`o` ok、`t` timeout、`e` error、`i` 非法返回、`r` 180° 掉头、`b` 内置 bot、`.` 本轮不决策（已死）。
  - `ms[t][i]`：脚本 `move()` 的 `result.elapsedMs`，保留 2 位小数；内置 bot 和不决策者为 `null`。
- 下标对齐：`t` = 该轮观察到的帧 tick（`state.tick`）。`replay.moves[t]` 是这一轮的执行结果。若这一轮的失格直接结束比赛，`codes` 比 `moves` 多 1 条，属正常。
- 遥测**绝不影响**游戏：不消耗任何 RNG、不改变方向选择；同 seed 同脚本的 replay 与以前逐字节一致。
- 持久化：DB 迁移到 `user_version = 3`，`ALTER TABLE matches ADD COLUMN trace_blob BLOB`，`saveResult` 存 `gzip(JSON(trace))`。旧对局 `trace_blob` 为 NULL → 复盘 `hasTrace=false`，`decision`/`moveMs` 全为 `null`，其余分析照常。
- 遥测公开：每拍的结果码与耗时和现有公开聚合（timeouts/errors/avgMoveMs）同级，不含代码、日志或错误文本。

## 2. 指标定义（server `game/review.ts`，纯函数）

记 `B(game, slot)` 为该蛇的**阻挡格**集合：

- 自己的身体，除去尾尖（`body[body.length-1]`，下一步会移开）。
- `battle` 模式：其他**存活**且**非队友**的蛇的身体，同样除去尾尖。
- `score` 模式：其他蛇不阻挡（穿行）；`solo` 只有自己。
- 死亡蛇不阻挡；队友不阻挡。
- 坐标邻接：`score` 模式 `wrap=true` 取模；否则越界即墙。

| 指标 | 定义 |
|---|---|
| `space` | 从蛇头 flood fill，可达的非阻挡格数量（不含蛇头本身）。死亡为 0。 |
| `safeMoves` | 除 180° 反向外的 3 个方向中，下一格不越界且不在 `B` 中的个数。不考虑对撞。死亡为 0。 |
| `foodDist` | 从蛇头经非阻挡格 BFS 到最近食物的步数；不可达、没有食物或已死为 `null`。 |
| `decision` / `moveMs` | 来自 trace；该帧没有决策轮（已死、比赛已结束、无 trace）为 `null`。 |
| `move` | `replay.moves[t]` 中该蛇实际执行的方向（`t→t+1`）；没有为 `null`。 |

**反事实选项 `ReviewTick.options`**（第 `t` 拍、某条蛇）：恢复第 `t` 帧的 GameState，对除 180° 反向外的 3 个方向逐一：

1. 深拷贝状态（`rng` 换成任意确定性函数，例如 `seedRng(0)`，只看这一步），其他蛇按 `replay.moves[t]` 实际方向入队，本蛇改用 `dir`，执行一次 `step`。
2. `legal`：`dir` 在当时的 `legalMoves` 里（即非反向且不立即越界）。
3. `death`：这一步后本蛇若死亡则为其 `deathReason`，否则 `null`。越界为 `'wall'`。
4. `space`：这一步后的新状态下按上表计算的 `space`；死亡为 0。
5. `chosen`：等于 `replay.moves[t]` 中本蛇的实际方向。

只有该蛇在第 `t` 帧存活且有 `replay.moves[t]` 时才有 `ReviewTick`；否则为 `null`。`options` 按 `up, down, left, right` 中去掉反向后的顺序排列。

**风险决策 `risky_move`**：第 `t` 拍实际方向的选项 `death !== null` 或 `space < 当前身长`，而另有某个 `legal` 选项 `death === null && space >= 当前身长`。

## 3. 关键时刻 `moments`

按 tick 升序，最多 400 条；超出时优先保留 `critical`、`warn`，`info` 中 `eat` 最先丢弃。`message` 用简体中文，写清 tick、蛇名、具体数字。

| kind | severity | 触发 |
|---|---|---|
| `death` | critical | 引擎 `die` 事件（含原因） |
| `disqualified` | critical | 失格（init 或连续 50 次失败 / CPU 预算） |
| `trapped` | critical | 存活且 `safeMoves === 0` 的连续段的第一拍 |
| `risky_move` | warn | 见上 |
| `low_space` | warn | 存活且 `space < 身长` 的连续段的第一拍 |
| `timeout` / `error` / `invalid` / `reverse` | warn | trace 结果码；同一蛇同一种类连续出现只记首拍并在 message 里写次数 |
| `slow_move` | warn | `moveMs > 0.8 × moveTimeoutMs`，每条蛇最多 10 条 |
| `starving` | info | `solo`/`score` 中距上次吃到（或开局）超过 `2 × (width + height)` 拍，且食物可达；每段只记一次 |
| `eat` / `kill` / `win` | info | 引擎事件；`kill` 是击杀者视角 |

## 4. 死亡归因 `ReviewDeath`

- `decisionTick`：一般为 `deathTick - 1`（导致死亡的那一轮所观察的帧）；`disqualified` 为 `deathTick`。
- `decision`：`decisionTick` 的 `ReviewTick`（init 失格为 `null`）。
- `hadSafeAlternative`：`decision.options` 中存在 `legal && death === null` 的非实际方向。
- `trappedSince`：死亡前最后一段连续 `space < 身长` 的起始 tick；没有为 `null`。
- `killerSlot`：`snake` 为撞上的那条蛇；`head` 为对撞的另一条蛇；其余 `null`。
- `lastTicks`：死亡前最多 8 帧的 `{ tick, space, safeMoves, move }`。

## 5. 汇总与建议

`ReviewParticipantStats`（全部来自 replay + trace，不读日志）：

- `survivalTicks` = `deathTick ?? ticks`；`decisions` = 有决策轮的拍数；`ok/timeouts/errors/invalid/reverses` 为 trace 计数（无 trace 时为 0）。
- `avgMoveMs / p95MoveMs / maxMoveMs`：trace 中该蛇非空 `ms`；内置 bot 或无 trace 为 `null`。
- `foods` 吃到次数；`ticksPerFood` = `survivalTicks / foods`（`foods=0` 为 `null`）。
- `avgSpace / minSpace`：存活帧上的平均/最小；`lowSpaceTicks`：存活且 `space < 身长` 的帧数。
- `riskyMoves`：风险决策次数；`avgFoodDist`：存活且非空 `foodDist` 的平均。

`advice: string[]`：规则生成的简体中文改进建议，最多 8 条，**必须引用具体 tick 和数字**，例如：

- 死亡且 `hadSafeAlternative`：“第 212 拍选择 left 后撞到自己，而 up 安全且可达 37 格。建议对每个候选方向做 flood fill，优先选可达空间 ≥ 身长的方向。”
- `trappedSince` 早于死亡：“从第 205 拍起可达空间一直小于身长（最少 4 格），被困 7 拍后死亡。追食物前先确认吃完后仍有退路。”
- 超时 / 报错 / 非法 / 掉头：给出次数、首拍和对应修复（减少搜索、加 try/catch、过滤 `OPPOSITE[you.dir]`、确保返回四个方向字符串之一）。
- `p95MoveMs` 接近上限、`riskyMoves` 偏多、`ticksPerFood` 偏高等。
- 有 `logs` 的所有者：提示“第 N 拍附近有 M 行日志”。

## 6. 接口

所有复盘都基于已完成对局；未完成返回现有 `CONFLICT`。复盘内容对能看到这局回放的人公开，`logs` 与 `firstError` 仅所有者可见（复用 `services/matches.ts` 里的 `ownAgent` 判定）。

### REST

```text
GET /api/matches/:id/review?slot=&series=1&from=&to=
GET /api/matches/:id/frames/:tick?viewer=      FrameDTO 新增 review: ReviewTick | null
GET /api/scripts/:id/trend?mode=&limit=        ScriptTrendDTO
```

- `slot`：只返回该 slot 的 participants/moments/series/advice；缺省返回全部。
- `series=1` 才返回 `series` 与 `seriesRange`；`from/to` 为闭区间，缺省为整局，`to - from` 最多 5000。
- `trend`：`mode` 可选；`limit` 1–200，默认 50，作用于 `recent`；`versions` 统计同一窗口。可见性：所有者看到全部类型（含测试赛）；他人只在脚本非 `private` 时可看，且只统计非测试赛。`private` 且非所有者返回 `NOT_FOUND`。`win` = `rank === 1`。

### MCP（`mcp/tools.ts`，只调用 services）

- `review_match { matchId, slot?, includeSeries?, from?, to? }`：文本部分给紧凑摘要——每名参赛者一行（名次、分数、身长、存活、死因、超时/报错、风险决策数）、每个死亡的归因、最多 20 条 critical/warn 时刻、全部 advice；`structuredContent.result` 是完整 `MatchReviewDTO`。
- `get_script_trend { scriptId, mode?, limit? }`。
- `get_match_frame` 的文本里追加该拍的选项表（方向 / 合法 / 反事实死因 / 可达空间 / 是否实际选择）。
- `run_test_match`、`get_match` 的“下一步”提示改为先 `review_match`；`write_snake_script` prompt 的第 6 步加入 `review_match` 与 `get_script_trend`。

### CLI（`cli/serpent.ts`）

- `serpent review <matchId> [--slot N] [--json]`
- `serpent trend <script> [--mode battle] [--limit 50] [--json]`（`<script>` 接受 id 或本 Agent 的脚本名，沿用现有解析方式）

### 文档

- 新增 `server/src/docs/review.md`（“复盘与数据分析”），注册到 `docs/index.ts`，会自动成为 `serpent://docs/review`。
- 更新 `rest.md`、`mcp.md`、`overview.md` 中的参赛流程，以及仓库根 `AGENTS.md` 第 4 节工作流与第 5 节 HTTP 地图。

## 7. 性能

- 复盘计算在主线程同步进行。对局结束后不可变，`services` 层按 `matchId` 做最多 64 条的内存 LRU，缓存**不含所有者字段**的完整结果，返回前再按 principal 加 logs/firstError 并按参数裁剪。
- 反事实分析只在需要时做：`risky_move` 需要逐拍选项，必须每个存活决策轮都算 3 次一步推演。重放时增量推进同一个 GameState，**不要**对每拍从头重放（O(n²)）。1000 拍 4 人 battle 的整局复盘目标 < 300ms。

## 8. 前端（`web/`）

- `api.ts`：`getMatchReview(id, { slot?, series?, from?, to? })`、`getScriptTrend(id, { mode?, limit? })`；`getMatchFrame` 已有，返回值多了 `review`。
- 回放页 `MatchPage.tsx` 增加复盘区（与回放共享 `frameIndex`）：
  - 分数 / 身长折线图（每条蛇一条线，颜色用 `players[].color`）和可达空间折线图（含“身长”参考线），带当前帧竖线，点击图表跳到该拍。
  - 决策条带：每条蛇一行、每拍一格，按 `decision` 着色（ok 绿、timeout 橙、error 红、invalid/reverse 紫、builtin 灰、空白为无决策）。
  - 关键时刻列表：按蛇、按严重度过滤，点击跳到该拍并暂停。
  - 死亡归因卡片：死因、凶手、`hadSafeAlternative`、被困起点、`decision.options` 表格（实际选择高亮），按钮“跳到决策拍”。
  - 当前拍检查器：选中某条蛇后显示该拍 space / safeMoves / foodDist / decision / moveMs / move；暂停时调用 `getMatchFrame(id, tick, slot)` 拿 `review.options`，在棋盘上标出候选格（安全绿、致死红、实际选择描边）。
  - 建议列表 `advice`；所有者可见的日志按当前拍附近对齐显示。
  - `hasTrace=false` 时决策条带显示“旧对局没有决策遥测”。
- 脚本页 `ScriptPage.tsx` 增加“跨局趋势”面板：按版本的表格（场次、胜率、平均名次、平均分、存活率、死因分布、超时/报错率、耗时），最近对局的分数/名次迷你图，最近对局链接到 `/matches/:id`。
- 图表用手写 SVG 组件（放在 `web/src/components/`），**不要新增依赖**。样式沿用 `index.css` 的暖黑 / 钠黄 / 信号红风格；文案简体中文。
