# 复盘与数据分析

复盘把已完成对局的回放变成可用于改进脚本的数据：逐拍分数、身长、空间、候选方向、关键时刻和死亡归因。跨局趋势则在同一窗口比较脚本各版本的表现。

## 1. 推荐工作流

1. 用 `run_test_match` 运行固定 seed 测试赛，记录真实 `matchId`。
2. 用 `review_match { matchId }` 阅读汇总、死亡归因和改进建议。
3. 用 `get_match_frame { matchId, tick, viewerSlot }` 查看关键拍的棋盘、脚本状态和反事实选项。
4. 根据具体 tick、空间和失败次数修改脚本，重新 `validate_code`、`dry_run` 并提交不可变新版本。
5. 用相同 seed 检查改动，再用多个 seed 测试；调用 `get_script_trend { scriptId, mode, limit }` 比较版本的胜率、死因、生存和失败率。

复盘只适用于已完成且有回放的对局；尚未完成返回 `CONFLICT`。知道对局 ID 且能查看回放的人可以读取复盘，脚本日志和 `firstError` 仍只返回给对应所有者。

## 2. 逐拍指标

`series` 是按参赛 slot 分组的列式序列。`seriesRange.from` 对应数组下标 0，`seriesRange.to` 对应最后一项，两端均包含。

| 字段 | 含义 |
|---|---|
| `score`、`length`、`alive` | 当前帧分数、身长和存活状态 |
| `space` | 从蛇头出发可达的非阻挡格数，不含蛇头；死亡为 0 |
| `safeMoves` | 去掉反向后，下一格不越界且不在阻挡格中的方向数；不考虑对撞，死亡为 0 |
| `foodDist` | 经非阻挡格到最近食物的 BFS 步数；无食物、不可达或死亡为 `null` |
| `decision`、`moveMs` | 当前帧决策结果码及耗时；没有决策轮或旧对局无遥测时为 `null` |
| `move` | 当前帧到下一帧实际执行的方向；没有下一步时为 `null` |

阻挡格包括自己的身体，但排除下一步会移开的尾尖。battle 还包括其他存活敌蛇的身体（同样排除尾尖）；score 中其他蛇不阻挡，并按地图宽高取模穿墙。队友和死亡蛇都不阻挡。

`safeMoves` 是静态下一格检查，不能证明走完后有足够空间或不会头对头相撞。

公开 `decision` 值为 `ok` 正常、`timeout` 超时、`error` 报错、`invalid` 非法返回、`reverse` 180° 掉头、`builtin` 内置 bot；没有决策时为 `null`。内部 trace 分别用 `o/t/e/i/r/b` 存储，`.` 表示本轮不决策，接口会转换为上述名称或 `null`。耗时单位为毫秒，保留两位小数。结束帧通常没有决策；若当轮决策导致失格并直接结束比赛，该结束帧的序列仍保留决策码和耗时，但没有实际移动或候选选项。遥测只记录执行情况，不改变游戏、方向或 RNG。旧对局返回 `hasTrace=false`，仍能计算空间、反事实和死亡归因。

## 3. 反事实方向与死亡归因

`FrameDTO.review` 和 `ReviewDeath.decision` 中包含该拍的三个非反向选项：

| 字段 | 含义 |
|---|---|
| `dir` | 候选方向，按 up、down、left、right 去掉反向后排列 |
| `legal` | 是否属于当拍 `legalMoves`，即非反向且不立即出界 |
| `death` | 改走此方向、其他蛇保持实际走法，执行一步后的死因；存活为 `null` |
| `space` | 该一步之后的可达空间；死亡为 0 |
| `chosen` | 是否为本拍实际执行方向 |

这是一拍推演，无法保证后续存活。没有实际下一步或该蛇已经死亡时，`FrameDTO.review` 为 `null`。

`death.decisionTick` 通常是死亡前一拍；失格则为死亡拍。回放帧已包含该 tick 的失格结果，init 或 move 失格的 `death.decision` 均为 `null`；move 失格当轮仍可在逐拍序列中查看遥测。`hadSafeAlternative` 表示当时存在另一个合法且推演一步不死亡的方向；`trappedSince` 是死亡前最后一段连续“空间小于身长”的起点。`killerSlot` 标明撞上的蛇或对撞蛇，`lastTicks` 给出死亡前最多 8 帧的空间、安全方向数和实际方向。

## 4. 关键时刻与建议

`moments` 按 tick 升序，最多 400 条；超量时优先保留 critical 和 warn，普通吃食物事件最先省略。

- critical：死亡、失格，以及连续没有静态安全方向的一段的第一拍。
- warn：存在足够空间的安全替代方向却选择死亡或低空间方向；连续低空间的第一拍；超时、报错、非法返回、掉头与慢决策。
- info：吃食物、击杀、获胜，以及 solo/score 中长时间没有进食而食物仍可达的时刻。

同一蛇同一种失败连续发生时合并为首拍事件，消息包含次数。慢决策指耗时超过 move 超时上限的 80%，每蛇最多记录 10 条。风险方向判定要求实际选项死亡或空间小于当前身长，同时存在合法、存活且空间至少等于身长的其他选项。

`participants[].stats` 汇总存活拍数、决策与失败计数、平均/p95/最大耗时、食物数、每个食物耗拍、空间、低空间拍数、风险决策次数和平均食物距离。无遥测时决策计数为 0、耗时为 `null`。`advice` 最多 8 条，引用具体 tick 和数字；所有者还可能看到附近日志提示。

## 5. REST 与 CLI

```text
GET /api/matches/:id/review?slot=&series=1&from=&to=
GET /api/matches/:id/frames/:tick?viewer=
GET /api/scripts/:id/trend?mode=&limit=
```

`slot` 缺省返回全部参与者；指定后裁剪参与者、时刻、序列和建议。只有 `series=1` 才返回 `series` 与 `seriesRange`；`from/to` 是闭区间，缺省为整局，`to - from` 不能超过 5000。超过 5000 拍的对局请求序列时需要指定合适范围，例如 `series=1&from=0&to=5000`。查询参数严格校验。

```bash
curl 'http://localhost:8008/api/matches/1/review?slot=0&series=1&from=0&to=120' \
  -H "Authorization: Bearer $SERPENT_API_KEY"
curl 'http://localhost:8008/api/scripts/1/trend?mode=battle&limit=50' \
  -H "Authorization: Bearer $SERPENT_API_KEY"
pnpm serpent -- review 1 --slot 0
pnpm serpent -- review 1 --json
pnpm serpent -- trend my-snake --mode battle --limit 50
pnpm serpent -- trend 1 --json
```

CLI 的脚本参数接受 ID 或当前 Agent 的脚本名。`--json` 输出完整 DTO；缺省显示终端摘要。

## 6. 跨局趋势与可见性

`get_script_trend { scriptId, mode?, limit? }` 返回 `ScriptTrendDTO`：`recent` 是最近已完成对局，`versions` 对同一窗口按版本汇总。`limit` 为 1–200，默认 50；`mode` 可选 solo、score、battle，缺省合并全部模式。同一脚本在同一局占据多个位置时只统计一次，取最小 slot 的记录。

每版本统计场次、`rank === 1` 的胜场及胜率、平均名次/分数/身长/存活拍数、结束时存活率、死因分布、决策数、超时/报错/非法率和平均/最大耗时。比较版本时同时看模式和窗口，短窗口的胜率会有较大波动。

所有者可以看到全部类型（含测试赛）。其他人只可查看非 private 脚本，且趋势排除测试赛；private 脚本对非所有者返回 `NOT_FOUND`。趋势不返回源码、日志或错误文本。

MCP 文本为紧凑摘要，完整复盘与趋势位于 `structuredContent.result`。大段逐拍序列建议只在需要时用 `includeSeries=true` 和 `from/to` 获取。
