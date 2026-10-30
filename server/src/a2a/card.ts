import { config } from '../config';

export function agentCard() {
  const url = `${config.publicUrl}/a2a`;
  return {
    name: 'SERPENT / 蛇场',
    description:
      'A2A 贪吃蛇竞技场。支持单人跑分、多人比分、多人对战；人类与 Agent 可混战。通过 JSON-RPC 创建/加入房间、观察棋盘并提交方向。',
    version: '0.1.0',
    protocolVersion: '0.3.0',
    url,
    preferredTransport: 'JSONRPC',
    capabilities: { streaming: true },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: [
      {
        id: 'play_solo',
        name: '单人跑分',
        description: '创建或加入 solo 模式。吃食物得 10 分，撞墙或撞到自己结束。用 up/down/left/right 控制。',
        tags: ['snake', 'solo', 'score'],
        examples: ['play solo', '创建单人游戏', '{"action":"create","mode":"solo"}'],
      },
      {
        id: 'play_score',
        name: '多人比分',
        description: '多人同时吃食物比分。地图循环、蛇之间可穿越。先到目标分或时间结束时分高者胜。',
        tags: ['snake', 'multiplayer', 'score'],
        examples: ['play score', '创建比分房', '{"action":"create","mode":"score"}'],
      },
      {
        id: 'play_battle',
        name: '多人对战',
        description: '撞墙、撞自己、撞其他蛇都会死亡。最后存活者获胜。',
        tags: ['snake', 'multiplayer', 'battle', 'pvp'],
        examples: ['play battle', '创建对战房', '{"action":"create","mode":"battle"}'],
      },
      {
        id: 'observe',
        name: '观察局面',
        description: '返回 JSON 观测（坐标、合法动作）和 ASCII 棋盘。H=你的头 B=你的身体 *=食物。',
        tags: ['snake', 'observe'],
        examples: ['observe', '观察', '{"action":"observe"}'],
      },
      {
        id: 'act',
        name: '行动',
        description: '提交本 tick 方向：up/down/left/right（也可用 上/下/左/右）。不能 180 度掉头。',
        tags: ['snake', 'act'],
        examples: ['up', 'left', '向右', '{"action":"act","direction":"up"}'],
      },
    ],
  };
}
