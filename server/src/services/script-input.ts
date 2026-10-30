import { z } from 'zod';
import { parseInput } from '../http';
import { OPPOSITE, type InitInfo, type ScriptState } from '../types';

const integer = z.number().int().safe();
const nameSchema = z.string().trim().min(1).max(80);
const modeSchema = z.enum(['solo', 'score', 'battle']);
const slotSchema = integer.min(0).max(3);
const directionSchema = z.enum(['up', 'down', 'left', 'right']);
const teamSchema = integer.min(0).max(1);
const pointSchema = z.object({ x: integer.min(0).max(511), y: integer.min(0).max(511) }).strict();
const dimensions = { width: integer.min(1).max(512), height: integer.min(1).max(512) };
const targetScoreSchema = integer.min(1).nullable();
const maxTicksSchema = integer.min(1).max(10000);
const identitySchema = z.object({ id: z.string().min(1).max(80), slot: slotSchema, team: teamSchema.nullable() }).strict();
const playerSchema = identitySchema.extend({ name: nameSchema });
const snakeSchema = playerSchema.extend({
  head: pointSchema.nullable(), body: z.array(pointSchema).max(65536),
  dir: directionSchema, length: integer.min(0).max(65536), score: integer.min(0), alive: z.boolean(),
}).superRefine((snake, ctx) => {
  const first = snake.body[0] ?? null;
  if (snake.length !== snake.body.length || (snake.alive && first === null) ||
      ((snake.head === null) !== (first === null)) ||
      (snake.head && first && (snake.head.x !== first.x || snake.head.y !== first.y))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '蛇的头部、身体与长度不一致' });
  }
});

function checkTeams(
  mode: string, teams: boolean, players: Array<{ slot: number; team: number | null }>,
  ctx: z.RefinementCtx,
): void {
  if ((teams && (mode === 'solo' || players.length !== 4)) ||
      (mode === 'solo' && players.length !== 1)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '模式与参赛人数不一致' });
  }
  if (players.some(player => player.team !== (teams ? player.slot % 2 : null))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '队伍编号与模式或位置不一致' });
  }
}

export const initSchema: z.ZodType<InitInfo> = z.object({
  protocol: z.literal('serpent-script-v1'), mode: modeSchema, teams: z.boolean(), ...dimensions,
  wrap: z.boolean(), maxTicks: maxTicksSchema, targetScore: targetScoreSchema,
  you: identitySchema, players: z.array(playerSchema).min(1).max(4),
  limits: z.object({
    moveTimeoutMs: integer.min(1).max(50), initTimeoutMs: integer.min(1).max(500),
    memoryLimitMB: integer.min(1).max(32),
  }).strict(),
}).strict().superRefine((info, ctx) => {
  checkTeams(info.mode, info.teams, info.players, ctx);
  if (new Set(info.players.map(player => player.slot)).size !== info.players.length ||
      new Set(info.players.map(player => player.id)).size !== info.players.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['players'], message: '选手编号和位置不能重复' });
  }
  if (!info.players.some(player => player.id === info.you.id && player.slot === info.you.slot && player.team === info.you.team)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['you'], message: '当前选手必须在 players 中' });
  }
});

export const stateSchema: z.ZodType<ScriptState> = z.object({
  protocol: z.literal('serpent-script-v1'), tick: integer.min(0).max(10000),
  maxTicks: maxTicksSchema, remainingTicks: integer.min(0).max(10000),
  mode: modeSchema, teams: z.boolean(), ...dimensions, wrap: z.boolean(), targetScore: targetScoreSchema,
  you: snakeSchema, snakes: z.array(snakeSchema).min(1).max(4), foods: z.array(pointSchema).max(64),
  legalMoves: z.array(directionSchema).max(4),
}).strict().superRefine((state, ctx) => {
  checkTeams(state.mode, state.teams, state.snakes, ctx);
  if (state.tick > state.maxTicks || state.remainingTicks !== state.maxTicks - state.tick) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['remainingTicks'], message: '剩余拍数与 tick、maxTicks 不一致' });
  }
  if (new Set(state.snakes.map(snake => snake.slot)).size !== state.snakes.length ||
      new Set(state.snakes.map(snake => snake.id)).size !== state.snakes.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['snakes'], message: '蛇的编号和位置不能重复' });
  }
  if (!state.snakes.some(snake => JSON.stringify(snake) === JSON.stringify(state.you))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['you'], message: '当前选手必须在 snakes 中' });
  }
  const points = [...state.foods, ...state.you.body, ...state.snakes.flatMap(snake => snake.body)];
  if (points.some(point => point.x >= state.width || point.y >= state.height)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['snakes'], message: '坐标不能超出地图范围' });
  }
  if (new Set(state.legalMoves).size !== state.legalMoves.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['legalMoves'], message: '方向不能重复' });
  }
  if (state.legalMoves.some(direction => direction === OPPOSITE[state.you.dir])) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['legalMoves'], message: 'legalMoves 不能包含掉头方向' });
  }
});


export interface DryRunOptions { scenario?: string; state?: ScriptState; init?: InitInfo }

export const dryRunOptionsShape = {
  scenario: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/, '场景名称格式不正确').optional(),
  state: stateSchema.optional(),
  init: initSchema.optional(),
};

export function refineDryRunOptions(input: DryRunOptions, ctx: z.RefinementCtx): void {
  if (input.scenario !== undefined && input.state !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['state'], message: '场景与自定义局面不能同时提供' });
  }
  if (input.state && input.init) {
    const state = input.state;
    const init = input.init;
    const samePlayers = init.players.length === state.snakes.length && init.players.every(player =>
      state.snakes.some(snake => snake.id === player.id && snake.slot === player.slot &&
        snake.name === player.name && snake.team === player.team));
    if (init.mode !== state.mode || init.teams !== state.teams || init.width !== state.width ||
        init.height !== state.height || init.wrap !== state.wrap || init.maxTicks !== state.maxTicks ||
        init.targetScore !== state.targetScore || init.you.id !== state.you.id ||
        init.you.slot !== state.you.slot || init.you.team !== state.you.team ||
        !samePlayers) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['init'], message: '初始化参数与自定义局面不一致' });
    }
  }
}

const optionsSchema = z.object(dryRunOptionsShape).strict().superRefine(refineDryRunOptions);

// Services validate the same resource bounds regardless of REST or MCP callers.
export function checkDryRunOptions(input: DryRunOptions): DryRunOptions {
  return parseInput(optionsSchema, { scenario: input.scenario, state: input.state, init: input.init });
}
