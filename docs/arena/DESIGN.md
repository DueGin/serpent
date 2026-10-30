# SERPENT Arena 改造设计（契约文档）

> 本文是多个 worker 并行开发的**唯一契约**。实现可以加字段、加函数，但**不得改名或删掉**这里列出的类型、函数、端点、字段。
> 发现契约有问题：在自己的状态文件里写明「契约问题」，不要私自改对方负责的文件。

## 0. 定位与核心变化

旧：每一步问 LLM 要方向（锁步）。
新：**Agent 编写 JavaScript 脚本，平台在沙箱里跑脚本参赛**。

- 一个用户（人类账号）可以拥有多个 Agent；一个 Agent 可以拥有多个脚本；脚本有不可变的版本。
- 平台提供：脚本**检测**（编译、接口、场景、迷你模拟）、**试跑**（dry-run）、**测试赛**、**表演赛**、**个人天梯**、**团队天梯**、回放与「直播」。
- Agent 通过 **MCP（Streamable HTTP，`POST /mcp`）**、**REST** 或 **CLI** 接入；人类通过网页管理 Agent、开表演赛、观战、看天梯。
- 已移除：绑定 LLM 锁步、A2A 逐步对局、llm-client、人类下场操作、旧的房间/大厅 socket 流程。
- 人类只观战。观战、天梯、Agent 主页、文档对未登录访客公开；管理类操作需要登录。

## 1. 名词

| 名词 | 说明 |
|---|---|
| User | 人类账号（已有 `users` 表、JWT） |
| Agent | AI 选手身份，属于某 User。持有平台 API Key（`agk_` 前缀），用于 MCP/REST |
| Script | 属于 Agent 的脚本，有名字、可见性、当前生效版本 |
| ScriptVersion | 不可变代码快照 + 检测报告 |
| Match | 一局对局：`test` 测试赛 / `exhibition` 表演赛 / `ladder` 天梯赛 / `benchmark` 单人基准赛 |
| Ladder | 天梯：`solo`（单人基准）、`battle`、`score`（个人 FFA）、`team-battle`、`team-score`（2v2） |
| Team | 多个 Agent 组成的队伍（可跨用户），一个 Agent 同时最多在 1 个队伍 |
| Builtin bot | 平台自带对手：`greedy` / `coward` / `random`（原生实现，不走沙箱） |

## 2. 游戏规则（引擎）

坐标：`x` 向右、`y` 向下，`(0,0)` 左上角。方向 `up|down|left|right`，禁止 180° 掉头。吃食物 +10、身体 +1。

| 模式 | 地图 | 穿墙 | 碰撞 | 结束 | 排名 |
|---|---|---|---|---|---|
| `solo` | 24×16 | 否 | 墙/自己死 | 死亡或 `maxTicks`(默认 1500) | 只有 1 人，rank=1；成绩=score |
| `score` | 28×20 | 是 | 互不伤害；咬自己会死 | 有人 ≥ `targetScore`(默认 null 不启用) 或 `maxTicks`(默认 500) 或全死 | score 降序；同分同名次 |
| `battle` | 28×20 | 否 | 墙/自己/别人身体死；头对头双亡 | 存活 ≤1 或 `maxTicks`(默认 1000) | 存活者按 length 降序、再 score 降序；死者按死亡 tick 越晚越好；同 tick 同名次 |

- **时限全部改为 tick 数**（`maxTicks`），不再用墙钟。
- 食物数：solo 1；score/battle `max(3, min(4, 玩家数))`。食物位置只由 `config.seed` 派生的引擎 RNG 决定（**bot/脚本绝不能消耗引擎 RNG**，否则回放会错）。
- 击杀：A 的头撞上 B（非队友）的身体，B 的 `kills += 1`。头对头双亡不记击杀。
- 出生点（slot 0..3）：`(3,3)→right`、`(w-4,3)→left`、`(3,h-4)→right`、`(w-4,h-4)→left`，初始长度 3。
- **组队（`teams: true`）**：仅 score/battle，固定 4 人 2v2；`team 0 = slot 0,2`，`team 1 = slot 1,3`。
  - 队友互相**不构成障碍**（可重叠穿过），头对头也不死。
  - team-battle：最后仍有存活蛇的队伍胜；同 tick 全灭为平局；到 `maxTicks` 时比存活数，再比队伍总长度。
  - team-score：队伍总分高者胜。
  - 个人成绩仍逐条记录。
- **死亡蛇不再构成障碍**（尸体从碰撞中移除）；`ScriptState.snakes` 里仍保留其 `alive=false` 与死亡时 `body` 供观察，画布淡化显示。
- team-battle 到 `maxTicks` 时：先比存活数，再比全队总长度（含已死亡队员）。团队名次：胜方两人 rank=1，负方两人 rank=3；平局全部 rank=1。
- `Replay.disqualifications?: Array<{ tick; slot; phase?: 'init' | 'move' }>`（core 新增可选字段）：方向字母无法表达失格，重放据此在对应 tick 判死。
- 脚本出错 / 超时 / 返回非法值 / 180°：**保持原方向**（与旧规则一致，不做贪心兜底），计入 `errors`/`timeouts`/`invalidMoves`。
- 失格（`disqualified`，蛇当场死亡）：`init` 抛错或超时；连续 50 次失败（错误+超时+非法）；单局累计 CPU 超过 `config.matchCpuBudgetMs`。

## 3. 脚本接口（`serpent-script-v1`）

```js
// 可选：每局开始调用一次
function init(info) {}

// 必须：每拍调用一次，返回方向
function move(state) {
  return 'up'; // 'up' | 'down' | 'left' | 'right'（大小写不敏感）；也接受 { direction: 'up' }
}
```

- 只支持同步函数；**不支持** `import`/`export`/`require`/`fetch`/`setTimeout`/Promise 结果。
- 也支持 `module.exports = { init, move }` 或 `exports.move = ...`（平台预置 `module`、`exports` 对象）。
- 全局变量在**同一局内**跨拍保留（每个参赛者独立 runtime）。
- `console.log/info/warn/error` 被捕获：每局最多 200 行、每行 500 字符；只对脚本所有者可见。
- `Math.random()` 按 `(seed, slot)` 确定性播种；`Date.now()` 返回确定值（不暴露真实时间）。
- 限制（默认，可在 `MatchConfig` 调整）：代码 ≤ 64KB；`init` ≤ 500ms；每次 `move` ≤ 50ms（超时即中断）；内存 ≤ 32MB；单局累计 CPU ≤ 30s。

```ts
interface InitInfo {
  protocol: 'serpent-script-v1';
  mode: GameMode; teams: boolean;
  width: number; height: number; wrap: boolean;
  maxTicks: number; targetScore: number | null;
  you: { id: string; slot: number; team: number | null };
  players: Array<{ id: string; slot: number; name: string; team: number | null }>;
  limits: { moveTimeoutMs: number; initTimeoutMs: number; memoryLimitMB: number };
}

interface ScriptState {
  protocol: 'serpent-script-v1';
  tick: number;              // 已走步数，从 0 开始
  maxTicks: number; remainingTicks: number;
  mode: GameMode; teams: boolean;
  width: number; height: number; wrap: boolean;
  targetScore: number | null;
  you: SnakeView;
  snakes: SnakeView[];       // 全部蛇，含自己、含已死亡（alive=false，body 为死亡时位置）
  foods: Point[];
  legalMoves: Direction[];   // 去掉 180°；非 wrap 时去掉出界方向；不保证安全
}

interface SnakeView {
  id: string;                // 's0'..'s3'，按 slot
  slot: number; name: string; team: number | null;
  head: Point | null; body: Point[];   // body[0] 为头
  dir: Direction; length: number; score: number; alive: boolean;
}
```

## 4. 共享类型（`server/src/types.ts`，core 负责；web 拷贝一份到 `web/src/types.ts`）

```ts
export type Direction = 'up' | 'down' | 'left' | 'right';
export type GameMode = 'solo' | 'score' | 'battle';
export type BuiltinBot = 'greedy' | 'coward' | 'random';
export type MatchKind = 'test' | 'exhibition' | 'ladder' | 'benchmark';
export type MatchStatus = 'queued' | 'running' | 'done' | 'error';
export type ScriptVisibility = 'private' | 'listed' | 'open';
export type VersionStatus = 'pending' | 'valid' | 'invalid';
export type DeathReason = 'wall' | 'self' | 'snake' | 'head' | 'disqualified';
export type EndReason = 'last_alive' | 'all_dead' | 'max_ticks' | 'target_score';
export interface Point { x: number; y: number }

export interface MatchConfig {
  mode: GameMode;
  teams: boolean;
  width: number; height: number; wrap: boolean;
  foodCount: number;
  maxTicks: number;
  targetScore: number | null;
  seed: number;              // uint32
  moveTimeoutMs: number;     // 50
  initTimeoutMs: number;     // 500
  memoryLimitMB: number;     // 32
  matchCpuBudgetMs: number;  // 30000
}

export interface ParticipantInput {
  slot: number;              // 0..3，决定出生点与组队
  name: string;
  team: number | null;       // teams=true 时必须 0/1，且 slot 0,2→0；1,3→1
  source: { kind: 'script'; code: string } | { kind: 'builtin'; bot: BuiltinBot };
}

export interface SimulateInput {
  config: MatchConfig;
  participants: ParticipantInput[];
  captureLogs?: boolean;     // 默认 true
}

export interface ParticipantResult {
  slot: number;
  rank: number;              // 1 = 最好；同名次允许
  score: number; length: number; alive: boolean;
  deathTick: number | null; deathReason: DeathReason | null;
  kills: number; moves: number;
  timeouts: number; errors: number; invalidMoves: number;
  avgMoveMs: number; maxMoveMs: number; cpuMs: number;
  firstError?: string;
  logs?: Array<{ tick: number; text: string }>;
}

export interface Replay {
  v: 1;
  engine: string;            // ENGINE_VERSION，例如 'serpent-engine-2'
  config: MatchConfig;
  players: Array<{ slot: number; name: string; team: number | null; color: string }>;
  moves: string[];           // 每拍一个字符串，长度 = 玩家数；'U'|'D'|'L'|'R'，已死亡/未移动为 '.'
}

export interface SimulateResult {
  ticks: number;
  endReason: EndReason;
  winners: number[];         // slot；平局可多个；全灭可为空
  winnerTeam: number | null; // 组队模式
  participants: ParticipantResult[];
  replay: Replay;
  durationMs: number;
}

export interface FrameSnake { slot: number; body: Point[]; dir: Direction; alive: boolean; score: number; length: number }
export interface FrameEvent { type: 'eat' | 'die' | 'win'; slot?: number; message: string }
export interface Frame { tick: number; snakes: FrameSnake[]; foods: Point[]; events: FrameEvent[] }

export type CheckStatus = 'pass' | 'warn' | 'fail';
export interface CheckItem { id: string; label: string; status: CheckStatus; detail?: string }
export interface CheckReport {
  ok: boolean;               // 无 fail 项
  items: CheckItem[];
  stats?: {
    soloAvgScore: number; soloAvgTicks: number;
    battleWinRateVsGreedy: number;
    avgMoveMs: number; maxMoveMs: number;
  };
  checkedAt: number; durationMs: number;
}

export interface ScenarioInfo { id: string; title: string; description: string; init: InitInfo; state: ScriptState }

export interface DryRunInput { code: string; scenario?: string; state?: ScriptState; init?: InitInfo }
export interface DryRunResult {
  ok: boolean;               // 没抛错、没超时、返回合法方向
  direction: Direction | null;
  raw: unknown;              // 脚本原始返回值（JSON 安全化）
  legal: boolean;            // direction ∈ state.legalMoves
  logs: string[];
  initMs: number; moveMs: number;
  error?: string;
}

export const PLAYBACK_TICK_MS = 120;   // 网页回放/直播每拍时长
export const COLORS = ['#e8c547', '#e23d2a', '#3ecf8e', '#4ea3f0'];
// 另外保留：DIRECTIONS / DELTA / OPPOSITE / pointKey / pointsEqual，以及 InitInfo / ScriptState / SnakeView
```

## 5. Runner API（`server/src/runner/index.ts`，core 负责）

```ts
export const ENGINE_VERSION: string;
export function defaultConfig(mode: GameMode, opts?: { teams?: boolean; seed?: number; maxTicks?: number; players?: number }): MatchConfig;
export function simulate(input: SimulateInput): Promise<SimulateResult>;           // 在 worker_threads 池里跑
export function validateScript(code: string): Promise<CheckReport>;                // 在池里跑；通常 < 5s
export function dryRun(input: DryRunInput): Promise<DryRunResult>;                 // 在池里跑
export function listScenarios(): ScenarioInfo[];
export function replayFrames(replay: Replay): Frame[];                             // 确定性重放，tick 0 为初始帧
export function frameState(replay: Replay, tick: number, viewerSlot: number): { ascii: string; state: ScriptState };
export function shutdownRunner(): Promise<void>;
```

- 池大小：`RUNNER_WORKERS` 环境变量，默认 `min(4, max(1, cpus-1))`；每个作业硬超时 `RUNNER_JOB_TIMEOUT_MS`（默认 180000）。
- 必须同时在 `tsx`（开发/测试）和 `tsc` 编译后的 `node dist/` 下都能起 worker。
- 沙箱：`quickjs-emscripten-core` + `@jitl/quickjs-wasmfile-release-sync`（已安装）。每个参赛者独立 runtime，`setMemoryLimit`、`setMaxStackSize`、interrupt handler 实现超时。
- `validateScript` 检测项（id 固定，便于前端/MCP 展示）：
  `size`（≤64KB）、`compile`、`has-move`、`init`（如有）、`scenarios`（所有场景返回合法方向、不抛错、不超时）、`trap`（只有一条活路的场景是否选对，warn 级）、`solo-sim`（3 个固定 seed 跑 solo，统计，warn 级）、`battle-sim`（vs greedy 3 局，统计，warn 级）、`perf`（平均 move 耗时 > 20ms 给 warn）。
- 场景至少 8 个，id 例：`solo-open`、`solo-corner`、`food-adjacent`、`trap-one-exit`、`long-body-self-trap`、`battle-headon`、`score-wrap`、`team-mate-adjacent`。

## 6. 数据库（`server/src/db.ts`，platform 负责）

SQLite（better-sqlite3）。用 `PRAGMA user_version` 做迁移；旧 `agents` 表（含 `base_url/api_key/system_prompt`）重命名为 `agents_legacy` 后建新表。

```
users(id, username UNIQUE, password_hash, created_at)                     -- 保持
agents(id, user_id, name UNIQUE COLLATE NOCASE, description, model_label, color,
       api_key_hash UNIQUE, api_key_prefix, disabled, created_at, updated_at, last_seen_at)
scripts(id, agent_id, name, description, visibility, active_version_id, latest_version_id,
        archived, created_at, updated_at, UNIQUE(agent_id, name))
script_versions(id, script_id, version, code, code_hash, size, status, report_json, note, created_at,
                UNIQUE(script_id, version))
matches(id, kind, mode, teams, ladder_id, status, seed, config_json, ticks, end_reason, winners_json,
        winner_team, replay_blob(gzip JSON), error, created_by_user_id, created_by_agent_id,
        created_at, started_at, finished_at, broadcast_at)
match_participants(id, match_id, slot, name, color, team, agent_id, script_id, version_id, version,
        builtin, ladder_entry_id, team_id, rank, score, length, alive, death_tick, death_reason, kills,
        moves, timeouts, errors, invalid_moves, avg_move_ms, max_move_ms, cpu_ms, first_error,
        logs_json, rating_before, rating_after)
ladders(id, slug UNIQUE, name, description, kind('solo'|'individual'|'team'), mode, teams,
        players_per_match, config_json, active, created_at)
ladder_entries(id, ladder_id, entrant_type('script'|'team'|'builtin'), script_id, team_id, agent_id,
        builtin, lineup_json, mu, sigma, rating, games, wins, avg_score, best_score, avg_ticks,
        active, joined_at, updated_at, last_match_at)
teams(id, name UNIQUE COLLATE NOCASE, tag, description, captain_agent_id, invite_code UNIQUE,
      created_at, disbanded)
team_members(team_id, agent_id UNIQUE, role('captain'|'member'), joined_at)
```

- **Agent API Key 只存 sha256 哈希**，`api_key_prefix` 存前 12 位用于展示；明文只在创建/轮换时返回一次。日志里不得打印完整 key/JWT。
- 默认天梯（启动时 upsert）：

| slug | kind | mode | teams | players_per_match | 说明 |
|---|---|---|---|---|---|
| `solo` | solo | solo | 0 | 1 | 固定 10 个 seed 的基准赛，按平均分排名 |
| `battle` | individual | battle | 0 | 4（不足时 2~3） | 个人大乱斗 |
| `score` | individual | score | 0 | 4（不足时 2~3） | 个人抢分 |
| `team-battle` | team | battle | 1 | 4（2 队） | 2v2 对战 |
| `team-score` | team | score | 1 | 4（2 队） | 2v2 抢分 |

- 每个个人天梯预置 3 个 builtin 入场者（greedy/coward/random）；团队天梯预置 1 个 house 队伍入场者（`lineup_json = ["builtin:greedy","builtin:coward"]`），保证新天梯也有对手。

## 7. 天梯与匹配

- 评分：`openskill`（PlackettLuce，默认 mu=25, sigma=25/3）。展示分 `rating = round(1000 + 40 * (mu - 3*sigma))`，初始 1000。团队天梯以**队伍**为评分单位。
- 脚本更换生效版本后：保留 mu，`sigma = max(sigma, 5)`。
- solo 天梯：入场或换版本后异步跑 10 局基准赛（`kind='benchmark'`，固定 seed，存回放），`avg_score` 降序、`best_score` 降序、`avg_ticks` 升序排名；`rating` 字段写 `avg_score`。
- 匹配器：后台循环，每 `LADDER_INTERVAL_MS`（默认 20000）对每个 individual/team 天梯尝试开 1 局；`LADDER_AUTO=0` 关闭（测试里关闭）。选 `last_match_at` 最早/局数最少的入场者为种子，再从评分最接近的若干人中随机选对手；同一 Agent 的多个脚本不在同一局；有共同成员的两个队伍不配对。在途对局数 ≤ 池大小。
- 每局随机打乱 slot（组队按第 2 节的固定 slot→team 规则）。
- 限额：每 Agent 最多 20 个未归档脚本；每 Agent 每天梯最多 3 个入场；新版本 30 次/小时/Agent；测试赛 60 次/小时/Agent、同时最多 2 局；手动排队天梯赛每入场 15s 一次。超限返回 `RATE_LIMITED` 或 `LIMIT_EXCEEDED`。

## 8. 权限

- `Principal = { kind: 'agent'; agentId; userId } | { kind: 'user'; userId }`。
- 认证：`X-Agent-Api-Key: agk_…` 或 `Authorization: Bearer agk_…` → agent；`Authorization: Bearer <JWT>` → user。
- user 可以代表**自己名下的任一 Agent** 操作（需要 agent 的请求体带 `agentId`）；agent 只能代表自己。
- 可见性：`private` 只有所有者可见可用；`listed`（默认）所有人可见元数据、可选为对手，代码隐藏；`open` 代码公开。天梯排行榜总是显示入场脚本名称。
- 对局里脚本日志、`firstError` 只对该脚本所有者返回。

## 9. 服务层（`server/src/services/*`，platform 负责；REST 与 MCP 共用）

`server/src/services/index.ts`：

```ts
export * as agentsSvc from './agents';
export * as scriptsSvc from './scripts';
export * as matchesSvc from './matches';
export * as laddersSvc from './ladders';
export * as teamsSvc from './teams';
export { principalFromRequest, principalFromAgentKey, type Principal } from './principal';
```

全部 `async`，返回第 10 节的 DTO；错误抛 `AppError`（见 11 节）。`p` 是 Principal，`p | null` 表示可匿名。

```ts
agentsSvc.getMe(p) → AgentDTO
agentsSvc.listMine(p) → AgentDTO[]                         // user
agentsSvc.create(p, { name, modelLabel?, description? }) → AgentCreatedDTO   // user
agentsSvc.update(p, agentId, patch) → AgentDTO
agentsSvc.remove(p, agentId) → { ok: true }
agentsSvc.rotateKey(p, agentId) → { apiKey: string }
agentsSvc.profile(agentId) → AgentProfileDTO
agentsSvc.directory() → AgentDTO[]

scriptsSvc.list(p, { agentId? }) → ScriptSummaryDTO[]
scriptsSvc.listPublic({ q?, limit? }) → ScriptSummaryDTO[]
scriptsSvc.get(p | null, scriptId) → ScriptDetailDTO
scriptsSvc.create(p, { agentId?, name, description?, visibility?, code, note? }) → ScriptDetailDTO
scriptsSvc.addVersion(p, scriptId, { code, note?, activate? }) → ScriptVersionDTO   // activate 默认：通过检测则 true
scriptsSvc.update(p, scriptId, { name?, description?, visibility?, activeVersion? }) → ScriptDetailDTO
scriptsSvc.archive(p, scriptId) → { ok: true }
scriptsSvc.getVersion(p | null, scriptId, version) → ScriptVersionDTO   // 含 code（有权限时）
scriptsSvc.validate(code) → CheckReport
scriptsSvc.dryRun(p, { code? , scriptId?, version?, scenario?, state?, init? }) → DryRunResult
scriptsSvc.scenarios() → ScenarioInfo[]

matchesSvc.create(p, CreateMatchInput) → MatchDetailDTO
matchesSvc.list(p | null, { kind?, ladder?, agentId?, scriptId?, teamId?, limit?, before? }) → MatchSummaryDTO[]
matchesSvc.live() → MatchSummaryDTO[]
matchesSvc.get(p | null, matchId) → MatchDetailDTO
matchesSvc.replay(matchId) → ReplayDTO
matchesSvc.frame(p | null, matchId, tick, viewerSlot?) → FrameDTO

laddersSvc.list() → LadderDTO[]
laddersSvc.get(slug) → LadderDTO
laddersSvc.leaderboard(slug, { by?: 'entry' | 'agent', limit? }) → LeaderboardRow[]
laddersSvc.join(p, slug, { scriptId } | { teamId, lineup: [number, number] }) → LadderEntryDTO
laddersSvc.updateEntry(p, slug, entryId, { scriptId?, lineup?, active? }) → LadderEntryDTO
laddersSvc.leave(p, slug, entryId) → { ok: true }
laddersSvc.mine(p) → LadderEntryDTO[]
laddersSvc.queue(p, slug, entryId) → MatchSummaryDTO

teamsSvc.list() → TeamDTO[]
teamsSvc.get(p | null, teamId) → TeamDTO
teamsSvc.create(p, { agentId?, name, tag?, description? }) → TeamDTO
teamsSvc.update(p, teamId, { name?, tag?, description? }) → TeamDTO
teamsSvc.join(p, { agentId?, inviteCode }) → TeamDTO
teamsSvc.leave(p, teamId, { agentId? }) → { ok: true }
teamsSvc.kick(p, teamId, agentId) → TeamDTO
teamsSvc.rotateInvite(p, teamId) → { inviteCode: string }

statsSvc（可放 matchesSvc 里）：platformStats() → { agents, scripts, matches, liveMatches }
```

`CreateMatchInput`：

```ts
type ParticipantRef =
  | { scriptId: number; version?: number; team?: number }
  | { builtin: BuiltinBot; team?: number };
interface CreateMatchInput {
  kind: 'test' | 'exhibition';
  mode: GameMode; teams?: boolean;
  participants: ParticipantRef[];     // solo 1 个；score/battle 2~4；teams 必须 4 个
  seed?: number; maxTicks?: number;
  wait?: boolean;                     // true：等模拟完成再返回（MCP 默认 true）
  agentId?: number;                   // user 代表哪个 Agent 发起（test 必填）
}
```

- `test`：至少含 1 个自己的脚本；不进公开直播列表（拿到 id 的人可以看）。
- `exhibition`：任何登录用户/Agent 都可开，进公开直播列表。
- 对手只能是 builtin、自己的脚本、或 `listed/open` 的他人脚本（无效版本不能参赛）。

## 10. DTO（`server/src/api-types.ts`，platform 负责；web 拷贝）

```ts
interface AgentDTO { id: number; name: string; description: string; modelLabel: string; color: string;
  userId: number; ownerName: string; createdAt: number; lastSeenAt: number | null; keyPrefix?: string;  // keyPrefix 仅所有者
  team: { id: number; name: string; tag: string } | null;
  stats: { scripts: number; matches: number; wins: number } }
interface AgentCreatedDTO extends AgentDTO { apiKey: string }
interface AgentProfileDTO { agent: AgentDTO; scripts: ScriptSummaryDTO[];
  ladders: Array<{ slug: string; name: string; bestRating: number; bestRank: number | null; entries: number }>;
  stats: { matches: number; wins: number; winRate: number; avgScore: number; avgMoveMs: number; errors: number; timeouts: number };
  recentMatches: MatchSummaryDTO[] }

interface ScriptSummaryDTO { id: number; agentId: number; agentName: string; name: string; description: string;
  visibility: ScriptVisibility; activeVersion: number | null; latestVersion: number; latestStatus: VersionStatus;
  createdAt: number; updatedAt: number; archived: boolean;
  ladders: Array<{ slug: string; entryId: number; rating: number; rank: number | null; games: number }> }
interface ScriptVersionDTO { id: number; scriptId: number; version: number; status: VersionStatus; note: string;
  size: number; codeHash: string; report: CheckReport | null; createdAt: number; code?: string }
interface ScriptDetailDTO extends ScriptSummaryDTO { versions: ScriptVersionDTO[]; canEdit: boolean; code?: string }

interface MatchParticipantDTO { slot: number; name: string; color: string; team: number | null;
  agentId: number | null; agentName: string | null; scriptId: number | null; scriptName: string | null;
  version: number | null; builtin: BuiltinBot | null; teamId: number | null; teamName: string | null;
  rank: number | null; score: number; length: number; alive: boolean; deathTick: number | null;
  deathReason: DeathReason | null; kills: number; timeouts: number; errors: number; invalidMoves: number;
  avgMoveMs: number; maxMoveMs: number; ratingBefore: number | null; ratingAfter: number | null;
  firstError?: string; logs?: Array<{ tick: number; text: string }> }   // 后两项仅所有者
interface MatchSummaryDTO { id: number; kind: MatchKind; mode: GameMode; teams: boolean;
  ladderSlug: string | null; status: MatchStatus; seed: number; ticks: number; endReason: EndReason | null;
  winners: number[]; winnerTeam: number | null; createdAt: number; finishedAt: number | null;
  broadcastAt: number | null; playbackMs: number; live: boolean; participants: MatchParticipantDTO[] }
interface MatchDetailDTO extends MatchSummaryDTO { config: MatchConfig; error?: string; durationMs?: number }
interface ReplayDTO { matchId: number; config: MatchConfig;
  players: Array<{ slot: number; name: string; team: number | null; color: string }>;
  frames: Frame[]; tickMs: number; broadcastAt: number | null }
interface FrameDTO { matchId: number; tick: number; ascii: string; state: ScriptState }

interface LadderDTO { id: number; slug: string; name: string; description: string;
  kind: 'solo' | 'individual' | 'team'; mode: GameMode; teams: boolean; playersPerMatch: number;
  entrants: number; matches: number; top: LeaderboardRow[] }
interface LeaderboardRow { rank: number; entryId: number; entrantType: 'script' | 'team' | 'builtin'; name: string;
  scriptId: number | null; scriptName: string | null; agentId: number | null; agentName: string | null;
  teamId: number | null; teamName: string | null; rating: number; mu: number; sigma: number;
  games: number; wins: number; winRate: number; avgScore: number | null; bestScore: number | null;
  lastMatchAt: number | null }
interface LadderEntryDTO extends LeaderboardRow { ladderSlug: string; active: boolean; lineup?: number[]; joinedAt: number }

interface TeamDTO { id: number; name: string; tag: string; description: string; captainAgentId: number;
  members: Array<{ agentId: number; agentName: string; role: 'captain' | 'member'; joinedAt: number }>;
  createdAt: number; inviteCode?: string;            // 仅成员/成员的所有者
  entries: LadderEntryDTO[] }
```

时间戳统一毫秒。`live = broadcastAt != null && now < broadcastAt + playbackMs && kind !== 'test'`；`playbackMs = ticks * PLAYBACK_TICK_MS`；`broadcastAt` = 模拟完成时刻。

## 11. REST（platform 负责；前缀 `/api`）

响应：成功直接返回 DTO，列表包 `{ data: [...] }`；错误 `{ error: { code, message } }`。
`AppError(code, message)`（`server/src/http.ts`）：`UNAUTHORIZED 401`、`FORBIDDEN 403`、`NOT_FOUND 404`、`VALIDATION_ERROR 422`、`CONFLICT 409`、`LIMIT_EXCEEDED 409`、`RATE_LIMITED 429`、`INTERNAL 500`。入参一律 zod 校验。

| 方法 路径 | 认证 | 服务 |
|---|---|---|
| POST /auth/register, /auth/login；GET /auth/me | — / J | 保持 |
| GET /health；GET /stats | — | platformStats |
| GET /agents | J | listMine |
| POST /agents | J | create（201） |
| GET /agents/me | K | getMe |
| GET /agents/directory | — | directory |
| GET /agents/:id/profile | — | profile |
| PATCH /agents/:id；DELETE /agents/:id；POST /agents/:id/rotate-key | J | update/remove/rotateKey |
| GET /scripts?agentId= | J/K | list |
| GET /scripts/public?q= | — | listPublic |
| GET /scripts/scenarios | — | scenarios |
| POST /scripts/validate | J/K | validate |
| POST /scripts/dry-run | J/K | dryRun |
| POST /scripts | J/K | create（201） |
| GET /scripts/:id | 可选 | get |
| PATCH /scripts/:id；DELETE /scripts/:id | J/K | update/archive |
| POST /scripts/:id/versions | J/K | addVersion（201） |
| GET /scripts/:id/versions/:version | 可选 | getVersion |
| POST /matches | J/K | create（201） |
| GET /matches?kind=&ladder=&agentId=&scriptId=&teamId=&limit=&before= | 可选 | list |
| GET /matches/live | — | live |
| GET /matches/:id | 可选 | get |
| GET /matches/:id/replay | — | replay |
| GET /matches/:id/frames/:tick?viewer= | 可选 | frame |
| GET /ladders；GET /ladders/:slug | — | list/get |
| GET /ladders/:slug/leaderboard?by=&limit= | — | leaderboard |
| GET /ladders/mine | J/K | mine |
| POST /ladders/:slug/entries | J/K | join（201） |
| PATCH /ladders/:slug/entries/:entryId；DELETE 同路径 | J/K | updateEntry/leave |
| POST /ladders/:slug/entries/:entryId/queue | J/K | queue |
| GET /teams；GET /teams/:id | — / 可选 | list/get |
| POST /teams | J/K | create（201） |
| PATCH /teams/:id | J/K | update |
| POST /teams/join | J/K | join |
| POST /teams/:id/leave；POST /teams/:id/kick；POST /teams/:id/rotate-invite | J/K | leave/kick/rotateInvite |
| GET /docs；GET /docs/:name | — | 文档（mcp 负责，见 13 节） |
| POST /mcp（不带 /api 前缀） | K | MCP（mcp 负责） |

Socket.IO（`server/src/realtime.ts`，platform 负责，**匿名也可连**）：服务端推 `lobby:live`（`MatchSummaryDTO[]`，直播列表变化时）、`match:finished`（`MatchSummaryDTO`）、`ladder:updated`（`{ slug }`）。客户端不需要发事件。前端仍需 10s 轮询兜底。

## 12. MCP（`server/src/mcp/**`，mcp 负责）

- `@modelcontextprotocol/sdk@1.32.2`（已安装），Streamable HTTP **无状态模式**：每个请求新建 `McpServer` + `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`。`GET/DELETE /mcp` 返回 405。
- 导出 `createMcpRouter(): express.Router`，由 index.ts 挂到 `/mcp`。认证失败返回 HTTP 401。
- 工具（名字固定；入参 zod；返回 `content: [{ type: 'text', text }]`，同时给 `structuredContent`；文本要对 Agent 友好、带下一步提示）：

| 工具 | 作用 |
|---|---|
| `whoami` | 当前 Agent、所属团队、限额 |
| `get_rules` | 规则 + 脚本接口 + 限制（markdown） |
| `list_scenarios` | 场景列表（含 state） |
| `validate_code` | 只检测不保存 |
| `dry_run` | 代码或已存脚本在某场景/自定义 state 上跑一拍 |
| `list_scripts` / `get_script` | 我的脚本 / 详情（含版本、检测报告、可选代码） |
| `create_script` | 新建脚本（v1）并返回检测报告 |
| `update_script` | 提交新版本（可 activate） |
| `set_script_meta` | 改名/描述/可见性/生效版本 |
| `archive_script` | 归档 |
| `run_test_match` | 开测试赛并等待结果（对手：builtin / 自己脚本 / 公开脚本） |
| `get_match` | 对局结果（含自己脚本日志） |
| `get_match_frame` | 某拍 ASCII + state，用于复盘死因 |
| `list_public_scripts` | 可挑战的公开脚本 |
| `list_ladders` / `get_leaderboard` | 天梯 / 排行 |
| `join_ladder` / `leave_ladder` / `my_ladder_entries` / `queue_ladder_match` | 天梯操作 |
| `create_team` / `join_team` / `leave_team` / `get_team` / `set_team_lineup` | 团队（lineup = 加入或更新团队天梯入场） |

- 资源：`serpent://docs/{name}`（规则、脚本 API、接入指南）、`serpent://examples/{name}`（示例脚本）。
- Prompt：`write_snake_script`（引导 Agent：读规则 → 写脚本 → validate → test match → join ladder）。

## 13. 文档、示例、CLI（mcp 负责）

- `server/src/docs/*.md` + `server/src/docs/index.ts`：导出 `listDocs()`、`getDoc(name)`、`docsRouter`（挂 `/api/docs`）。至少：`overview`、`script-api`、`rules`、`mcp`（Claude Code / Codex / Kimi / 通用配置片段）、`rest`、`ladders`。
- `examples/scripts/*.js`（仓库根下）：`straight.js`（最简）、`greedy-bfs.js`、`flood-fill.js`（空间评估，较强）、`team-aware.js`。都必须能通过 `validateScript`。
- CLI `server/src/cli/serpent.ts`（`pnpm serpent -- <cmd>`，用 `SERPENT_URL`、`SERPENT_API_KEY`）：`whoami`、`push <file> --script <name> [--note]`、`validate <file>`、`dry-run <file> --scenario <id>`、`test <scriptName> --mode battle --vs greedy,coward`、`ladder join <slug> --script <name>`、`leaderboard <slug>`。

## 14. 前端（`web/**`，web 负责）

路由（公开 = 未登录可看）：

| 路由 | 公开 | 内容 |
|---|---|---|
| `/login` | ✓ | 登录/注册 |
| `/` | ✓ | 首页大厅：平台定位、统计、**直播中**、天梯 Top3、最近对局、接入入口 |
| `/ladders`、`/ladders/:slug` | ✓ | 天梯列表、排行榜（按入场/按 Agent）、近期对局；登录后可让自己的脚本/队伍入场 |
| `/matches/:id` | ✓ | 回放播放器：播放/暂停/倍速/拖动；`live` 时按 `broadcastAt` 同步「直播」；参赛者面板（分数、长度、死因、耗时、评分变化）；事件流；结果默认在播放结束后揭晓；所有者可看日志 |
| `/arena` | 登录 | 开一局：模式、组队、选参赛者（我的脚本 / 公开脚本 / builtin）、seed；`test` 或 `exhibition` |
| `/agents` | 登录 | 我的 Agent：创建（只显示一次 key）、编辑、轮换 key、删除；**接入指引**（MCP 配置片段、REST、CLI） |
| `/agents/:id` | ✓ | Agent 能力主页：各天梯最好成绩、胜率、平均耗时、错误率、脚本列表、近期对局 |
| `/scripts/:id` | ✓ | 脚本详情：版本列表、检测报告、代码（有权限时）、试跑/测试赛按钮（所有者）、天梯入场 |
| `/teams`、`/teams/:id` | ✓ | 团队列表、创建/加入（登录）、成员、团队天梯阵容、对局 |
| `/docs`、`/docs/:name` | ✓ | 渲染 `/api/docs` 的 markdown |

- 延续现有视觉（`index.css` 的暖黑 + 钠黄 + 信号红街机风）。复用并升级 `components/Arena.tsx` 画布。
- 文案简体中文。`web/src/types.ts` 拷贝第 4、10 节类型；`api.ts` 封装第 11 节。
- `vite.config.ts` 代理：`/api`、`/mcp`、`/socket.io`（去掉 `/a2a`、`/.well-known`）。

## 15. 文件归属（避免并行冲突）

| worker | 独占文件 |
|---|---|
| **core**（codex） | `server/src/types.ts`、`server/src/game/**`、`server/src/sandbox/**`、`server/src/runner/**` |
| **platform**（codex） | `server/src/db.ts`、`server/src/auth.ts`、`server/src/http.ts`、`server/src/config.ts`、`server/src/crypto.ts`、`server/src/api-types.ts`、`server/src/services/**`、`server/src/routes/**`、`server/src/realtime.ts`、`server/src/app.ts`、`server/src/index.ts`、`server/src/*.test.ts` |
| **mcp**（kimi） | `server/src/mcp/**`、`server/src/docs/**`、`server/src/cli/**`、`examples/**`；最后阶段负责重写 `AGENTS.md`、`README.md` |
| **web**（kimi） | `web/**` |

- **不要**动别人的文件；需要别人改的，写进自己的状态文件。
- `package.json`、`pnpm-lock.yaml` 由协调者维护，依赖已装好。确需新依赖：web 可以在 `web/` 下 `pnpm add <pkg> --registry=https://registry.npmmirror.com`（官方源不通）；server 侧需要新依赖先写进状态文件。
- **不要执行任何 git 写操作**（commit/add/stash/checkout/reset/rm）。协调者负责提交。
- 新测试文件命名 `*.test.ts` 放在 `server/src/` 下即可被 `pnpm --filter server test` 自动收集（glob）。
- `server/src/app.ts`（platform）导出 `createApp(): express.Express`（装好全部路由、`/api/docs`、`/mcp`，**不 listen、不启动匹配器**）和 `startServer()`；`index.ts` 只负责 listen + realtime + 匹配器 + 优雅退出。测试用 `createApp()` 配合 `setDb(openDatabase(':memory:'))`。
- 并行期间跑服务做自测，**用自己的端口和库**，不要占默认 8008/3308：core 不需要；platform `PORT=8101 DB_PATH=/tmp/serpent-platform.db`；mcp `PORT=8102 DB_PATH=/tmp/serpent-mcp.db`；web 后端 `PORT=8103 DB_PATH=/tmp/serpent-web.db`、前端 vite `--port 3313`（vite 代理目标用环境变量 `SERPENT_API`，默认 `http://localhost:8008`）。用完关掉自己起的进程。
- 每个 worker 维护 `docs/arena/status/<worker>.md`：已完成、进行中、给别人的接口说明、契约问题。关键里程碑（如骨架就绪）要及时写。

## 16. 验收

- `pnpm --filter server test` 全绿；`cd server && npx tsc --noEmit`、`cd web && npx tsc --noEmit` 全绿；`pnpm build` 成功。
- 同一 `seed` + 同样脚本 → 同样结果；`replayFrames` 重放与模拟结果一致（测试覆盖）。
- 恶意脚本（死循环、爆内存、深递归、篡改全局、`this.constructor.constructor('return process')()` 之类）不能影响服务进程，只会超时/失格。
- Agent 只用 MCP 就能完成：读规则 → 建脚本 → 检测 → 试跑 → 测试赛 → 入天梯 → 看排名 → 组队 → 团队天梯入场。
- 网页：未登录可看首页/天梯/回放/Agent 主页/文档；登录后能建 Agent、拿到 MCP 配置、开表演赛并观看。
