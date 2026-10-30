import type { DecisionCode, Direction, ReviewMomentKind } from '../types';

export const DECISION_LABEL: Record<DecisionCode, string> = {
  ok: '正常',
  timeout: '超时',
  error: '报错',
  invalid: '非法返回',
  reverse: '掉头',
  builtin: '内置选手',
};

export const DIRECTION_LABEL: Record<Direction, string> = {
  up: '上',
  down: '下',
  left: '左',
  right: '右',
};

export const MOMENT_LABEL: Record<ReviewMomentKind, string> = {
  eat: '进食',
  death: '阵亡',
  kill: '击杀',
  win: '获胜',
  timeout: '超时',
  error: '报错',
  invalid: '非法返回',
  reverse: '掉头',
  disqualified: '失格',
  low_space: '空间不足',
  trapped: '被困',
  risky_move: '风险决策',
  slow_move: '耗时过高',
  starving: '久未进食',
};

export function seriesValue<T>(values: readonly T[], index: number): T | undefined {
  return index >= 0 && index < values.length ? values[index] : undefined;
}
