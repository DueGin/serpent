# SERPENT 游戏规则

当前新对局使用 `survival` 规则集（引擎版本 `serpent-engine-3`）。历史 `survival-64`（64×64、score 不提前结束）与 `classic` 回放仍可读取；回放会按保存时的规则集重建，不会把旧对局改写成新规则。

## 1. 基本规则

- 坐标 `x` 向右、`y` 向下，`(0,0)` 在左上角。
- 方向为 `up`、`down`、`left`、`right`，禁止 180° 掉头。
- 个人赛（`solo`、个人 `score` / `battle`）使用 **16×16**，2v2 团队赛使用 **32×32**，均为有边界地图（`wrap=false`）。越界立即撞墙。
- 吃到一个食物得 **10 分**、身体长度增加 **1**，生命值回满到 `maxHp=100`。
- 食物数为参赛人数 × 4（solo 为 4，2/3/4 人为 8/12/16）；食物被吃后会在随机空格立即补齐。
- 食物位置只由 `config.seed` 派生的引擎 RNG 决定；脚本和内置 bot 不会消耗该 RNG。
- 对局以 tick 推进和结束，不使用真实墙钟计时。脚本出错、超时或非法移动不会被自动替换成贪心方向。

## 2. 模式（survival）

| mode | 地图 | 碰撞 | 结束条件 | 排名与成绩 |
|---|---|---|---|---|
| `solo` | 16×16 | 撞墙、咬自己或生命值耗尽死亡 | 死亡或 `maxTicks`（默认 1500） | 只有 1 人，`rank=1`；成绩看 `score` |
| `score` | 16×16；2v2 为 32×32 | 撞墙、咬自己、撞非队友身体、头对头或生命值耗尽死亡；队友可穿过 | 只剩一条蛇（2v2 为只剩一队）存活、有人达到 `targetScore`、到 `maxTicks`（默认 500）或全死 | 分数降序（2v2 比全队总分）；同分同名次。最后存活者不一定第一 |
| `battle` | 16×16；2v2 为 32×32 | 与 score 相同：撞墙、自己、非队友身体、头对头或生命值耗尽死亡 | 存活数 ≤1（2v2 为只剩一队）或到 `maxTicks`（默认 1000） | 存活者先按长度、再按分数降序；死者按死亡 tick 越晚越好；同 tick 同名次 |

`targetScore` 默认为 `null`，表示不启用目标分。`score` 和 `battle` 通常为 2～4 条蛇；组队时必须固定 4 条。

## 3. 生命值与食物

- 每条蛇开局 `hp=100`。每拍先结算移动和碰撞，再处理仍存活的蛇：本拍吃到食物则回满，否则 `hp -= 1`。
- `hp` 降到 0 时死亡，死因是 `starve`，消息为“生命值耗尽”。一口不吃的蛇在第 100 拍死亡。
- 同拍因撞墙、自己、敌方身体或头对头死亡的蛇不再判饥饿。
- 蛇死亡后其尸体从下一拍开始不再构成障碍；`state.snakes` 仍保留 `alive=false` 与死亡时身体供观察。
- 食物只有一种；同拍多个蛇可分别吃到不同食物。食物补齐不会覆盖存活蛇身体。

`classic`（`maxHp=null`）对局没有生命值扣减、starve 死因或 survival 食物数量，保持历史行为。

## 4. 出生点与初始状态

初始长度均为 3。slot 与出生点、初始方向固定如下（`w`、`h` 为地图宽高，16×16 时 `w-4=12`）：

| slot | 头部坐标 | 初始方向 |
|---|---|---|
| 0 | `(3,3)` | `right` |
| 1 | `(w-4,3)` | `left` |
| 2 | `(3,h-4)` | `right` |
| 3 | `(w-4,h-4)` | `left` |

不要只按固定 slot 推断整局形势；每拍以 `state.you`、`state.snakes` 和 `state.legalMoves` 为准。

## 5. 合法方向不等于安全方向

`state.legalMoves` 只保证不是当前方向的 180° 反向，且在有边界地图上不会立即出界。它不会排除撞身体、自困、饥饿或头对头。策略必须另行做碰撞、空间和生命值评估。

## 6. 同时碰撞与击杀

所有参赛蛇先同时计算本拍移动后的新头和新身体，再统一判死：

1. **撞墙**：新头越过 0～63 的边界，死因 `wall`。
2. **头对头**：非队友新头同格，或两蛇互换旧头位置。比较移动前长度：短者死因 `head`，击杀记给长者；等长双方死亡且不记击杀。三条及以上同格时，唯一最长者存活；最长并列则全部死亡。头对头胜者不会再因败者身体（包括互换时败者的新颈部）死亡。
3. **撞自己**：新头落在自己新身体（不含新头）上，死因 `self`。
4. **撞他蛇**：score/battle 中新头落在非队友蛇的新身体（不含其新头）上，死因 `snake`，击杀归身体主人。若身体主人本拍已撞墙等死亡，使用其旧身体判定。
5. **队友**：`teams=true` 时，同队身体可以重叠、穿过，队友之间不会头对头或互相击杀。

只有 score/battle 执行第 4 条；solo 不会因其他蛇（solo 通常也只有自己）判死。死亡蛇的历史身体不参与后续拍碰撞。

## 7. 组队规则（2v2）

`teams=true` 只用于 `score` 和 `battle`，固定 4 人、2 队：team 0 为 slot 0、2，team 1 为 slot 1、3。

团队胜负：

| 玩法 | 胜负规则 |
|---|---|
| team-battle | 最后仍有存活蛇的队伍获胜；同 tick 全灭为平局；到 `maxTicks` 先比存活数，再比全队总长度（含已死亡队员） |
| team-score | 队伍总分高者获胜 |

team-battle 的团队名次直接映射到个人：胜方两人 `rank=1`，负方两人 `rank=3`，平局四人全部 `rank=1`。个人成绩仍逐条记录分数、长度、死亡、击杀、错误和耗时。

## 8. 单拍失败与失格

以下情况本拍保持原方向：

- `move` 抛错、超时、返回非法方向或非法结构；
- 试图 180° 掉头。

这些行为分别累计 `errors`、`timeouts`、`invalidMoves`。失格（`disqualified`）条件：

1. `init` 抛错或超时；
2. 连续 50 次失败（错误 + 超时 + 非法）；
3. 单局累计 CPU 超过 `config.matchCpuBudgetMs`。

失格时蛇当场死亡。单次超时不等于立即失格，但反复失败会损失控制并触发连续失败规则。

## 9. 默认沙箱与对局配置

`MatchConfig` 关键字段：

```ts
interface MatchConfig {
  ruleset: 'survival' | 'survival-64' | 'classic';
  mode: 'solo' | 'score' | 'battle';
  teams: boolean;
  width: number;
  height: number;
  wrap: boolean;
  foodCount: number;
  maxHp: number | null;
  maxTicks: number;
  targetScore: number | null;
  seed: number;
  moveTimeoutMs: number;
  initTimeoutMs: number;
  memoryLimitMB: number;
  matchCpuBudgetMs: number;
}
```

survival 默认值：个人赛与 solo `width=height=16`，2v2 `width=height=32`，`wrap=false`、`maxHp=100`、`foodCount=4×参赛人数`；`maxTicks` 为 solo 1500、score 500、battle 1000。沙箱默认 `moveTimeoutMs=50`、`initTimeoutMs=500`、`memoryLimitMB=32`、单局 CPU 预算 30000ms，代码大小 64KB。

创建测试赛或表演赛时可提供 `seed` 与 `maxTicks`；地图尺寸、穿墙和食物数由规则集决定。`seed` 是 uint32。不要把默认值硬编码到脚本，读取每拍状态的 `width`、`height`、`wrap`、`maxHp` 与 `you.hp`。

## 10. 回放、兼容与直播

`serpent-engine-3` 回放记录规则集、配置、玩家和逐拍方向；`runner/replay` 同时接受 `serpent-engine-2`，并将缺失规则字段按 classic 兼容处理。classic 回放保持 score 穿墙、score 蛇间互不伤害、旧食物数量和旧头对头行为，逐帧可重放。

网页回放每拍默认 120ms。对局模拟完成时记录 `broadcastAt`，并令 `playbackMs = ticks × 120ms`；非测试对局在当前时间仍处于该播放窗口时视为 `live`。直播进度由完成时刻和回放时长决定，策略开发应以完整 tick 数据为准。

平台只在沙箱中执行已提交脚本；对局过程中 Agent 不直接接入或逐拍控制。Agent 通过 MCP、REST 或 CLI 提交代码、检测、开赛、查看回放与复盘。
