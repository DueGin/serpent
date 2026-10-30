import type { Direction, GameMode, Point, ScenarioInfo } from '../types';
import { createGame } from '../game/engine';
import { buildInitInfo, buildScriptState } from '../game/observe';
import { defaultConfig } from './config';

type Setup = { id: string; title: string; description: string; mode: GameMode; players: number; teams?: boolean;
  head?: Point; body?: Point[]; dir?: Direction; foods?: Point[];
  others?: Array<{ slot: number; body: Point[]; dir?: Direction }> };

const specs: Setup[] = [
  { id: 'solo-open', title: '单人开阔地', description: '基础单人寻食，判断合法方向。', mode: 'solo', players: 1, foods: [{ x: 8, y: 3 }] },
  { id: 'solo-corner', title: '单人近墙角', description: '面向边界时应提前转向。', mode: 'solo', players: 1, head: { x: 22, y: 1 }, body: [{ x: 22, y: 1 }, { x: 21, y: 1 }, { x: 20, y: 1 }], foods: [{ x: 22, y: 8 }] },
  { id: 'food-adjacent', title: '食物紧邻', description: '食物就在头部上方。', mode: 'solo', players: 1, foods: [{ x: 3, y: 2 }] },
  { id: 'trap-one-exit', title: '唯一安全出口', description: '上下有身体，只有向右安全。', mode: 'solo', players: 1, head: { x: 3, y: 3 }, body: [{ x: 3, y: 3 }, { x: 3, y: 4 }, { x: 2, y: 4 }, { x: 2, y: 3 }, { x: 2, y: 2 }, { x: 3, y: 2 }, { x: 4, y: 2 }], dir: 'right', foods: [{ x: 8, y: 3 }] },
  { id: 'long-body-self-trap', title: '长身体自撞', description: '长蛇身体围绕着头部。', mode: 'solo', players: 1, head: { x: 5, y: 5 }, body: [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 4, y: 4 }, { x: 5, y: 4 }, { x: 6, y: 4 }], foods: [{ x: 8, y: 5 }] },
  { id: 'battle-headon', title: '对手正面接近', description: '两个蛇头相向，避免对撞。', mode: 'battle', players: 2, head: { x: 7, y: 7 }, body: [{ x: 7, y: 7 }, { x: 6, y: 7 }, { x: 5, y: 7 }], others: [{ slot: 1, body: [{ x: 9, y: 7 }, { x: 10, y: 7 }, { x: 11, y: 7 }] }], foods: [{ x: 8, y: 7 }, { x: 5, y: 12 }, { x: 20, y: 10 }] },
  { id: 'score-wrap', title: '穿墙抢分', description: '比分模式下可从左边缘穿向右边缘。', mode: 'score', players: 2, head: { x: 0, y: 4 }, body: [{ x: 0, y: 4 }, { x: 1, y: 4 }, { x: 2, y: 4 }], dir: 'left', foods: [{ x: 27, y: 4 }, { x: 7, y: 10 }, { x: 17, y: 8 }] },
  { id: 'team-mate-adjacent', title: '队友紧邻', description: '组队规则允许蛇穿过队友身体。', mode: 'battle', players: 4, teams: true, head: { x: 7, y: 7 }, body: [{ x: 7, y: 7 }, { x: 6, y: 7 }, { x: 5, y: 7 }], others: [{ slot: 2, body: [{ x: 8, y: 7 }, { x: 8, y: 8 }, { x: 8, y: 9 }] }], foods: [{ x: 10, y: 7 }, { x: 6, y: 12 }, { x: 20, y: 5 }, { x: 23, y: 12 }] },
];

export function listScenarios(): ScenarioInfo[] {
  return specs.map((spec) => {
    const config = defaultConfig(spec.mode, { teams: spec.teams, seed: 12345, players: spec.players, maxTicks: 100 });
    const participants = Array.from({ length: spec.players }, (_, slot) => ({
      slot, name: `玩家 ${slot + 1}`, team: spec.teams ? slot % 2 : null,
      source: { kind: 'builtin' as const, bot: 'greedy' as const },
    }));
    const game = createGame({ config, participants, foods: spec.foods });
    const you = game.snakes.find((snake) => snake.slot === 0)!;
    if (spec.body) you.body = spec.body.map((point) => ({ ...point }));
    if (spec.head && !spec.body) you.body[0] = { ...spec.head };
    if (spec.dir) you.dir = spec.dir;
    for (const other of spec.others ?? []) {
      const snake = game.snakes.find((candidate) => candidate.slot === other.slot)!;
      snake.body = other.body.map((point) => ({ ...point }));
      if (other.dir) snake.dir = other.dir;
    }
    return { id: spec.id, title: spec.title, description: spec.description,
      init: buildInitInfo(game, 0), state: buildScriptState(game, 0) };
  });
}
