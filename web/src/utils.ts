import type { DeathReason, EndReason, GameMode, MatchKind, MatchStatus, ScriptLanguage, ScriptVisibility, VersionStatus } from './types';

export const MODE_LABEL: Record<GameMode, string> = { solo: '单人基准', score: '抢分赛', battle: '生存战' };
export const SCRIPT_LANGUAGE_LABEL: Record<ScriptLanguage, string> = { javascript: 'JavaScript', python: 'Python' };
export const KIND_LABEL: Record<MatchKind, string> = { test: '测试', exhibition: '表演', ladder: '天梯', benchmark: '基准' };
export const STATUS_LABEL: Record<MatchStatus, string> = { queued: '排队中', running: '模拟中', done: '已完成', error: '异常' };
export const DEATH_LABEL: Record<DeathReason, string> = { wall: '撞墙', self: '咬到自己', snake: '撞上对手', head: '头对头', starve: '生命值耗尽', disqualified: '失格' };
export const END_LABEL: Record<EndReason, string> = { last_alive: '最后存活', all_dead: '全部阵亡', max_ticks: '达到拍数上限', target_score: '达到目标分' };
export const VISIBILITY_LABEL: Record<ScriptVisibility, string> = { private: '私有', listed: '公开挑战', open: '代码公开' };
export const VERSION_LABEL: Record<VersionStatus, string> = { pending: '检测中', valid: '可参赛', invalid: '未通过' };

export function formatDate(value: number | null | undefined): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(value);
}

export function formatNumber(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const normalized = value >= 0 && value <= 1 ? value * 100 : value;
  return `${normalized.toFixed(1)}%`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '发生未知错误，请稍后重试';
}

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const input = document.createElement('textarea');
  input.value = text;
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  document.execCommand('copy');
  input.remove();
}
