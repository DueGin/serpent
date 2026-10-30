# SERPENT 游戏规则

## 1. 基本规则

- 坐标 `x` 向右、`y` 向下，`(0,0)` 在左上角。
- 方向为 `up`、`down`、`left`、`right`，禁止 180° 掉头。
- 吃到一个食物得 **10 分**，身体长度增加 **1**。
- 对局以 tick 为单位推进和结束，不用真实墙钟计时。
- 食物位置只由 `config.seed` 派生的引擎 RNG 决定；脚本不能消耗引擎 RNG。
- 脚本独立运行，出错、超时或非法移动不会被自动替换成贪心方向。

## 2. 模式

| mode | 地图 | 穿墙 | 碰撞 | 结束条件 | 排名与成绩 |
|---|---|---|---|---|---|
| `solo` | 24×16 | 否 | 撞墙或咬自己死亡 | 死亡或 `maxTicks`，默认 1500 | 只有 1 人，`rank=1`；成绩看 `score` |
| `score` | 28×20 | 是 | 蛇之间互不伤害；咬自己死亡 | 有人达到 `targetScore`、到 `maxTicks`（默认 500）或全死 | 分数降序；同分同名次 |
| `battle` | 28×20 | 否 | 撞墙、咬自己、撞别人身体死亡；头对头双亡 | 存活数 ≤1 或到 `maxTicks`，默认 1000 | 存活者先按长度、再按分数降序；死者按死亡 tick 越晚越好；同 tick 同名次 |

`targetScore` 默认为 `null`，表示不启用目标分。`score` 和 `battle` 通常为 2～4 条蛇；组队时必须固定 4 条。

食物数量：

- `solo`：1 个。
- `score` / `battle`：`max(3, min(4, 玩家数))`，即 2 人 3 个、3 人 3 个、4 人 4 个。

## 3. 出生点与初始状态

初始长度均为 3。slot 与出生点、初始方向固定如下：

| slot | 头部坐标 | 初始方向 |
|---|---|---|
| 0 | `(3,3)` | `right` |
| 1 | `(w-4,3)` | `left` |
| 2 | `(3,h-4)` | `right` |
| 3 | `(w-4,h-4)` | `left` |

不要只按固定 slot 推断整局形势；每拍以 `state.you`、`state.snakes` 和 `state.legalMoves` 为准。

## 4. 合法方向不等于安全方向

`state.legalMoves` 只保证：

1. 不是当前方向的 180° 反向；
2. 非穿墙时不会立即出界。

它不会排除撞身体、自困或头对头。策略必须另行做碰撞与空间评估。若返回 180° 反向或其他非法值，本拍保持原方向并累计失败。

## 5. 击杀与头对头

- A 的头撞上非队友 B 的身体，A 死亡，B 的 `kills += 1`。
- 非队友头对头时双方死亡，不记击杀。
- `score` 模式蛇之间互不伤害，因此不按 battle 的身体或头对头规则淘汰对手。
- **死亡蛇的尸体不再构成障碍**：碰撞计算会移除尸体；`state.snakes` 仍保留 `alive=false` 与死亡时 `body` 供观察，不要把它当作存活对手或实体墙规划下一步。

## 6. 组队规则（2v2）

`teams=true` 只用于 `score` 和 `battle`，固定 4 人、2 队：

- team 0：slot 0、2。
- team 1：slot 1、3。

队友之间：

- 身体不构成障碍，可以重叠、穿过；
- 头对头不会死亡；
- 击杀判定不适用于队友。

团队胜负：

| 天梯/玩法 | 胜负规则 |
|---|---|
| team-battle | 最后仍有存活蛇的队伍获胜；同 tick 全灭为平局；到 `maxTicks` 先比存活数，再比全队总长度（含已死亡队员） |
| team-score | 队伍总分高者获胜 |

team-battle 的团队名次直接映射到个人 `rank`：胜方两人均为 `rank=1`，负方两人均为 `rank=3`，平局四人全部 `rank=1`。

个人成绩仍逐条记录，包括分数、长度、死亡、击杀、错误和耗时等。

## 7. 单拍失败与失格

以下情况本拍保持原方向：

- `move` 抛错；
- `move` 超过本拍时限；
- 返回非法方向或非法结构；
- 试图 180° 掉头。

这些行为分别累计 `errors`、`timeouts`、`invalidMoves`。失格（`disqualified`）条件：

1. `init` 抛错或超时；
2. 连续 50 次失败（错误 + 超时 + 非法）；
3. 单局累计 CPU 超过 `config.matchCpuBudgetMs`。

失格时蛇当场死亡。单次超时不等于立即失格，但反复超时既会损失控制，也会触发连续失败规则。

## 8. 默认沙箱与对局配置

`MatchConfig` 字段：

```ts
interface MatchConfig {
  mode: 'solo' | 'score' | 'battle';
  teams: boolean;
  width: number;
  height: number;
  wrap: boolean;
  foodCount: number;
  maxTicks: number;
  targetScore: number | null;
  seed: number;
  moveTimeoutMs: number;
  initTimeoutMs: number;
  memoryLimitMB: number;
  matchCpuBudgetMs: number;
}
```

默认值：

| 配置 | 默认 |
|---|---|
| `moveTimeoutMs` | 50ms |
| `initTimeoutMs` | 500ms |
| `memoryLimitMB` | 32MB |
| `matchCpuBudgetMs` | 30000ms |
| 代码大小 | 64KB（非 MatchConfig 字段） |

创建测试赛或表演赛时可提供 `seed` 与 `maxTicks`；地图尺寸、穿墙和食物数由模式与配置决定。`seed` 是 uint32。

## 9. 结果字段与结束原因

对局结束原因 `endReason`：

- `last_alive`：battle 只剩最后存活者；
- `all_dead`：全部死亡；
- `max_ticks`：达到 tick 上限；
- `target_score`：score 有人达到目标分。

`winners` 是获胜 slot 数组；平局可有多个，全灭可为空。组队结果另有 `winnerTeam`，未产生队伍胜者时为 `null`。

个人结果常用字段：

- `rank`：1 为最好，允许同名次；
- `score`、`length`、`alive`；
- `deathTick`、`deathReason`；
- `kills`、`moves`；
- `timeouts`、`errors`、`invalidMoves`；
- `avgMoveMs`、`maxMoveMs`、`cpuMs`。

死亡原因包括 `wall`、`self`、`snake`、`head`、`disqualified`。

## 10. 回放与“直播”

回放记录配置、玩家和逐拍方向；同一回放可确定性重建每一帧。网页回放每拍默认 120ms。

对局模拟完成时记录 `broadcastAt`，并令 `playbackMs = ticks × 120ms`。非测试对局在当前时间仍处于该播放窗口时视为 `live`。因此直播进度由完成时刻和回放时长决定，策略开发仍应以完整 tick 数据为准。
