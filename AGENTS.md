# AGENTS.md — SERPENT / 蛇场

给 **写代码的 Agent** 和 **下场玩游戏的 Agent** 看的项目手册。改代码前先读本文件；README.md 是给人扫一眼的简介，细节以这里和源码为准。

工作目录：`serpent/`（pnpm workspace）。人用前端 `http://localhost:3308`，机器用后端 `http://localhost:8008`。

---

## 1. 这是什么

联网贪吃蛇平台：

- 人类登录后开房、观战、可选下场
- 用户绑定自己的 LLM（Chat Completions 或 Anthropic Messages）
- 有绑定 LLM 时 **锁步**：所有存活 LLM Agent 都返回方向（或超时）后，才共同前进 **一格**
- 超时默认 **10s**，可设 **3～60s**；超时则 **沿原方向** 走，不用贪心抢跑
- 大厅能看到正在打的房间，点「观战」即可，不必记房间号

三种模式：

| mode | 规则 |
|---|---|
| `solo` | 1 条蛇。吃食物 +10。撞墙/咬自己结束 |
| `score` | 2–4 条。穿墙、互不伤害。目标分或 **墙钟时间** 到，分高者胜 |
| `battle` | 2–4 条。撞墙/自己/别人都死。最后存活者胜 |

---

## 2. 给写代码的 Agent：怎么开发

### 2.1 命令

在 `serpent/` 下：

```bash
pnpm install          # 需要编译 better-sqlite3、esbuild（onlyBuiltDependencies）
pnpm dev              # 后端 8008 + 前端 3308
pnpm test             # 服务端 node:test
pnpm build            # server tsc + web vite
pnpm start            # 只起后端；若有 web/dist 则一并托管
pnpm agent -- --mode solo   # 临时贪心脚本 bot
```

验证改动：

```bash
pnpm --filter server test
cd server && npx tsc --noEmit
cd ../web && npx tsc --noEmit
```

测试入口在 `server/package.json` 的 `test` script。新增 `*.test.ts` 后把它加进该 script。

### 2.2 目录

```
serpent/
  package.json              # workspace 脚本
  server/src/
    index.ts                # HTTP + Socket.IO 入口
    config.ts               # PORT / JWT / DB 路径
    auth.ts / db.ts / crypto.ts
    types.ts                # 前后端共享的游戏类型（web 有一份拷贝）
    game/engine.ts          # 纯逻辑：移动、碰撞、胜负
    game/room.ts            # 房间、锁步、LLM 调用、思考状态
    game/manager.ts         # Socket 事件、房间表、在线
    game/observe.ts         # ASCII 观测、toPublic
    game/bot.ts             # 练习用贪心/保守/随机（非用户 LLM）
    routes/auth.ts          # 注册登录
    routes/agents.ts        # 绑定 LLM / guest key
    routes/rooms.ts         # REST 房间
    a2a/protocol.ts         # A2A JSON-RPC
    agent/llm-client.ts     # 调上游模型 + 解析 up/down/left/right
    agent/cli.ts            # 脚本 bot
  web/src/
    App.tsx                 # /login / /agents / /r/:code
    pages/LobbyPage.tsx     # 大厅、超时设定、LIVE 观战
    pages/GamePage.tsx      # 棋盘、派遣、思考状态
    pages/AgentsPage.tsx    # 绑定/改提示词
    components/Arena.tsx    # canvas
    socket.ts / api.ts / auth.tsx
  server/data/              # sqlite、.jwt_secret —— 不要提交
```

### 2.3 架构要点

- **内存房间**：`GameManager` 单例，重启即丢对局。持久化只有用户和绑定 Agent（SQLite）。
- **人类开房默认不下场**（不是一条蛇）。要玩：`room:seat` 或大厅「加入」带 `play: true`。Agent Key 创建房间会坐下。
- **锁步**（`room.ts` `lockstep`）：`llmByPlayer` 非空则不用 110ms 定时器。并行问每个存活 LLM → 都返回或超时 → `step()` 一格。练习 Bot（有 `strategy`）在 step 前 `applyBots()`。
- **观战**：开打后 `room:join` 不坐下，只 `enterSocket`。广播按 `socket.data.roomId` 推 `room:state`，等模型时 400ms heartbeat。前端 600ms 轮询 `GET /api/rooms/:id` 兜底。
- **类型双份**：改 `server/src/types.ts` 时同步 `web/src/types.ts`（没有共享包）。
- **密钥**：上游 API Key `enc1:` + AES-256-GCM（`crypto.ts`）。JWT 在 `server/data/.jwt_secret` 或 `JWT_SECRET`。

### 2.4 改代码时的约定

- 语言：服务端 TypeScript CommonJS（tsx）；前端 React 18 + Vite。
- 校验：边界用 **zod**；错误体 `{ error: { code, message } }`。
- 方向枚举：`up | down | left | right`，禁止 180° 掉头（`queueDirection`）。
- 吃食物 **+10**。比分模式时限用 **墙钟**（锁步里 `step(state, { elapsedMs: Date.now() - wallStart })`），不要只用 `tickMs` 累加冒充秒。
- 不要把 LLM 超时回退成贪心寻路；超时 = 保持 `dir`。
- 不要提交 `server/data/`、`node_modules/`、`.screenshots/`、真实 API Key。
- 不要在日志里打印完整 API Key 或 JWT。
- 用户可见文案用简体中文；标识符用英文。

### 2.5 常见改动该动哪

| 你想改 | 文件 |
|---|---|
| 碰撞/得分/胜负 | `game/engine.ts` + `engine.test.ts` |
| 锁步、超时、思考状态 | `game/room.ts` |
| Socket 事件 | `game/manager.ts` + `web/src/socket.ts` |
| REST | `routes/*.ts` |
| 调模型/解析方向 | `agent/llm-client.ts` |
| 登录/绑定 Agent UI | `web/src/pages/*`、`auth.tsx`、`api.ts` |
| 画布 | `web/src/components/Arena.tsx` |

---

## 3. 给人类：怎么玩

1. `pnpm dev`，打开 http://localhost:3308 ，注册。
2. **我的 Agent** →「新增 Agent」或左侧「＋ 新增」→ 填显示名、协议、Base URL、模型、Key、提示词 → **创建 Agent**。可点「探测」。
3. 回大厅，拖 **Agent 每步最长思考**（3–60s，默认 10）。
4. 点 SOLO / SCORE / BATTLE 开房。你是房主，**默认观战**。
5. 右侧 **派遣 Agent** 把模型派进房间（至少两人局要两条蛇：再派一个或点「下场参赛」/「练习 Bot」）。
6. 点 **开局**。侧栏看「思考中 / 已决策 / 超时，沿原方向」。
7. 别人打开大厅，在 **正在对局** 点那一行 **观战**。

操作：WASD / 方向键。手机可在棋盘上滑动。

---

## 4. 给玩游戏的 Agent：怎么接入

有三条通道。网页绑定的 LLM 走锁步；脚本/A2A 自己 `act`，不显示思考胶囊。

协议三选一：

| protocol | 请求 |
|---|---|
| `chat` | `POST {base}/chat/completions`，OpenAI messages |
| `message` | `POST {base}/messages`，Anthropic messages |
| `jev` | `POST {base}/v1/systemone`，TypeSafe。模型如 `jev-latest`，默认 Base `https://api.typesafe.ai`。对每个合法方向发 `type: noul` 问题，取 `answers.*.noul` 最高分 |
| `laya` | 同一 `POST {base}/v1/systemone`（[Laya](https://github.com/NandhaKishorM/laya) 与 Jev 兼容）。默认 Base `http://127.0.0.1:8787`，模型 `laya` / `laya-multilingual` / `laya-typed-decisions`。一次 `type: choice` 问题，读 `answers.move.choice` |

### 4.1 观测格式 `serpent-v1`

`GET /api/rooms/:id/observe`（Header `X-Agent-Api-Key`）或 A2A 返回的 data/text。

- `H` 你的头，`B` 你的身体，`h`/`b` 别人，`*` 食物，`#` 墙，`.` 空
- `legalMoves`：本拍合法方向（已去掉 180°）
- 只回复一个词：`up` `down` `left` `right`（中文 上/下/左/右 也能解析）

网页绑定 LLM 时，服务端会把 **系统提示词 + 本拍观测** 发给上游；模型不要解释。

### 4.2 REST 脚本 Bot

```
POST /api/agents/guest          { "name": "bot-1" }  → apiKey
POST /api/rooms                 X-Agent-Api-Key, { "mode": "solo"|"score"|"battle", "thinkTimeoutSec": 10 }
POST /api/rooms/:code/join
POST /api/rooms/:code/ready
POST /api/rooms/:code/start     仅房主
GET  /api/rooms/:code/observe
POST /api/rooms/:code/act       { "direction": "up" }
```

人类开的房：`POST /api/rooms` + `Authorization: Bearer`，房主不下场。绑定 LLM 派遣：`POST /api/rooms/:code/deploy` `{ "agentId": 1 }`（必须 JWT）。

已开打再 `join`：只观战，不坐下。

### 4.3 A2A JSON-RPC

- Card：`GET /.well-known/agent-card.json`
- RPC：`POST /a2a`
- 技能：`play_solo` / `play_score` / `play_battle` / `observe` / `act`
- 文本示例：`play battle`、`join ABCD`、`up`、`观察`
- 也可 data part：`{"action":"act","direction":"left"}`

同一 `taskId` / `contextId` 续步。`message/stream` 会 SSE 推 tick。

### 4.4 Socket.IO（前端同一套）

鉴权：`handshake.auth.token` = 登录 JWT。

| 事件 | 方向 | 含义 |
|---|---|---|
| `room:create` | ↑ | `{ mode, thinkTimeoutSec? }` 开房，房主不下场 |
| `room:join` | ↑ | `{ code, play?: true }` 无 `play` 只观战；`play: true` 且大厅则坐下 |
| `room:seat` | ↑ | 大厅里下场参赛 |
| `room:ready` / `room:start` / `room:bot` / `room:deploy-agent` | ↑ | 准备 / 开局 / 练习 Bot / 派遣绑定 LLM |
| `room:config` | ↑ | `{ thinkTimeoutSec }` 仅房主、仅大厅 |
| `game:act` | ↑ | `{ direction }` |
| `room:state` / `room:joined` | ↓ | 局面；`players[].think` 为思考状态 |
| `rooms:list` / `presence:list` | ↓ | 大厅列表、在线 |

`think.status`：`idle` | `thinking` | `done` | `timeout` | `error`。

---

## 5. HTTP 地图

| 路径 | 谁 |
|---|---|
| `POST /api/auth/register` `login`；`GET /api/auth/me` | 账号 |
| `GET/POST /api/agents` JWT；`PATCH/DELETE /api/agents/:id`；`POST .../test` | 绑定 LLM |
| `POST /api/agents/guest` | 临时脚本 key |
| `GET /api/agents/me` | `X-Agent-Api-Key` |
| `GET /api/rooms`；`POST /api/rooms` | 列表/创建 |
| `GET /api/rooms/:id` | 观战拉状态（前端轮询） |
| `POST /api/rooms/:id/deploy` | JWT 派遣 |
| `GET /api/health` | 探活 |
| `GET /api/presence` | JWT 在线 |

错误：`{ "error": { "code": "UNAUTHORIZED"|"NOT_FOUND"|..., "message": "..." } }`。

---

## 6. 不要做的事

- 不要把用户上游 Key、JWT、`.jwt_secret` 写进 git 或对话日志。
- 不要为「动得快」把锁步改回固定 110ms + 贪心兜底（已经证明会看起来像在玩、其实不是模型在控）。
- 不要只改 `server/src/types.ts` 忘了 `web/src/types.ts`。
- 不要假设进程重启后房间还在。
- 不要用房主账号开房却期望自己是第三条蛇——默认不是；要玩请 `room:seat`。

---

## 7. 自检清单（改完再交）

- [ ] `pnpm --filter server test` 绿
- [ ] `server` / `web` `tsc --noEmit` 绿
- [ ] 人类开房：`players` 里没有房主，除非点了下场或 `play: true`
- [ ] 有 LLM：一步一问，超时沿原方向，侧栏状态会变
- [ ] 大厅「正在对局」能点进观战，棋盘会随 `tick` / `think` 更新
- [ ] 新密钥不会以明文出现在 sqlite 的 `api_key`（应为 `enc1:` 前缀）
