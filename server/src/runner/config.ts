import type { GameMode, MatchConfig } from '../types';

/** Stored configs written before rulesets existed lack these fields; they are classic. */
export type StoredMatchConfig = Omit<MatchConfig, 'ruleset' | 'maxHp'> & Partial<Pick<MatchConfig, 'ruleset' | 'maxHp'>>;

export function normalizeConfig(config: StoredMatchConfig): MatchConfig {
  return { ...config, ruleset: config.ruleset ?? 'classic', maxHp: config.maxHp ?? null };
}

export { ENGINE_VERSION } from '../game/engine';

export function defaultConfig(mode: GameMode, opts: { teams?: boolean; seed?: number; maxTicks?: number; players?: number } = {}): MatchConfig {
  const teams = Boolean(opts.teams);
  if (mode === 'solo' && teams) throw new Error('solo 模式不支持组队');
  const players = mode === 'solo' ? 1 : teams ? 4 : Math.max(2, Math.min(4, opts.players ?? 4));
  return {
    mode, teams,
    // 个人赛（含 solo）16×16，2v2 团队赛 32×32。
    width: teams ? 32 : 16,
    height: teams ? 32 : 16,
    wrap: false,
    foodCount: players * 4,
    maxTicks: opts.maxTicks ?? (mode === 'solo' ? 1500 : mode === 'score' ? 500 : 1000),
    targetScore: null,
    seed: (opts.seed ?? 0) >>> 0,
    moveTimeoutMs: 50,
    initTimeoutMs: 500,
    memoryLimitMB: 32,
    matchCpuBudgetMs: 30_000,
    ruleset: 'survival',
    maxHp: 100,
  };
}
