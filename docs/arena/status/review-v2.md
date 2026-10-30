# survival-64 与 Python：合并验收

用户确认的规则见 `docs/arena/RULES-V2.md`。本轮由三个并行工人（rules-v2 / python-scripts / web-v2，各在独立 worktree 分支）实现，协调者合并、修复并做端到端验收。各自交付细节见 `rules-v2.md`、`python.md`、`web-v2.md`。

## 合并后状态

- `master`：规则 v2、Python、前端全部合并；`pnpm --filter server test` **270/270**，`server` / `web` `tsc --noEmit` 通过，`pnpm build` 通过。
- 三个 worktree 分支均保留在本地，未推送（协调者只推 `master`）。

## 协调者改动

1. **撞身体结算不能依赖 slot 顺序**（`server/src/game/engine.ts`）。工人的实现用“对方本拍是否已被标记死亡”决定取旧身体还是新身体，而标记顺序取决于 slot 大小，导致同一局面换个编号就生死不同。改为：移动过的蛇一律用移动后身体判定，只有撞墙未能移动的蛇用旧身体。加了 4 组 slot 排列的回归测试。
2. **JS 示例在 64×64 上太慢**（GitHub Actions 上 3 个测试失败，本机不复现）。实测 `team-aware` 每拍平均 24ms、峰值 31ms，`flood-fill` 偶发 21ms，慢机器上会触发 `move() 超时` 并使对 greedy 的胜负测试翻转。交回规则工人优化为平铺数组 + 复用缓冲区 + 有界搜索：平均降到约 1ms、峰值 < 9ms，六个 seed 零超时。
3. **高负载下误判失格**（`python-host.cjs` / `python.ts`）。超时中断的宽限只有 200ms，父进程兜底只有 `预算 + 1s`；CPU 被抢时解释器来不及响应，普通超时变成“中断宽限期耗尽”判失格。宽限改为 1s，兜底改为 `预算 + 3s`。在 6 个满载进程下连跑 4 次通过。
4. **测试后门收紧**：`PYTHON_ISOLATOR_COMMAND` 改为仅在 `NODE_ENV=test` 生效（测试脚本已设置），生产误配不会再让隔离静默失效。
5. 前端在 `/api/health` 报告 Python 不可用时禁用 Python 选项并显示原因，避免写完代码提交才收到 503。
6. Dockerfile 在 build 与 runtime 阶段安装 bubblewrap；compose 默认带 Python 所需的三项 `security_opt`，并把 `PYTHON_MAX_HOSTS` / `PYTHON_WARM_HOSTS` 暴露为配置项。

## 验收证据

### 规则（真实服务，REST）

4 人 battle（flood-fill vs greedy/coward/random，seed 7）：64×64、`wrap=false`、`foodCount=16`、`maxHp=100`、开局四蛇 hp 都是 100；整局每一帧食物数都等于 `foodCount`；逐帧核对生命值 = 上一拍 -1（未吃到）或 100（吃到）；`random` 与一个只绕圈不吃的脚本都恰好在第 100 拍 `starve`；`coward` 在第 498 拍饿死；复盘给出 hp 序列、`minHp`、`lowHpTicks`、`starving` 时刻和带数字的饥饿建议。历史 classic 对局仍按原规则回放（四份冻结 fixture + 两个 trace 哈希）。

### 前端（浏览器，真实 survival 对局）

64×64 棋盘可读、果实 16 个；参赛者卡片显示生命条，`hp ≤ 25` 变红并有警示文字；复盘区新增生命值折线（上限参考虚线），逐拍检查器显示当前 hp、`minHp`、`lowHpTicks`；1280px 与 390px 无横向溢出。classic 对局下生命相关 DOM 数量为 0。

### Python（Linux 容器，生产安全配置）

- 在 `node` 用户下用 bwrap 运行 **53 项 Python 沙箱/逃逸测试全部通过**（含“绕开所有 Python 守卫的原生 Node 探针仍读不到宿主文件、连不上网络、不能生成代码”）。
- 容器内真实链路：创建 Python 脚本 → 9 项检测全部 pass → 与 greedy/coward/random 的 1000 拍 battle（0 超时 0 报错）→ 复盘。
- 默认安全配置（不放开 seccomp/AppArmor/systempaths）下 bwrap 无法建立命名空间，Python 按设计拒绝；修复后表现为 503 `PYTHON_UNAVAILABLE` 与 `/api/health` 的 `python.available=false`，不再把用户脚本标成 invalid。

### CI 与发版

- `CI`：测试、类型检查、构建、镜像构建与容器冒烟（含 `scripts/smoke.mjs --python` 真实跑一局 Python）全部通过。
- `Release`：在临时分支上演练多架构构建（amd64 + arm64），结果见 CI 记录；`v*` 标签触发时推送 GHCR 并创建 Release。

## 已知限制

- Python 每个解释器约 200MB；默认 4 worker × (4 活跃 + 1 预热) 最坏约 4GB，推荐 8GB 以上内存。
- Python 完整检测约 13–15 秒（每个场景一个新解释器）。
- Ubuntu 23.10+ 宿主机需要 `kernel.apparmor_restrict_unprivileged_userns=0`，`docs/deploy.md` 已有说明。
- Python 的 TCB 仍是 OS + Node + V8 + WASM + Pyodide，隔离不是形式化证明；生产建议独立低权限账号/容器 + 外部网络拒绝 + cgroup 限制。
- 并发上限是每个 runner worker 的，不是全局；池满时 Python 参赛者初始化失败（返回可重试错误）。
