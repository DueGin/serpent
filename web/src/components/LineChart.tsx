import { useMemo, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

export interface LineChartSeries {
  id: string;
  label: string;
  color: string;
  values: Array<number | null>;
  dashed?: boolean;
}

const VIEW_WIDTH = 720;
const VIEW_HEIGHT = 232;
const PLOT_LEFT = 48;
const PLOT_RIGHT = 704;
const PLOT_TOP = 16;
const PLOT_BOTTOM = 192;
const PLOT_WIDTH = PLOT_RIGHT - PLOT_LEFT;
const PLOT_HEIGHT = PLOT_BOTTOM - PLOT_TOP;

interface ChartPath {
  id: string;
  color: string;
  dashed: boolean;
  d: string;
}

interface PointerPosition {
  currentTarget: SVGRectElement;
  clientX: number;
}

export function LineChart(props: {
  title: string;
  from: number;
  to: number;
  series: LineChartSeries[];
  currentTick: number;
  onSeek: (tick: number) => void;
  formatValue: (value: number) => string;
}) {
  const { title, from, to, series, currentTick, onSeek, formatValue } = props;
  const [hoverTick, setHoverTick] = useState<number | null>(null);
  const chart = useMemo(() => buildChart(series, from, to), [series, from, to]);

  if (series.length === 0 || !chart.hasData) {
    return (
      <div className="line-chart line-chart-empty" role="status">
        {series.length === 0 ? '暂无图表数据' : '暂无可绘制的数值'}
      </div>
    );
  }

  const displayedCurrentTick = clampTick(currentTick, from, to);
  const activeTick = hoverTick === null ? null : clampTick(hoverTick, from, to);
  const currentX = tickX(displayedCurrentTick, from, to);
  const hoverX = activeTick === null ? null : tickX(activeTick, from, to);
  const hoverValues = activeTick === null ? [] : series.flatMap((item) => {
    const value = finiteValueAt(item.values, activeTick - from);
    return value === null ? [] : [{ id: item.id, label: item.label, color: item.color, value }];
  });

  function handleKeyDown(event: ReactKeyboardEvent<SVGSVGElement>) {
    let target: number | null = null;
    if (event.key === 'ArrowLeft') target = clampTick(displayedCurrentTick - 1, from, to);
    else if (event.key === 'ArrowRight') target = clampTick(displayedCurrentTick + 1, from, to);
    else if (event.key === 'Home') target = from;
    else if (event.key === 'End') target = to;
    else if (event.key === 'Enter' || event.key === ' ') target = activeTick ?? displayedCurrentTick;
    else return;
    event.preventDefault();
    event.stopPropagation();
    onSeek(target);
  }

  return (
    <div className="line-chart">
      <svg
        className="line-chart-svg"
        width="100%"
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        role="slider"
        tabIndex={0}
        aria-label={`${title}，左右键逐拍，回车或空格跳转`}
        aria-valuemin={from}
        aria-valuemax={to}
        aria-valuenow={displayedCurrentTick}
        aria-valuetext={activeTick === null ? `第 ${displayedCurrentTick} 拍` : `第 ${activeTick} 拍`}
        aria-orientation="horizontal"
        onKeyDown={handleKeyDown}
        onPointerLeave={() => setHoverTick(null)}
      >
        <title>{title}</title>
        <rect className="line-chart-background" x={PLOT_LEFT} y={PLOT_TOP} width={PLOT_WIDTH} height={PLOT_HEIGHT} fill="transparent" />
        {chart.yTicks.map((tick) => (
          <g className="line-chart-y-tick" key={tick.y}>
            <line x1={PLOT_LEFT} x2={PLOT_RIGHT} y1={tick.y} y2={tick.y} stroke="currentColor" strokeOpacity={0.12} />
            <text x={PLOT_LEFT - 8} y={tick.y} textAnchor="end" dominantBaseline="middle" fill="currentColor" fontSize={10}>
              {formatAxisValue(tick.value)}
            </text>
          </g>
        ))}
        {chart.xTicks.map((tick) => (
          <text
            className="line-chart-x-tick"
            key={tick}
            x={tickX(tick, from, to)}
            y={PLOT_BOTTOM + 22}
            textAnchor={tick === from ? 'start' : tick === to ? 'end' : 'middle'}
            fill="currentColor"
            fontSize={10}
          >
            #{tick}
          </text>
        ))}
        <g className="line-chart-series" fill="none" strokeLinecap="round" strokeLinejoin="round">
          {chart.paths.map((path) => (
            <path
              className="line-chart-path"
              key={path.id}
              d={path.d}
              stroke={path.color}
              strokeWidth={path.dashed ? 1.25 : 1.75}
              strokeDasharray={path.dashed ? '5 4' : undefined}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </g>
        {hoverX !== null && (
          <line className="line-chart-hover-line" x1={hoverX} x2={hoverX} y1={PLOT_TOP} y2={PLOT_BOTTOM} stroke="currentColor" strokeOpacity={0.3} />
        )}
        <line className="line-chart-current" x1={currentX} x2={currentX} y1={PLOT_TOP - 4} y2={PLOT_BOTTOM + 4} stroke="currentColor" strokeWidth={1.25} vectorEffect="non-scaling-stroke" />
        <rect
          className="line-chart-hit-area"
          x={PLOT_LEFT}
          y={PLOT_TOP}
          width={PLOT_WIDTH}
          height={PLOT_HEIGHT}
          fill="transparent"
          onPointerMove={(event) => setHoverTick(pointerTick(event, from, to))}
          onClick={(event) => onSeek(pointerTick(event, from, to))}
        />
      </svg>
      <div className="line-chart-legend" aria-label="折线图图例">
        {series.map((item) => (
          <span className="line-chart-legend-item" key={item.id}>
            <svg width={20} height={8} viewBox="0 0 20 8" aria-hidden="true">
              <path d="M 1 4 L 19 4" fill="none" stroke={item.color} strokeWidth={2} strokeDasharray={item.dashed ? '4 3' : undefined} />
            </svg>
            <span>{item.label}</span>
          </span>
        ))}
      </div>
      <div className="line-chart-readout">
        {activeTick === null ? (
          <span className="line-chart-hint">悬停查看数值，点击跳拍</span>
        ) : (
          <>
            <strong className="line-chart-readout-tick">第 {activeTick} 拍</strong>
            {hoverValues.length === 0 ? <span>本拍各线均为空</span> : hoverValues.map((item) => (
              <span className="line-chart-readout-value" key={item.id}>
                <i style={{ backgroundColor: item.color }} aria-hidden="true" />
                {item.label}：{formatValue(item.value)}
              </span>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function buildChart(series: LineChartSeries[], from: number, to: number) {
  const tickCount = validTickCount(from, to);
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const item of series) {
    for (let index = 0; index < tickCount; index += 1) {
      const value = finiteValueAt(item.values, index);
      if (value === null) continue;
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
  }

  const hasData = tickCount > 0 && Number.isFinite(minimum) && Number.isFinite(maximum);
  if (!hasData) return { hasData, paths: [] as ChartPath[], yTicks: [], xTicks: [] as number[] };

  const domainMinimum = Math.min(0, minimum);
  let domainMaximum = Math.max(0, maximum);
  if (domainMaximum === domainMinimum) domainMaximum = domainMinimum + 1;
  const domainSize = domainMaximum - domainMinimum;
  const yForValue = (value: number) => PLOT_BOTTOM - ((value - domainMinimum) / domainSize) * PLOT_HEIGHT;

  const paths = series.flatMap((item) => {
    const d = linePath(item.values, tickCount, from, to, yForValue);
    return d ? [{ id: item.id, color: item.color, dashed: item.dashed === true, d }] : [];
  });
  const yTicks = Array.from({ length: 5 }, (_, index) => ({
    value: domainMaximum - (domainSize * index) / 4,
    y: PLOT_TOP + (PLOT_HEIGHT * index) / 4,
  }));
  const middle = Math.round((from + to) / 2);
  const xTicks = from === to ? [from] : middle === from || middle === to ? [from, to] : [from, middle, to];
  return { hasData, paths, yTicks, xTicks };
}

function linePath(
  values: Array<number | null>,
  tickCount: number,
  from: number,
  to: number,
  yForValue: (value: number) => number,
): string {
  const commands: string[] = [];
  let segmentPoints = 0;
  let previousX = 0;
  let previousY = 0;
  for (let index = 0; index < tickCount; index += 1) {
    const value = finiteValueAt(values, index);
    if (value === null) {
      if (segmentPoints === 1) commands.push(`L${coordinate(previousX)} ${coordinate(previousY)}`);
      segmentPoints = 0;
      continue;
    }
    const x = tickX(from + index, from, to);
    const y = yForValue(value);
    commands.push(`${segmentPoints === 0 ? 'M' : 'L'}${coordinate(x)} ${coordinate(y)}`);
    segmentPoints += 1;
    previousX = x;
    previousY = y;
  }
  if (segmentPoints === 1) commands.push(`L${coordinate(previousX)} ${coordinate(previousY)}`);
  return commands.join('');
}

function finiteValueAt(values: Array<number | null>, index: number): number | null {
  if (index < 0 || index >= values.length) return null;
  const value = values[index];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function validTickCount(from: number, to: number): number {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return 0;
  return Math.floor(to - from) + 1;
}

function clampTick(tick: number, from: number, to: number): number {
  return Math.max(from, Math.min(to, Math.round(tick)));
}

function tickX(tick: number, from: number, to: number): number {
  if (to === from) return PLOT_LEFT + PLOT_WIDTH / 2;
  return PLOT_LEFT + ((tick - from) / (to - from)) * PLOT_WIDTH;
}

function pointerTick(event: PointerPosition, from: number, to: number): number {
  const bounds = event.currentTarget.getBoundingClientRect();
  if (bounds.width <= 0) return clampTick(from, from, to);
  const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
  return clampTick(from + ratio * (to - from), from, to);
}

function coordinate(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}

function formatAxisValue(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Math.abs(rounded) >= 1000 ? `${Math.round(rounded / 100) / 10}k` : String(rounded);
}
