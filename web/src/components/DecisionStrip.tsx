import { useMemo, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { DecisionCode, ReviewSeries } from '../types';

const VIEW_WIDTH = 760;
const PLOT_LEFT = 140;
const PLOT_RIGHT = 748;
const PLOT_WIDTH = PLOT_RIGHT - PLOT_LEFT;
const ROW_TOP = 6;
const ROW_HEIGHT = 16;
const ROW_GAP = 8;
const ROW_STEP = ROW_HEIGHT + ROW_GAP;
const BOTTOM_SPACE = 24;

interface DecisionMeta {
  code: DecisionCode | null;
  label: string;
  color: string;
}

interface DecisionPath {
  code: DecisionCode | null;
  color: string;
  d: string;
}

interface DecisionRow {
  slot: number;
  y: number;
  paths: DecisionPath[];
}

interface DecisionChart {
  rows: DecisionRow[];
  height: number;
  tickCount: number;
  xTicks: number[];
}

interface HoverCell {
  tick: number;
  slot: number;
}

interface PointerPosition {
  currentTarget: SVGRectElement;
  clientX: number;
}

const DECISION_META: DecisionMeta[] = [
  { code: 'ok', label: '正常', color: '#3ecf8e' },
  { code: 'timeout', label: '超时', color: '#e8a547' },
  { code: 'error', label: '错误', color: '#e23d2a' },
  { code: 'invalid', label: '非法返回', color: '#a982d8' },
  { code: 'reverse', label: '反向', color: '#a982d8' },
  { code: 'builtin', label: '内置', color: '#8b8175' },
  { code: null, label: '无数据', color: '#29261f' },
];

export function DecisionStrip(props: {
  participants: Array<{ slot: number; name: string; color: string }>;
  series: ReviewSeries[];
  from: number;
  to: number;
  currentTick: number;
  hasTrace: boolean;
  onSeek: (tick: number) => void;
}) {
  const { participants, series, from, to, currentTick, hasTrace, onSeek } = props;
  const [hover, setHover] = useState<HoverCell | null>(null);
  const chart = useMemo<DecisionChart>(
    () => hasTrace ? buildDecisionChart(participants, series, from, to) : emptyDecisionChart(),
    [participants, series, from, to, hasTrace],
  );

  if (!hasTrace) {
    return (
      <div className="decision-strip decision-strip-unavailable">
        <p className="decision-strip-empty" role="status">旧对局没有决策遥测</p>
        <DecisionLegend />
      </div>
    );
  }
  if (chart.rows.length === 0 || chart.tickCount === 0) {
    return <div className="decision-strip decision-strip-empty" role="status">暂无可展示的决策条带</div>;
  }

  const displayedCurrentTick = clampTick(currentTick, from, to);
  const activeTick = hover === null ? null : clampTick(hover.tick, from, to);
  const activeParticipant = hover === null ? undefined : participants.find((item) => item.slot === hover.slot);
  const activeSeries = activeParticipant === undefined ? undefined : series.find((item) => item.slot === activeParticipant.slot);
  const activeDecision = activeTick === null ? null : decisionAt(activeSeries, activeTick - from);
  const activeRow = activeParticipant === undefined ? undefined : chart.rows.find((row) => row.slot === activeParticipant.slot);
  const currentX = tickX(displayedCurrentTick, from, to);
  const hoverX = activeTick === null ? null : tickX(activeTick, from, to);
  const plotBottom = chart.height - BOTTOM_SPACE;

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

  const currentDescription = activeTick !== null && activeParticipant
    ? `第 ${activeTick} 拍，${activeParticipant.name}，${decisionLabel(activeDecision)}`
    : `第 ${displayedCurrentTick} 拍`;

  return (
    <div className="decision-strip">
      <svg
        className="decision-strip-svg"
        width="100%"
        viewBox={`0 0 ${VIEW_WIDTH} ${chart.height}`}
        role="slider"
        tabIndex={0}
        aria-label="决策条带，左右键逐拍，回车或空格跳转"
        aria-valuemin={from}
        aria-valuemax={to}
        aria-valuenow={displayedCurrentTick}
        aria-valuetext={currentDescription}
        aria-orientation="horizontal"
        onKeyDown={handleKeyDown}
        onPointerLeave={() => setHover(null)}
      >
        <title>各蛇逐拍决策结果</title>
        {chart.rows.map((row) => {
          const participant = participants.find((item) => item.slot === row.slot);
          if (!participant) return null;
          return (
            <g className={`decision-strip-row decision-strip-slot-${row.slot}`} key={row.slot}>
              <rect x={4} y={row.y} width={4} height={ROW_HEIGHT} fill={participant.color} />
              <text x={16} y={row.y + ROW_HEIGHT / 2} dominantBaseline="middle" fill="currentColor" fontSize={11}>
                {participant.name} · #{participant.slot}
              </text>
              <rect x={PLOT_LEFT} y={row.y} width={PLOT_WIDTH} height={ROW_HEIGHT} fill="#14120f" />
              {row.paths.map((path) => (
                <path
                  className={`decision-strip-code-${path.code ?? 'null'}`}
                  key={path.code ?? 'null'}
                  d={path.d}
                  fill={path.color}
                  shapeRendering="crispEdges"
                />
              ))}
              <rect
                className="decision-strip-hit-area"
                x={PLOT_LEFT}
                y={row.y}
                width={PLOT_WIDTH}
                height={ROW_HEIGHT}
                fill="transparent"
                onPointerMove={(event) => setHover({ tick: pointerTick(event, from, to), slot: row.slot })}
                onClick={(event) => onSeek(pointerTick(event, from, to))}
              />
            </g>
          );
        })}
        {chart.xTicks.map((tick) => (
          <text
            className="decision-strip-x-tick"
            key={tick}
            x={tickX(tick, from, to)}
            y={chart.height - 5}
            textAnchor={tick === from ? 'start' : tick === to ? 'end' : 'middle'}
            fill="currentColor"
            fontSize={10}
          >
            #{tick}
          </text>
        ))}
        {hoverX !== null && activeRow && (
          <line
            className="decision-strip-hover-line"
            x1={hoverX}
            x2={hoverX}
            y1={activeRow.y}
            y2={activeRow.y + ROW_HEIGHT}
            stroke="currentColor"
            strokeOpacity={0.65}
            pointerEvents="none"
          />
        )}
        <line
          className="decision-strip-current"
          x1={currentX}
          x2={currentX}
          y1={2}
          y2={plotBottom}
          stroke="currentColor"
          strokeWidth={1.25}
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
        />
      </svg>
      <DecisionLegend />
      <div className="decision-strip-readout">
        {activeTick !== null && activeParticipant ? (
          <span><strong>第 {activeTick} 拍</strong> · {activeParticipant.name} · {decisionLabel(activeDecision)}</span>
        ) : <span className="decision-strip-hint">悬停查看蛇与决策结果，点击跳拍</span>}
      </div>
    </div>
  );
}

function DecisionLegend() {
  return (
    <div className="decision-strip-legend" aria-label="决策结果图例">
      {DECISION_META.map((item) => (
        <span className="decision-strip-legend-item" key={item.code ?? 'null'}>
          <i style={{ backgroundColor: item.color }} aria-hidden="true" />
          {item.label}
        </span>
      ))}
    </div>
  );
}

function buildDecisionChart(
  participants: Array<{ slot: number; name: string; color: string }>,
  series: ReviewSeries[],
  from: number,
  to: number,
): DecisionChart {
  const tickCount = validTickCount(from, to);
  if (tickCount === 0 || participants.length === 0) return emptyDecisionChart();
  const cellWidth = PLOT_WIDTH / tickCount;
  const rows = participants.map((participant, rowIndex) => {
    const trace = series.find((item) => item.slot === participant.slot);
    const commands = new Map<DecisionCode | null, string[]>();
    for (const item of DECISION_META) commands.set(item.code, []);
    const y = ROW_TOP + rowIndex * ROW_STEP;
    for (let index = 0; index < tickCount; index += 1) {
      const decision = decisionAt(trace, index);
      const x = PLOT_LEFT + index * cellWidth;
      const rectangle = `M${coordinate(x)} ${coordinate(y)}h${coordinate(cellWidth)}v${ROW_HEIGHT}h-${coordinate(cellWidth)}z`;
      const bucket = commands.get(decision);
      if (bucket) bucket.push(rectangle);
    }
    const paths = DECISION_META.flatMap((item) => {
      const bucket = commands.get(item.code);
      return bucket && bucket.length > 0 ? [{ code: item.code, color: item.color, d: bucket.join('') }] : [];
    });
    return { slot: participant.slot, y, paths };
  });
  const height = ROW_TOP + participants.length * ROW_HEIGHT + (participants.length - 1) * ROW_GAP + BOTTOM_SPACE;
  const middle = Math.round((from + to) / 2);
  const xTicks = from === to ? [from] : middle === from || middle === to ? [from, to] : [from, middle, to];
  return { rows, height, tickCount, xTicks };
}

function emptyDecisionChart(): DecisionChart {
  return { rows: [], height: 0, tickCount: 0, xTicks: [] };
}

function decisionAt(trace: ReviewSeries | undefined, index: number): DecisionCode | null {
  if (!trace || index < 0 || index >= trace.decision.length) return null;
  return trace.decision[index] ?? null;
}

function decisionLabel(decision: DecisionCode | null): string {
  return DECISION_META.find((item) => item.code === decision)?.label ?? '无数据';
}

function validTickCount(from: number, to: number): number {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return 0;
  return Math.floor(to - from) + 1;
}

function clampTick(tick: number, from: number, to: number): number {
  return Math.max(from, Math.min(to, Math.round(tick)));
}

function tickX(tick: number, from: number, to: number): number {
  const tickCount = validTickCount(from, to);
  if (tickCount <= 1) return PLOT_LEFT + PLOT_WIDTH / 2;
  return PLOT_LEFT + ((tick - from + 0.5) / tickCount) * PLOT_WIDTH;
}

function pointerTick(event: PointerPosition, from: number, to: number): number {
  const bounds = event.currentTarget.getBoundingClientRect();
  const tickCount = validTickCount(from, to);
  if (bounds.width <= 0 || tickCount === 0) return clampTick(from, from, to);
  const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
  const index = Math.min(tickCount - 1, Math.floor(ratio * tickCount));
  return clampTick(from + index, from, to);
}

function coordinate(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}
