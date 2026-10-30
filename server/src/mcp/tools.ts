import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDoc } from '../docs';
import {
  agentsSvc,
  laddersSvc,
  matchesSvc,
  scriptsSvc,
  teamsSvc,
  type Principal,
} from '../services';
import { markdown, perform, success } from './result';
import { tool } from './register';
import {
  dryRunSchema,
  idSchema,
  joinLadderSchema,
  modeSchema,
  participantSchema,
  visibilitySchema,
} from './schemas';

const codeSchema = z.string().min(1).max(64 * 1024);
const slugSchema = z.enum(['solo', 'battle', 'score', 'team-battle', 'team-score']);

export function registerTools(server: McpServer, p: Principal): void {
  tool(server,'whoami', {
    title: '查看当前 Agent',
    description: '查看当前 Agent 身份、所属团队、天梯入场与平台限额。接入后先调用本工具确认身份。',
  }, async () => perform(async () => {
    const [agent, entries] = await Promise.all([agentsSvc.getMe(p), laddersSvc.mine(p)]);
    const data = {
      agent,
      team: agent.team,
      ladderEntries: entries,
      limits: {
        scriptsPerAgent: 20,
        versionsPerAgentPerHour: 30,
        testMatchesPerAgentPerHour: 60,
        concurrentTestMatches: 2,
        entriesPerAgentPerLadder: 3,
        manualQueueCooldownSec: 15,
        maxCodeBytes: 64 * 1024,
        moveTimeoutMs: 50,
        initTimeoutMs: 500,
        memoryLimitMB: 32,
      },
    };
    return success(data, `当前身份：${agent.name}（Agent #${agent.id}）。`, '调用 get_rules 阅读规则，再用 create_script 提交第一个脚本。');
  }));

  tool(server,'get_rules', {
    title: '读取比赛规则与脚本 API',
    description: '返回完整比赛规则、serpent-script-v1 接口、沙箱限制和组队规则的 Markdown。写代码前必读。',
  }, async () => perform(async () => {
    const rules = getDoc('rules');
    const api = getDoc('script-api');
    if (!rules || !api) throw new Error('规则文档尚未安装');
    const text = `# SERPENT 规则\n\n${rules.markdown}\n\n---\n\n${api.markdown}`;
    return markdown(text, '调用 list_scenarios 查看测试局面，随后编写同步 move(state) 并用 validate_code 检测。');
  }));

  tool(server,'list_scenarios', {
    title: '列出试跑场景',
    description: '列出 dry_run 可用场景，包含每个场景的 init 和完整 state，可用于理解边界情况或构造自定义试跑。',
  }, async () => perform(async () => {
    const scenarios = await scriptsSvc.scenarios();
    return success(scenarios, `共有 ${scenarios.length} 个试跑场景。`, '选择 scenario id 调用 dry_run；重点检查 trap、墙角、自身体和组队场景。');
  }));

  tool(server,'validate_code', {
    title: '检测脚本代码',
    description: '只检测不保存。检查编译、move/init 接口、场景合法性、陷阱选择、solo/battle 迷你模拟和性能。返回每个 CheckItem 的状态。',
    inputSchema: { code: codeSchema },
  }, async ({ code }) => perform(async () => {
    const report = await scriptsSvc.validate(code, p);
    const failed = report.items.filter((item) => item.status === 'fail');
    const next = report.ok
      ? '调用 dry_run 检查关键局面，再用 create_script 保存，或直接 run_test_match 检验实战。'
      : `优先修复这些 fail 项：${failed.map((item) => `${item.id}(${item.detail || item.label})`).join('；')}。修改后重新 validate_code。`;
    return success(report, report.ok ? '脚本检测通过。' : `脚本检测未通过，共 ${failed.length} 个失败项。`, next);
  }));

  tool(server,'dry_run', {
    title: '单拍试跑脚本',
    description: '用新 code 或已保存 scriptId 在某场景/自定义 state 上执行一次 init+move，返回原始值、方向、合法性、日志和耗时。code 与 scriptId 必须且只能提供一个。',
    inputSchema: dryRunSchema,
  }, async (input) => perform(async () => {
    const result = await scriptsSvc.dryRun(p, input);
    const next = result.ok
      ? result.legal ? '继续验证其他场景，或调用 run_test_match 进行完整对局。' : '方向合法但不在本拍 legalMoves 中；请从 state.legalMoves 选择并处理空数组。'
      : `根据 error 修复：${result.error || '返回值不是合法方向'}。也可读取 serpent://examples/flood-fill 参考防御写法。`;
    return success(result, result.ok ? `试跑返回 ${result.direction}。` : '试跑失败。', next);
  }));

  tool(server,'list_scripts', {
    title: '列出我的脚本',
    description: '列出当前 Agent 的脚本、版本状态、可见性和天梯成绩。',
  }, async () => perform(async () => {
    const scripts = await scriptsSvc.list(p, {});
    return success(scripts, `当前 Agent 有 ${scripts.length} 个脚本。`, scripts.length ? '用 get_script 查看版本与报告，或 run_test_match 选择参赛者。' : '用 create_script 创建第一个脚本。');
  }));

  tool(server,'get_script', {
    title: '查看脚本详情',
    description: '查看脚本元数据、不可变版本和检测报告。includeCode=true 时同时返回当前生效版本代码。',
    inputSchema: { scriptId: idSchema, includeCode: z.boolean().optional() },
  }, async ({ scriptId, includeCode }) => perform(async () => {
    const detail = await scriptsSvc.get(p, scriptId);
    if (!includeCode) {
      const { code: _code, versions, ...summary } = detail;
      const withoutCode = {
        ...summary,
        versions: versions.map((version) => {
          const { code: _versionCode, ...metadata } = version;
          return metadata;
        }),
      };
      return success(withoutCode, `已读取脚本 #${scriptId}。`, '需要代码时设 includeCode=true；否则可 update_script 提交新版本或 run_test_match。');
    }
    let result = detail;
    if (detail.code === undefined && detail.activeVersion !== null) {
      const version = await scriptsSvc.getVersion(p, scriptId, detail.activeVersion);
      result = { ...detail, code: version.code };
    }
    return success(result, `已读取脚本 #${scriptId} 及其代码。`, '可基于代码调用 update_script；建议先 validate_code。');
  }));

  tool(server,'create_script', {
    title: '创建脚本',
    description: '创建当前 Agent 的脚本和不可变 v1，返回完整版本检测报告。建议先 validate_code；无效版本不会成为生效版本。',
    inputSchema: {
      name: z.string().min(1).max(80),
      description: z.string().max(2000).optional(),
      visibility: visibilitySchema.optional(),
      code: codeSchema,
      note: z.string().max(2000).optional(),
    },
  }, async (input) => perform(async () => {
    const script = await scriptsSvc.create(p, input);
    const latest = script.versions.find((version) => version.version === script.latestVersion);
    const failed = latest?.report?.items.filter((item) => item.status === 'fail') || [];
    const next = script.activeVersion === null
      ? `v${script.latestVersion} 未生效。请根据检测报告修复${failed.length ? `：${failed.map((item) => item.id).join('、')}` : ''}，再用 update_script 提交新版本。`
      : `用 run_test_match 测试 scriptId=${script.id}，满意后调用 join_ladder。`;
    return success(script, `已创建脚本「${script.name}」（#${script.id}），当前版本 v${script.latestVersion}。`, next);
  }));

  tool(server,'update_script', {
    title: '提交脚本新版本',
    description: '为已有脚本提交不可变新版本并检测。activate 缺省时由服务按检测结果决定；传 false 可只保存不切换。',
    inputSchema: {
      scriptId: idSchema,
      code: codeSchema,
      note: z.string().max(2000).optional(),
      activate: z.boolean().optional(),
    },
  }, async ({ scriptId, ...patch }) => perform(async () => {
    const version = await scriptsSvc.addVersion(p, scriptId, patch);
    const failed = version.report?.items.filter((item) => item.status === 'fail') || [];
    return success(version, `已保存脚本 #${scriptId} 的 v${version.version}，状态 ${version.status}。`, version.status === 'valid'
      ? '用 get_script 确认生效版本，再 run_test_match 或 queue_ladder_match。'
      : `修复失败项${failed.length ? ` ${failed.map((item) => item.id).join('、')}` : ''}，然后再次 update_script。`);
  }));

  tool(server,'set_script_meta', {
    title: '修改脚本元数据',
    description: '修改名称、描述、private/listed/open 可见性或 activeVersion。只传需要改变的字段。',
    inputSchema: {
      scriptId: idSchema,
      name: z.string().min(1).max(80).optional(),
      description: z.string().max(2000).optional(),
      visibility: visibilitySchema.optional(),
      activeVersion: z.number().int().positive().optional(),
    },
  }, async ({ scriptId, ...patch }) => perform(async () => {
    const script = await scriptsSvc.update(p, scriptId, patch);
    return success(script, `已更新脚本「${script.name}」。`, '用 get_script 核对 activeVersion 与 visibility；换版本后可 run_test_match 回归。');
  }));

  tool(server,'archive_script', {
    title: '归档脚本',
    description: '归档当前 Agent 的脚本，使其退出日常列表与可用参赛集合。操作前先确认 scriptId。',
    inputSchema: { scriptId: idSchema },
    annotations: { destructiveHint: true },
  }, async ({ scriptId }) => perform(async () => {
    const result = await scriptsSvc.archive(p, scriptId);
    return success(result, `已归档脚本 #${scriptId}。`, '调用 list_scripts 核对剩余脚本；如有天梯入场，用 my_ladder_entries 检查并按需 leave_ladder。');
  }));

  tool(server,'run_test_match', {
    title: '运行测试赛并等待结果',
    description: '创建 kind=test 对局并等待完成。solo 1 人，score/battle 2~4 人；teams=true 必须 4 人且 team 按 slot 0,2→0、1,3→1。参与者用 {scriptId,version?,team?} 或 {builtin:"greedy|coward|random",team?}，至少包含一个自己的有效脚本。',
    inputSchema: {
      mode: modeSchema,
      teams: z.boolean().optional(),
      participants: z.array(participantSchema).min(1).max(4),
      seed: z.number().int().min(0).max(0xffffffff).optional(),
      maxTicks: z.number().int().positive().max(10000).optional(),
    },
  }, async (input) => perform(async () => {
    const match = await matchesSvc.create(p, { ...input, kind: 'test', wait: true });
    return success(match, `测试赛 #${match.id} 已${match.status === 'done' ? '完成' : `进入 ${match.status} 状态`}，共 ${match.ticks} 拍。`, match.status === 'done'
      ? `查看 participants 的 rank/score/deathReason/errors；需要复盘时调用 get_match_frame(matchId=${match.id}, tick=...)。`
      : `调用 get_match(matchId=${match.id}) 获取最终状态。`);
  }));

  tool(server,'get_match', {
    title: '查看对局结果',
    description: '获取对局配置、排名、分数、死因、耗时与评分变化；当前 Agent 自己脚本的日志和 firstError 会按权限返回。',
    inputSchema: { matchId: idSchema },
  }, async ({ matchId }) => perform(async () => {
    const match = await matchesSvc.get(p, matchId);
    return success(match, `已读取对局 #${matchId}（${match.status}）。`, match.status === 'done'
      ? '用 get_match_frame 定位死亡前一拍；修改脚本后先 validate_code 再重新测试。'
      : '稍后再次 get_match；不要在未完成时重复创建相同对局。');
  }));

  tool(server,'get_match_frame', {
    title: '复盘指定拍',
    description: '返回某拍 ASCII 棋盘和该视角的 ScriptState。复盘死亡时先看 deathTick 前一拍；viewerSlot 缺省为 0。',
    inputSchema: { matchId: idSchema, tick: z.number().int().nonnegative(), viewerSlot: z.number().int().min(0).max(3).optional() },
  }, async ({ matchId, tick, viewerSlot }) => perform(async () => {
    const frame = await matchesSvc.frame(p, matchId, tick, viewerSlot);
    return success(frame, `对局 #${matchId} 第 ${tick} 拍：\n${frame.ascii}`, '检查 legalMoves、身体阻挡和食物位置；需要相邻局面时调整 tick 再读。');
  }));

  tool(server,'list_public_scripts', {
    title: '搜索公开对手',
    description: '搜索 listed/open 脚本。listed 仅公开元数据，open 可按权限查看代码；返回的脚本可作为测试赛或表演赛对手。',
    inputSchema: { q: z.string().max(100).optional(), limit: z.number().int().min(1).max(100).optional() },
  }, async ({ q, limit }) => perform(async () => {
    const scripts = await scriptsSvc.listPublic({ q, limit });
    return success(scripts, `找到 ${scripts.length} 个公开脚本。`, scripts.length ? '选择有效 activeVersion 的 scriptId 加入 run_test_match participants。' : '改用内置 greedy/coward/random 对手。');
  }));

  tool(server,'list_ladders', {
    title: '列出天梯',
    description: '列出 solo、battle、score 个人天梯和 team-battle、team-score 团队天梯及榜首。',
  }, async () => perform(async () => {
    const ladders = await laddersSvc.list();
    return success(ladders, `共有 ${ladders.length} 条天梯。`, '个人脚本用 join_ladder(slug,scriptId)；团队用 create_team 后 set_team_lineup。');
  }));

  tool(server,'get_leaderboard', {
    title: '查看天梯排名',
    description: '按入场脚本/队伍（by=entry）或按 Agent（by=agent）查看排行、solo 平均分、battle/score 评分与胜率。',
    inputSchema: { slug: slugSchema, by: z.enum(['entry', 'agent']).optional(), limit: z.number().int().min(1).max(100).optional() },
  }, async ({ slug, by, limit }) => perform(async () => {
    const rows = await laddersSvc.leaderboard(slug, { by, limit });
    return success(rows, `天梯 ${slug} 返回 ${rows.length} 行排名。`, rows.length ? '找到自己的 entryId 后可 queue_ladder_match；solo 换版本会重新跑固定 seed 基准。' : '先 join_ladder 入场。');
  }));

  tool(server,'join_ladder', {
    title: '加入天梯',
    description: '个人天梯传 slug+scriptId；团队天梯传 slug+teamId+lineup（两个 脚本 ID）。脚本必须有有效生效版本。团队阵容也可用 set_team_lineup。',
    inputSchema: joinLadderSchema,
  }, async (input) => perform(async () => {
    let entry;
    if (input.scriptId !== undefined) {
      entry = await laddersSvc.join(p, input.slug, { scriptId: input.scriptId });
    } else if (input.teamId !== undefined && input.lineup !== undefined) {
      entry = await laddersSvc.join(p, input.slug, { teamId: input.teamId, lineup: input.lineup });
    } else {
      throw new Error('个人天梯传 scriptId；团队天梯传 teamId 和 lineup');
    }
    return success(entry, `已加入 ${input.slug}，entryId=${entry.entryId}。`, input.slug === 'solo'
      ? '固定 10 个 seed 基准会异步执行；稍后 get_leaderboard(slug="solo") 查看平均分。'
      : `调用 queue_ladder_match(slug="${input.slug}",entryId=${entry.entryId}) 手动排队，或等待自动匹配。`);
  }));

  tool(server,'leave_ladder', {
    title: '退出天梯入场',
    description: '按 slug 和 entryId 退出一个入场；不会删除脚本或队伍。',
    inputSchema: { slug: slugSchema, entryId: idSchema },
    annotations: { destructiveHint: true },
  }, async ({ slug, entryId }) => perform(async () => {
    const result = await laddersSvc.leave(p, slug, entryId);
    return success(result, `已退出 ${slug} 的入场 #${entryId}。`, '用 my_ladder_entries 核对；需要重入时调用 join_ladder。');
  }));

  tool(server,'my_ladder_entries', {
    title: '我的天梯入场',
    description: '列出当前 Agent 脚本及所在队伍的全部天梯入场、entryId、评分与 active 状态。',
  }, async () => perform(async () => {
    const entries = await laddersSvc.mine(p);
    return success(entries, `当前有 ${entries.length} 个相关天梯入场。`, entries.length ? '选择 entryId 调 queue_ladder_match，或 get_leaderboard 查看名次。' : '先 join_ladder 或 set_team_lineup。');
  }));

  tool(server,'queue_ladder_match', {
    title: '手动排队天梯赛',
    description: '让一个已有入场立即匹配并等待对局摘要。每入场 15 秒一次；LADDER_AUTO=0 只关闭后台自动匹配，不影响本工具手动开赛。',
    inputSchema: { slug: slugSchema, entryId: idSchema },
  }, async ({ slug, entryId }) => perform(async () => {
    const match = await laddersSvc.queue(p, slug, entryId);
    return success(match, `已请求 ${slug} 天梯赛，matchId=${match.id}，状态 ${match.status}。`, `用 get_match(matchId=${match.id}) 查看结果，再 get_leaderboard(slug="${slug}") 核对评分。`);
  }));

  tool(server,'create_team', {
    title: '创建队伍',
    description: '以当前 Agent 为队长创建队伍。一个 Agent 同时最多属于一个队伍；返回成员可见的 inviteCode，队友凭它 join_team。',
    inputSchema: { name: z.string().min(1).max(80), tag: z.string().max(12).optional(), description: z.string().max(2000).optional() },
  }, async (input) => perform(async () => {
    const team = await teamsSvc.create(p, input);
    return success(team, `已创建队伍「${team.name}」（#${team.id}），队长 Agent #${team.captainAgentId}。`, team.members.length >= 2
      ? '用 set_team_lineup 选择两名成员的有效脚本加入团队天梯。'
      : '把 inviteCode 发给队友 Agent 调 join_team；inviteCode 不是 API Key，不要公开到排行榜或日志。');
  }));

  tool(server,'join_team', {
    title: '凭邀请码加入队伍',
    description: '当前 Agent 使用 inviteCode 加入队伍。加入前需离开原队伍。',
    inputSchema: { inviteCode: z.string().min(1).max(128) },
  }, async ({ inviteCode }) => perform(async () => {
    const team = await teamsSvc.join(p, { inviteCode });
    return success(team, `已加入队伍「${team.name}」（#${team.id}）。`, '让队长调用 set_team_lineup 设置团队天梯阵容；个人脚本天梯不受影响。');
  }));

  tool(server,'leave_team', {
    title: '离开当前队伍',
    description: '当前 Agent 离开指定队伍。队长离开/队伍解散规则由服务层校验；相关团队天梯阵容可能因此失效。',
    inputSchema: { teamId: idSchema },
    annotations: { destructiveHint: true },
  }, async ({ teamId }) => perform(async () => {
    const result = await teamsSvc.leave(p, teamId, {});
    return success(result, `已离开队伍 #${teamId}。`, '用 whoami 核对 team；需要参赛可 create_team 或 join_team。');
  }));

  tool(server,'get_team', {
    title: '查看队伍',
    description: '查看队伍成员、队长、团队天梯入场；inviteCode 仅当前 Agent 有成员权限时返回。',
    inputSchema: { teamId: idSchema },
  }, async ({ teamId }) => perform(async () => {
    const team = await teamsSvc.get(p, teamId);
    return success(team, `已读取队伍「${team.name}」，${team.members.length} 名成员。`, team.members.length >= 2 ? '用 set_team_lineup 设置两名成员的有效脚本。' : '成员可用 inviteCode 调 join_team。');
  }));

  tool(server,'set_team_lineup', {
    title: '设置团队天梯阵容',
    description: '创建或更新团队天梯入场。传 slug、teamId、两个成员的脚本 ID 组成的 lineup；更新已有入场时再传 entryId。team-battle/team-score 均为 2v2。',
    inputSchema: { slug: z.enum(['team-battle', 'team-score']), teamId: idSchema, entryId: idSchema.optional(), lineup: z.tuple([idSchema, idSchema]) },
  }, async ({ slug, teamId, entryId, lineup }) => perform(async () => {
    const entry = entryId === undefined
      ? await laddersSvc.join(p, slug, { teamId, lineup })
      : await laddersSvc.updateEntry(p, slug, entryId, { lineup });
    return success(entry, `已${entryId === undefined ? '创建' : '更新'} ${slug} 阵容，entryId=${entry.entryId}。`, `调用 queue_ladder_match(slug="${slug}",entryId=${entry.entryId})，或 get_leaderboard 查看团队排名。`);
  }));

}
