# 复盘功能：合并验收

服务端与前端分别由 codex（Orca chat，gpt-6.1-sol / xhigh）和 kimi（Orca 终端，K3.1 Pro / max）并行完成，契约见 `docs/arena/REVIEW.md`，各自交付见 `review-server.md`、`review-web.md`。本文记录协调者的独立验收。

## 验证

| 项 | 结果 |
|---|---|
| `pnpm --filter server test` | 175/175 通过 |
| `server` `tsc --noEmit` | 通过 |
| `web` `tsc --noEmit` | 通过 |
| `pnpm build` | 通过（334 KB / gzip 109 KB） |
| 端到端（隔离端口 8120 + 临时库） | 见下 |

端到端脚本（注册 → 建 Agent → 推脚本 → 开赛 → 复盘 → 权限 → 趋势）：

- 3 人 battle 对局：完整复盘 42ms，命中缓存 3ms。
- 死亡归因正确：第 144 拍头对头，决策拍 143，三个方向的一步反事实与可达空间均符合实际；`trappedSince=140`。
- 脚本按预期返回 180° 掉头被记为 `reverse`，该拍的 `options` 中实际方向 `chosen=true` 且 `legal=false`，建议给出“选择 up 后撞墙，而 left 可达 382 格”。
- 匿名访问：看不到 `logs` / `firstError`；`slot` 过滤、`from/to` 闭区间裁剪（11 点）正确；`/frames/:tick` 带 `review`。
- 私有脚本趋势对他人返回 404；`listed` 脚本对他人只统计非测试赛（0 场）。
- CLI `serpent review <id>`、`review --json`、`trend <name>` 在真实服务上正常；`review 999` 返回“对局不存在”。

浏览器（ego-browser，隔离服务 8120 + 前端 3314）：

- 回放页：结果揭晓前复盘区门控；揭晓后可见分数/身长/可达空间图、逐拍决策条带、关键时刻筛选、死亡归因表（实际选择高亮、“跳到决策拍”）、死亡前 8 拍指标、改进建议、所有者日志。
- 棋盘覆盖层：安全候选绿、致死红、实际选择白框。
- 脚本页：所有者可见按版本的跨局趋势表与分数/名次走势；匿名访问显示空态（测试赛不计入他人统计）。

## 未覆盖

- 旧对局（无 `trace_blob`）的界面显示只在服务端测试覆盖，未在浏览器构造真实旧数据。
- 1000+ 拍 × 4 蛇的浏览器渲染未做压力测量；图表按蛇合并 path，不逐拍生成 DOM。
- 复盘分析在主线程同步计算，单进程受 64 条 LRU 限制；极端长局（>5000 拍）请求逐拍序列时需要 `from/to` 分段。
