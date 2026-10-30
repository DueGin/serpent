# 复盘与跨局趋势前端交付

## 完成内容

- 保留并修正工作区已有前端改动，接入 `getMatchReview`、`getScriptTrend`；完整复盘只请求一次 `series=1`，不传 `from/to`。
- 回放页新增分数、身长、可达空间/身长参考折线图，以及逐拍决策条带；共享当前拍，支持悬停读数、键盘操作、点击跳拍并暂停。
- 新增关键时刻筛选、死亡归因与实际选择高亮、当前拍指标和候选方向表、改进建议、所有者日志就近对齐。
- 暂停后防抖请求 `getMatchFrame`，播放中不请求；`Arena` 新增可选 `overlay`，安全格绿色、致死格红色、实际选择描边，不传时保持原渲染。
- 直播/未完成/未揭晓状态独立门控；复盘加载失败不影响回放，可单独重试；旧对局显示“旧对局没有决策遥测”。
- 脚本页新增跨局趋势：版本统计表、模式过滤、分数/名次迷你图和最近对局链接。
- 图表无新增依赖；折线按蛇合并为 SVG path，决策格按蛇和结果码合并 path，数据变化时缓存，播放仅移动当前拍竖线。
- 未修改 `web/src/types.ts`、服务端、`AGENTS.md`，未新增依赖，未提交 git。

## 文件清单

- API/页面：`web/src/api.ts`、`web/src/pages/MatchPage.tsx`、`web/src/pages/ScriptPage.tsx`
- 棋盘/请求：`web/src/components/Arena.tsx`、`web/src/hooks/useReviewFrame.ts`
- 图表：`web/src/components/LineChart.tsx`、`DecisionStrip.tsx`、`Sparkline.tsx`
- 复盘：`MatchReviewPanel.tsx`、`ReviewMoments.tsx`、`ReviewDeathCard.tsx`、`ReviewOptionsTable.tsx`、`reviewLabels.ts`
- 趋势：`web/src/components/ScriptTrendPanel.tsx`
- 样式：`web/src/index.css`

## 交互与验证

- `cd web && npx tsc --noEmit`：通过。
- `pnpm --filter web build`：通过，`tsc && vite build` 成功，96 个模块完成构建。
- `cd server && npx tsc --noEmit`：联调前通过；未改服务端。
- 使用隔离环境 `8113/3313` 和 `/tmp/serpent-review-web.db` 做了真实 REST + 浏览器联调；结束后两个进程已关闭，临时账号凭据文件已删除。
- 联调对局为 flood-fill 对 greedy，439 拍、2 条蛇：复盘返回 2 条序列（各 440 点）、71 条关键时刻、1 条死亡归因、3 条建议、23 行所有者日志；候选帧返回 3 个选项，趋势返回 1 个版本和 1 场最近对局。
- 浏览器确认完整复盘请求仅 1 次；播放 700ms 无新增候选帧请求，暂停后请求 1 次。点击空间图跳到第 219 拍并暂停，悬停显示各蛇数值；点击严重时刻跳到第 438 拍并暂停。
- 死亡卡跳到决策拍正常，greedy 实际选择 `down` 高亮且显示“咬到自己”；棋盘候选覆盖层、所有者日志就近列表均正常。
- 趋势模式切换到 solo 显示空态，切回 battle 恢复；最近对局链接为 `/matches/1`。
- 1280px 与 390px 下复盘页、趋势页均无文档横向溢出。趋势表在 390px 下容器宽 324px、内容宽 1080px，仅在表格内部滚动。
- 截图：`.screenshots/review-web-1280-verified.png`、`review-web-390.png`、`review-web-death-options.png`、`trend-web-1280-verified.png`、`trend-web-390-verified.png`。

## 遗留与非阻断验证缺口

- 未另外构造旧对局无遥测、直播中、复盘接口失败三种真实场景；对应空态、门控、错误与重试代码已实现。
- 未做 1000+ 拍 ×4 蛇的浏览器压力测量；440 拍实测每图为合并 path，条带不会生成逐拍 DOM，当前拍竖线独立更新。
