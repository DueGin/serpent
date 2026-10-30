import { z } from 'zod';

export const idSchema = z.number().int().positive();
export const directionSchema = z.enum(['up', 'down', 'left', 'right']);
export const modeSchema = z.enum(['solo', 'score', 'battle']);
export const visibilitySchema = z.enum(['private', 'listed', 'open']);
export const builtinSchema = z.enum(['greedy', 'coward', 'random']);

export const pointSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
});

export const snakeViewSchema = z.object({
  id: z.string(),
  slot: z.number().int(),
  name: z.string(),
  team: z.number().int().nullable(),
  head: pointSchema.nullable(),
  body: z.array(pointSchema),
  dir: directionSchema,
  length: z.number().int().nonnegative(),
  score: z.number(),
  alive: z.boolean(),
});

export const stateSchema = z.object({
  protocol: z.literal('serpent-script-v1'),
  tick: z.number().int().nonnegative(),
  maxTicks: z.number().int().positive(),
  remainingTicks: z.number().int().nonnegative(),
  mode: modeSchema,
  teams: z.boolean(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  wrap: z.boolean(),
  targetScore: z.number().nullable(),
  you: snakeViewSchema,
  snakes: z.array(snakeViewSchema),
  foods: z.array(pointSchema),
  legalMoves: z.array(directionSchema),
});

export const initSchema = z.object({
  protocol: z.literal('serpent-script-v1'),
  mode: modeSchema,
  teams: z.boolean(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  wrap: z.boolean(),
  maxTicks: z.number().int().positive(),
  targetScore: z.number().nullable(),
  you: z.object({ id: z.string(), slot: z.number().int(), team: z.number().int().nullable() }),
  players: z.array(z.object({
    id: z.string(),
    slot: z.number().int(),
    name: z.string(),
    team: z.number().int().nullable(),
  })),
  limits: z.object({
    moveTimeoutMs: z.number().positive(),
    initTimeoutMs: z.number().positive(),
    memoryLimitMB: z.number().positive(),
  }),
});

export const participantSchema = z.union([
  z.object({
    scriptId: idSchema,
    version: z.number().int().positive().optional(),
    team: z.number().int().min(0).max(1).optional(),
  }),
  z.object({
    builtin: builtinSchema,
    team: z.number().int().min(0).max(1).optional(),
  }),
]);

export const dryRunSchema = z.object({
  code: z.string().max(64 * 1024).optional(),
  scriptId: idSchema.optional(),
  version: z.number().int().positive().optional(),
  scenario: z.string().min(1).optional(),
  state: stateSchema.optional(),
  init: initSchema.optional(),
}).refine((input) => (input.code === undefined) !== (input.scriptId === undefined), {
  message: 'code 与 scriptId 必须且只能提供一个',
});

export const joinLadderSchema = z.object({
  slug: z.enum(['solo', 'battle', 'score', 'team-battle', 'team-score']),
  scriptId: idSchema.optional(),
  teamId: idSchema.optional(),
  lineup: z.tuple([idSchema, idSchema]).optional(),
}).refine((input) => input.scriptId !== undefined || (input.teamId !== undefined && input.lineup !== undefined), {
  message: '个人天梯传 scriptId；团队天梯传 teamId 和两个成员脚本 ID 组成的 lineup',
}).refine((input) => !(input.scriptId !== undefined && input.teamId !== undefined), {
  message: 'scriptId 与 teamId 不能同时提供',
});
