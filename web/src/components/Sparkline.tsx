import { useMemo, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

const VIEW_WIDTH = 320;
const VIEW_HEIGHT = 76;
const PLOT_LEFT = 5;
const PLOT_RIGHT = 315;
const PLOT_TOP = 8;
const PLOT_BOTTOM = 62;
const PLOT_WIDTH = PLOT_RIGHT - PLOT_LEFT;
const PLOT_HEIGHT = PLOT_BOTTOM - PLOT_TOP;

interface PointerPosition {
  currentTarget: SVGRectElement;
  clientX: number;
}

export function Sparkline(props: {
  values: Array<number | null>;
  label: string;
  color: string;
  formatValue: (value: number) => string;
}) {
  const { values, label, color, formatValue } = props;
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const path = useMemo(() => sparklinePath(values), [values]);

  if (values.length === 0 || !path) {
    return <div className="sparkline sparkline-empty" role="status">暂无趋势数据</div>;
  }

  const latest = latestValue(values);
  const activeIndex = hoverIndex === null ? null : Math.max(0, Math.min(values.length - 1, hoverIndex));
  const activeValue = activeIndex === null ? null : finiteValueAt(values, activeIndex);
  const activeX = activeIndex === null ? null : pointX(activeIndex, values.length);
  const accessibleLabel = activeIndex === null
    ? `${label}，使用左右键查看各场数值`
    : `${label}，第 ${activeIndex + 1} 场，${activeValue === null ? '无数据' : formatValue(activeValue)}`;

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    let target: number | null = null;
    if (event.key === 'ArrowLeft') target = Math.max(0, (activeIndex ?? latest?.index ?? values.length) - 1);
    else if (event.key === 'ArrowRight') target = Math.min(values.length - 1, (activeIndex ?? -1) + 1);
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = values.length - 1;
    else return;
    event.preventDefault();
    event.stopPropagation();
    setHoverIndex(target);
  }

  return (
    <div
      className="sparkline"
      role="group"
      tabIndex={0}
      aria-label={accessibleLabel}
      onKeyDown={handleKeyDown}
      onBlur={() => setHoverIndex(null)}
    >
      <svg
        className="sparkline-svg"
        width="100%"
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        role="img"
        aria-label={label}
        onPointerLeave={() => setHoverIndex(null)}
      >
        <path className="sparkline-path" d={path} fill="none" stroke={color} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {activeX !== null && (
          <line className="sparkline-hover-line" x1={activeX} x2={activeX} y1={PLOT_TOP} y2={PLOT_BOTTOM} stroke="currentColor" strokeOpacity={0.4} pointerEvents="none" />
        )}
        <rect
          className="sparkline-hit-area"
          x={PLOT_LEFT}
          y={PLOT_TOP}
          width={PLOT_WIDTH}
          height={PLOT_HEIGHT}
          fill="transparent"
          onPointerMove={(event) => setHoverIndex(pointerIndex(event, values.length))}
        />
      </svg>
      <div className="sparkline-readout">
        {activeIndex !== null ? (
          <span>#{activeIndex + 1} · {activeValue === null ? '无数据' : formatValue(activeValue)}</span>
        ) : latest ? (
          <span className="sparkline-latest">最新 {formatValue(latest.value)}</span>
        ) : <span>无数据</span>}
      </div>
    </div>
  );
}

function sparklinePath(values: Array<number | null>): string {
  let minimum = Infinity;
  let maximum = -Infinity;
  for (let index = 0; index < values.length; index += 1) {
    const value = finiteValueAt(values, index);
    if (value === null) continue;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return '';

  const basePadding = minimum === maximum ? Math.abs(minimum) * 0.1 || 1 : (maximum - minimum) * 0.08;
  const domainMinimum = minimum - basePadding;
  const domainSize = maximum + basePadding - domainMinimum;
  const commands: string[] = [];
  let segmentPoints = 0;
  let previousX = 0;
  let previousY = 0;

  for (let index = 0; index < values.length; index += 1) {
    const value = finiteValueAt(values, index);
    if (value === null) {
      if (segmentPoints === 1) commands.push(`L${coordinate(previousX)} ${coordinate(previousY)}`);
      segmentPoints = 0;
      continue;
    }
    const x = pointX(index, values.length);
    const y = PLOT_BOTTOM - ((value - domainMinimum) / domainSize) * PLOT_HEIGHT;
    commands.push(`${segmentPoints === 0 ? 'M' : 'L'}${coordinate(x)} ${coordinate(y)}`);
    segmentPoints += 1;
    previousX = x;
    previousY = y;
  }
  if (segmentPoints === 1) commands.push(`L${coordinate(previousX)} ${coordinate(previousY)}`);
  return commands.join('');
}

function latestValue(values: Array<number | null>): { index: number; value: number } | null {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = finiteValueAt(values, index);
    if (value !== null) return { index, value };
  }
  return null;
}

function finiteValueAt(values: Array<number | null>, index: number): number | null {
  if (index < 0 || index >= values.length) return null;
  const value = values[index];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function pointX(index: number, count: number): number {
  if (count <= 1) return PLOT_LEFT + PLOT_WIDTH / 2;
  return PLOT_LEFT + (index / (count - 1)) * PLOT_WIDTH;
}

function pointerIndex(event: PointerPosition, count: number): number {
  const bounds = event.currentTarget.getBoundingClientRect();
  if (bounds.width <= 0 || count <= 1) return 0;
  const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
  return Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1))));
}

function coordinate(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}
