import type { GameMode, MatchConfig } from '../types';

export { ENGINE_VERSION } from '../game/engine';

export function defaultConfig(mode: GameMode, opts: { teams?: boolean; seed?: number; maxTicks?: number; players?: number } = {}): MatchConfig {
  const teams = Boolean(opts.teams);
  if (mode === 'solo' && teams) throw new Error('solo 模式不支持组队');
  const players = mode === 'solo' ? 1 : teams ? 4 : Math.max(2, Math.min(4, opts.players ?? 4));
  return {
    mode, teams,
    width: mode === 'solo' ? 24 : 28,
    height: mode === 'solo' ? 16 : 20,
    wrap: mode === 'score',
    foodCount: mode === 'solo' ? 1 : Math.max(3, Math.min(4, players)),
    maxTicks: opts.maxTicks ?? (mode === 'solo' ? 1500 : mode === 'score' ? 500 : 1000),
    targetScore: null,
    seed: (opts.seed ?? 0) >>> 0,
    moveTimeoutMs: 50,
    initTimeoutMs: 500,
    memoryLimitMB: 32,
    matchCpuBudgetMs: 30_000,
  };
}
