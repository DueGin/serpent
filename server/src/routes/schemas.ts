import { z } from 'zod';
import { dryRunOptionsShape, refineDryRunOptions } from '../services/script-input';

export { initSchema, stateSchema } from '../services/script-input';

const integer = z.number().int().safe();
export const idSchema = integer.positive();
export const pathId = z.string().regex(/^[1-9]\d*$/, '编号必须为正整数').transform(Number).pipe(idSchema);
export const pathTick = z.string().regex(/^\d+$/, '拍数必须为非负整数').transform(Number).pipe(integer.min(0));
export const slugSchema = z.string().min(1).max(80).regex(/^[a-z0-9-]+$/, '名称格式不正确');
export const nameSchema = z.string().trim().min(1).max(80);
export const descriptionSchema = z.string().max(4000);
export const codeSchema = z.string().min(1, '脚本不能为空').refine(
  code => Buffer.byteLength(code, 'utf8') <= 64 * 1024,
  '脚本不能超过 64KB（UTF-8）',
);
const noteSchema = z.string().max(2000);
const visibilitySchema = z.enum(['private', 'listed', 'open']);
const modeSchema = z.enum(['solo', 'score', 'battle']);
const slotSchema = integer.min(0).max(3);
const teamSchema = integer.min(0).max(1);

function nonemptyPatch<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).strict().refine(patch => Object.keys(patch).length > 0, '至少提供一个需要修改的字段');
}

export const agentCreateSchema = z.object({
  name: nameSchema, modelLabel: z.string().max(120).optional(), description: descriptionSchema.optional(),
}).strict();
export const agentPatchSchema = nonemptyPatch({
  name: nameSchema.optional(), modelLabel: z.string().max(120).optional(), description: descriptionSchema.optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, '颜色必须为六位十六进制色值').optional(), disabled: z.boolean().optional(),
});
export const scriptCreateSchema = z.object({
  agentId: idSchema.optional(), name: nameSchema, description: descriptionSchema.optional(),
  visibility: visibilitySchema.optional(), code: codeSchema, note: noteSchema.optional(),
}).strict();
export const scriptPatchSchema = nonemptyPatch({
  name: nameSchema.optional(), description: descriptionSchema.optional(), visibility: visibilitySchema.optional(),
  activeVersion: idSchema.optional(),
});
export const versionCreateSchema = z.object({ code: codeSchema, note: noteSchema.optional(), activate: z.boolean().optional() }).strict();
export const validateSchema = z.object({ code: codeSchema }).strict();
export const dryRunSchema = z.object({
  code: codeSchema.optional(), scriptId: idSchema.optional(), version: idSchema.optional(),
  ...dryRunOptionsShape,
}).strict().superRefine((input, ctx) => {
  if ((input.code !== undefined) === (input.scriptId !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['code'], message: '请且仅提供 code 或 scriptId 之一' });
  }
  if (input.version !== undefined && input.scriptId === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['version'], message: '指定版本时必须提供 scriptId' });
  }
  refineDryRunOptions(input, ctx);
});

// Strict union branches prevent mixed builtin/script references from being silently accepted.
const participantSchema = z.union([
  z.object({ scriptId: idSchema, version: idSchema.optional(), team: teamSchema.optional() }).strict(),
  z.object({ builtin: z.enum(['greedy', 'coward', 'random']), team: teamSchema.optional() }).strict(),
]);
export const matchCreateSchema = z.object({
  kind: z.enum(['test', 'exhibition']), mode: modeSchema, teams: z.boolean().optional(),
  participants: z.array(participantSchema).min(1).max(4), seed: integer.min(0).max(0xffffffff).optional(),
  maxTicks: integer.min(1).max(10000).optional(), wait: z.boolean().optional(), agentId: idSchema.optional(),
}).strict().superRefine((input, ctx) => {
  const count = input.participants.length;
  if (input.mode === 'solo' ? count !== 1 : count < 2) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['participants'], message: '单人赛需要 1 位选手，多人赛需要 2 至 4 位选手' });
  }
  if (input.teams && (input.mode === 'solo' || count !== 4)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['teams'], message: '组队赛仅支持 4 人 score/battle' });
  }
  input.participants.forEach((participant, slot) => {
    if (participant.team !== undefined && (!input.teams || participant.team !== slot % 2)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['participants', slot, 'team'], message: '队伍必须与位置一致（0、2 为一队；1、3 为另一队）' });
    }
  });
});

const lineupSchema = z.tuple([idSchema, idSchema]).refine(([a, b]) => a !== b, '阵容中不能使用同一个脚本两次');
export const ladderJoinSchema = z.union([
  z.object({ scriptId: idSchema }).strict(),
  z.object({ teamId: idSchema, lineup: lineupSchema }).strict(),
]);
export const ladderPatchSchema = nonemptyPatch({
  scriptId: idSchema.optional(), lineup: lineupSchema.optional(), active: z.boolean().optional(),
}).refine(patch => !(patch.scriptId !== undefined && patch.lineup !== undefined), '个人脚本与团队阵容不能同时修改');
const tagSchema = z.string().trim().max(12);
export const teamCreateSchema = z.object({
  agentId: idSchema.optional(), name: nameSchema, tag: tagSchema.optional(), description: descriptionSchema.optional(),
}).strict();
export const teamPatchSchema = nonemptyPatch({ name: nameSchema.optional(), tag: tagSchema.optional(), description: descriptionSchema.optional() });
export const teamJoinSchema = z.object({ agentId: idSchema.optional(), inviteCode: z.string().trim().min(1).max(128) }).strict();
export const teamLeaveSchema = z.object({ agentId: idSchema.optional() }).strict();
export const teamKickSchema = z.object({ agentId: idSchema }).strict();
export const emptySchema = z.object({}).strict();

const queryLimit = pathId.pipe(integer.max(100));
export const mineScriptsQuery = z.object({ agentId: pathId.optional() }).strict();
export const publicScriptsQuery = z.object({ q: z.string().trim().max(200).optional(), limit: queryLimit.optional() }).strict();
export const matchesQuery = z.object({
  kind: z.enum(['test', 'exhibition', 'ladder', 'benchmark']).optional(), ladder: slugSchema.optional(),
  agentId: pathId.optional(), scriptId: pathId.optional(), teamId: pathId.optional(),
  limit: queryLimit.optional(), before: pathId.optional(),
}).strict();
export const leaderboardQuery = z.object({ by: z.enum(['entry', 'agent']).optional(), limit: queryLimit.optional() }).strict();
export const frameQuery = z.object({ viewer: pathTick.pipe(slotSchema).optional() }).strict();
export const reviewQuery = z.object({
  slot: pathTick.pipe(slotSchema).optional(), series: z.literal('1').optional(),
  from: pathTick.optional(), to: pathTick.optional(),
}).strict().superRefine((query, ctx) => {
  if (query.from !== undefined && query.to !== undefined && query.from > query.to) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['from'], message: '起始拍数不能大于结束拍数' });
  }
  if (query.from !== undefined && query.to !== undefined && query.to - query.from > 5000) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: '逐拍序列范围最多跨度 5000 拍' });
  }
});
export const trendQuery = z.object({ mode: modeSchema.optional(), limit: pathId.pipe(integer.max(200)).optional() }).strict();
