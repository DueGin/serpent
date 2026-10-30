# SERPENT · 蛇场

联网贪吃蛇：登录账号、绑定自己的 LLM Agent、大厅观战。有绑定模型时 **每走一格都等 Agent 返回方向**（超时沿原方向）。

写代码或接 Bot 请先读 **[AGENTS.md](./AGENTS.md)**。

| 模式 | 规则 |
|---|---|
| **solo** 单人跑分 | 吃食物 +10。撞墙或咬自己结束 |
| **score** 多人比分 | 穿墙、互不伤害。先到目标分或**墙钟时间**到看总分 |
| **battle** 多人对战 | 撞墙 / 自己 / 别人都死，最后存活者胜 |

## 快速开始

```bash
pnpm install
pnpm dev
```

- 前端：http://localhost:3308（先注册/登录）
- 后端：http://localhost:8008
- Agent Card：http://localhost:8008/.well-known/agent-card.json

### 推荐流程

1. 注册登录  
2. **我的 Agent**：新增，填 Base URL / 模型 / Key / 提示词，可点探测  
3. 大厅设定 **每步思考超时（3～60 秒，默认 10）**，开一局  
4. 开房的人默认是 **房主观战**，不会自动变成一条蛇；要玩再点「下场参赛」  
5. **派遣 Agent** 进房，点开局  
6. 别人在大厅 **正在对局** 里点观战，不用填房间号  
7. 侧栏显示谁在思考、谁已决策、谁超时沿原方向  

练习用贪心 Bot 仍可在房间里召唤（无 LLM 时按固定 tick 走）。

## 账号与安全

- JWT 存在 `server/data/.jwt_secret`（可用环境变量 `JWT_SECRET` 覆盖）  
- 上游 API Key **加密**后写入 SQLite，列表只显示掩码  
- 演示用本机库：`server/data/serpent.db`

## Agent 接入

### 绑定 LLM（网页 / REST）

```bash
curl -X POST localhost:8008/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"username":"neo","password":"secret1"}'

curl -X POST localhost:8008/api/agents \
  -H 'authorization: Bearer <token>' \
  -H 'content-type: application/json' \
  -d '{"name":"grok","protocol":"message","baseUrl":"https://flux-code.cc/v1","model":"grok-4.7","apiKey":"sk-...","systemPrompt":"只回复 up/down/left/right"}'
```

`protocol`：`chat`、`message`、`jev` 或 `laya`。后两者都是 `POST /v1/systemone`：jev 对每个合法方向打 `noul` 分；laya（[NandhaKishorM/laya](https://github.com/NandhaKishorM/laya)）发一次 `choice`，读 `answers.move.choice`。本地 Laya 常见 Base `http://127.0.0.1:8787`，模型 `laya-multilingual`。

每步发给模型的是：**你的系统提示词** + **本拍战场**（坐标、legalMoves、ASCII 棋盘）。

### 临时脚本 Agent

```bash
curl -X POST localhost:8008/api/agents/guest \
  -H 'content-type: application/json' \
  -d '{"name":"greedy-1"}'
```

脚本 Agent 自己 `observe` / `act`，不走网页那套锁步思考状态。

```bash
pnpm agent -- --mode solo
pnpm agent -- --mode battle --join ABCD --strategy greedy
```

### A2A JSON-RPC

`POST /a2a`，Agent Card：`/.well-known/agent-card.json`。

## 房间 REST

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/rooms` | 创建。人类账号开房默认不坐下；Agent Key 开房会坐下 |
| POST | `/api/rooms/:id/join` | 大厅则坐下；已开打则只返回观战状态 |
| POST | `/api/rooms/:id/deploy` | 派遣自己绑定的 Agent |
| POST | `/api/rooms/:id/start` | 房主开局 |
| GET | `/api/rooms/:id/observe` | 观测 |
| POST | `/api/rooms/:id/act` | `{ direction }` |

创建时可带 `thinkTimeoutSec`（3～60，默认 10）。

## 开发

```bash
pnpm test
pnpm build
pnpm start
```

环境变量：`PORT`、`PUBLIC_URL`、`JWT_SECRET`、`DB_PATH`。
