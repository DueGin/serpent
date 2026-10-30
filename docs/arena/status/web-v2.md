# 前端工人 C 状态（web-v2）

## 交付状态

- 分支：`web-v2`
- 前端代码提交：`1dce44c feat(web): adapt UI for survival-64 and Python scripts`
- 类型收尾提交：`863359d refactor(web): use typed script language list`
- 范围：只修改 `web/src/**`，`web/src/types.ts` 未改；未修改共享类型、服务端、依赖或锁文件。
- 结论：契约第 3 节的前端实现已完成；真实 survival-64 与 Python 服务端联调按分工留给合并后的协调者。

## 已完成

- 规则与赛季：大厅、开一局展示 64×64 有边界、生命值、果实数量、碰撞和头对头规则；移除“穿墙抢食”旧文案；天梯列表与详情提示“新赛季（survival-64）积分已清零”，并说明历史回放保留。
- 棋盘：48 格以上地图每 4 格绘制弱化网格，降低果实光晕并加强蛇头轮廓；classic 棋盘绘制分支保持原样。survival 对局在窄屏使用单列布局，classic 布局不变。
- 生命 UI：参赛者卡片按当前帧 `hp` 和 `config.maxHp` 显示生命条，`hp <= 25` 使用警示色和文字提示；无有效 `hp` 或 `maxHp` 时不渲染。
- 复盘：新增各蛇生命值折线和 `maxHp` 虚线参考线；当前拍检查器展示当前生命值、`minHp`、`lowHpTicks`；`starving` 中文标签为“饥饿风险”，`starve` 沿用“生命值耗尽”；趋势死因补充 `starve`。
- classic 兼容：生命折线、生命条和生命指标同时受 `maxHp` 与实际 `hp` 数据约束；真实 classic 对局中这些 DOM 均为 0。
- 脚本语言：新增首版脚本创建面板，支持 JavaScript / Python 选择、语言模板、独立检测、可见性和创建后不可改提示；列表与详情显示语言徽标；版本编辑器按语言提供模板和占位提示。
- API：创建、检测、试跑请求支持并传递 `language`；旧服务端未返回语言时，展示与模板回退为 JavaScript。
- 趋势：注明“仅统计当前规则（survival-64）”。

## 文件清单

- `web/src/api.ts`：语言请求字段、JavaScript / Python 模板。
- `web/src/components/Arena.tsx`：64×64 可读性。
- `web/src/components/MatchReviewPanel.tsx`：生命折线与生命指标。
- `web/src/components/RulesetNotice.tsx`：新增，复用规则与赛季提示。
- `web/src/components/ScriptCreatePanel.tsx`：新增，首版脚本创建与检测表单。
- `web/src/components/ScriptTrendPanel.tsx`：当前规则说明与 `starve` 统计。
- `web/src/components/reviewLabels.ts`：`starving` 标签。
- `web/src/index.css`：生命条、徽标、创建表单、规则提示与 survival 窄屏布局。
- `web/src/pages/MatchPage.tsx`：当前帧生命条与 survival 布局标记。
- `web/src/pages/AgentsPage.tsx`：挂载创建面板，REST 示例带语言。
- `web/src/pages/ScriptPage.tsx`：语言徽标、模板、占位提示与试跑语言。
- `web/src/pages/AgentProfilePage.tsx`：脚本列表语言徽标。
- `web/src/pages/ArenaPage.tsx`、`LobbyPage.tsx`：规则与 Python 文案。
- `web/src/pages/LaddersPage.tsx`、`LadderDetailPage.tsx`：新赛季提示。
- `web/src/utils.ts`：脚本语言展示名。
- `docs/arena/status/web-v2.md`：本状态文件。

## 取舍

- 大地图优化只在宽或高达到 48 格时启用，避免改变 classic 的 24×16 / 28×20 绘制。
- 窄屏单列只通过 `maxHp !== null` 的 survival 布局类启用，不改变 classic 页面布局。
- 切换创建语言时，未编辑的模板会随语言更新；用户已修改的代码会保留并提示确认，避免静默丢失代码。
- 未新增共享字段，未新增依赖，未引入新的类型断言、`any`、双重断言或非空断言。

## 验证命令与结果

### 静态检查与构建

最终交付源码上执行：

```text
cd web && /usr/bin/time -p npx tsc --noEmit
结果：通过，无错误；real 2.05s。

pnpm --filter web build
结果：通过；98 modules transformed；Vite built in 653ms。
dist/index.html                   0.70 kB │ gzip:   0.42 kB
dist/assets/index-CThhP_gR.css   54.40 kB │ gzip:  11.22 kB
dist/assets/index-KGC6HqF9.js   343.27 kB │ gzip: 112.26 kB

git diff --check
结果：通过。
git diff -- web/src/types.ts
结果：无差异。
```

测试通过数：不适用。`web/package.json` 没有 `test` 脚本，本轮未执行服务端测试；指定验证项 `tsc --noEmit` 与 `pnpm --filter web build` 均通过。

### 真实 classic 联调

使用分配的 `8123/3323` 端口与 `/tmp/serpent-web2.db`，通过真实 REST 创建临时账号、Agent、JavaScript 脚本和 80 拍 battle 对局：

- 对局配置确认：`ruleset=classic`、`maxHp=null`。
- 桌面与手机回放/复盘：生命条数量 0、生命折线数量 0、生命指标数量 0、survival 布局类数量 0。
- `/ladders`、`/ladders/battle`、`/arena`、`/scripts/1`、`/agents/1` 在 1280px 与 390px 下均无横向溢出；移动端 `document.scrollWidth=390`，无 `undefined` 文案。
- Python 创建表单模板切换和徽标正常；脚本详情与 Agent 主页对旧服务端数据正确回退为 JavaScript。
- 最终 classic 复验控制台错误数 0。

### 开发假数据自测（已删除）

临时在 API 层注入 survival 假数据后检查：

- 生命条 2 条，低生命警示正常；生命折线图 1 个、折线 3 条（2 名参赛者 + `maxHp` 参考线）。
- 当前生命值、最低生命值、低生命拍数及“饥饿风险”标签均显示。
- 64×64 棋盘在 1280px 视口下 canvas 宽 835px，在 390px 视口下宽 352px；两种宽度均无横向溢出。
- 该次开发预览整页加载约 2693ms，包含 classic API、复盘请求和假数据转换；它不是实际 survival-64 性能基准。
- 假数据片段已全部删除，`survivalPreview` 等标记搜索无结果，删除后再次通过 classic 复验与最终构建。

## 性能实测

- 最终 `tsc --noEmit`：2.05s。
- 最终生产构建：Vite 653ms；最终 JS gzip 112.26kB、CSS gzip 11.22kB。
- 开发假数据预览整页加载约 2.693s，仅用于证明新增渲染路径可工作；真实 survival-64 对局的渲染与复盘性能尚未测量。

## 遗留问题与协调事项

- 当前分支服务端仍是旧契约：创建 / 检测 / 试跑的 `language` 请求需工人 B 的路由、服务与运行时合并后才能端到端使用。本分支只验证了表单、模板、请求类型和 classic 页面，未把旧服务端的字段拒绝视为前端缺陷。
- 真实 survival-64 的 `hp` 序列、64×64 回放、Python 创建/检测/试跑及性能验收需协调者合并工人 A/B 后完成。
- 临时服务已关闭，临时数据库已删除；未 push，未切换或修改 `master`。
