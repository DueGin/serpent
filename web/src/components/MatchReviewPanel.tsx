import { useMemo } from 'react';
import type { MatchReviewDTO, ReviewTick } from '../types';
import { formatNumber } from '../utils';
import { DecisionStrip } from './DecisionStrip';
import { LineChart, type LineChartSeries } from './LineChart';
import { ReviewDeathCard } from './ReviewDeathCard';
import { ReviewMoments } from './ReviewMoments';
import { ReviewOptionsTable } from './ReviewOptionsTable';
import { DECISION_LABEL, DIRECTION_LABEL, seriesValue } from './reviewLabels';

interface MatchReviewPanelProps {
  review: MatchReviewDTO;
  currentTick: number;
  selectedSlot: number;
  onSelectSlot: (slot: number) => void;
  onSeek: (tick: number) => void;
  paused: boolean;
  frameReview: ReviewTick | null;
  frameLoading: boolean;
  frameError: string;
}

export function MatchReviewPanel(props: MatchReviewPanelProps) {
  const { review, currentTick, selectedSlot, onSelectSlot, onSeek, paused, frameReview, frameLoading, frameError } = props;
  const range = review.seriesRange ?? { from: 0, to: review.ticks };
  const series = review.series ?? [];
  const selectedParticipant = review.participants.find((item) => item.slot === selectedSlot) ?? review.participants[0] ?? null;
  const selectedSeries = series.find((item) => item.slot === selectedParticipant?.slot) ?? null;
  const currentIndex = currentTick - range.from;
  const charts = useMemo(() => {
    const score: LineChartSeries[] = [];
    const length: LineChartSeries[] = [];
    const space: LineChartSeries[] = [];
    for (const participant of review.participants) {
      const values = series.find((item) => item.slot === participant.slot);
      if (!values) continue;
      score.push({ id: `${participant.slot}-score`, label: participant.name, color: participant.color, values: values.score });
      length.push({ id: `${participant.slot}-length`, label: participant.name, color: participant.color, values: values.length });
      space.push({ id: `${participant.slot}-space`, label: `${participant.name} · 空间`, color: participant.color, values: values.space });
      space.push({ id: `${participant.slot}-body`, label: `${participant.name} · 身长参考`, color: participant.color, values: values.length, dashed: true });
    }
    return { score, length, space };
  }, [review, series]);

  const space = selectedSeries ? seriesValue(selectedSeries.space, currentIndex) : undefined;
  const safeMoves = selectedSeries ? seriesValue(selectedSeries.safeMoves, currentIndex) : undefined;
  const foodDist = selectedSeries ? seriesValue(selectedSeries.foodDist, currentIndex) : undefined;
  const decision = selectedSeries ? seriesValue(selectedSeries.decision, currentIndex) : undefined;
  const moveMs = selectedSeries ? seriesValue(selectedSeries.moveMs, currentIndex) : undefined;
  const move = selectedSeries ? seriesValue(selectedSeries.move, currentIndex) : undefined;
  const deaths = review.participants.filter((participant) => participant.death !== null);

  return (
    <section className="review-panel" aria-label="对局复盘">
      <header className="review-header">
        <div><div className="eyebrow">对局复盘</div><h2>逐拍复盘</h2><p>点击图表、关键时刻或日志跳拍；播放器会同时暂停。</p></div>
        <span className={`pill ${review.hasTrace ? 'valid' : ''}`}>{review.hasTrace ? '决策遥测完整' : '旧对局 · 无决策遥测'}</span>
      </header>

      <div className="review-player-tabs" role="group" aria-label="选择要检查的蛇">
        {review.participants.map((participant) => (
          <button
            className={selectedParticipant?.slot === participant.slot ? 'active' : ''}
            key={participant.slot}
            onClick={() => onSelectSlot(participant.slot)}
            aria-pressed={selectedParticipant?.slot === participant.slot}
          >
            <span className="review-player-dot" style={{ background: participant.color }} />
            <span>{participant.name}</span>
            <small>槽位 {participant.slot}</small>
          </button>
        ))}
      </div>

      <div className="review-chart-grid">
        <section className="panel review-chart-card">
          <div className="review-section-heading"><h3>分数</h3><span>每拍得分</span></div>
          <LineChart title="各蛇每拍分数" from={range.from} to={range.to} series={charts.score} currentTick={currentTick} onSeek={onSeek} formatValue={formatChartValue} />
        </section>
        <section className="panel review-chart-card">
          <div className="review-section-heading"><h3>身长</h3><span>每拍身体长度</span></div>
          <LineChart title="各蛇每拍身长" from={range.from} to={range.to} series={charts.length} currentTick={currentTick} onSeek={onSeek} formatValue={formatChartValue} />
        </section>
        <section className="panel review-chart-card review-space-chart">
          <div className="review-section-heading"><h3>可达空间</h3><span>实线为空间 · 虚线为身长参考</span></div>
          <LineChart title="各蛇可达空间与身长参考" from={range.from} to={range.to} series={charts.space} currentTick={currentTick} onSeek={onSeek} formatValue={formatChartValue} />
        </section>
      </div>

      <section className="panel review-decisions">
        <div className="review-section-heading"><div><h3>决策条带</h3><p>每格一拍；悬停查看结果码，点击定位。</p></div><span>第 {range.from}–{range.to} 拍</span></div>
        <DecisionStrip participants={review.participants} series={series} from={range.from} to={range.to} currentTick={currentTick} hasTrace={review.hasTrace} onSeek={onSeek} />
      </section>

      <div className="review-analysis-grid">
        <section className="panel review-inspector">
          <div className="review-section-heading">
            <div><div className="eyebrow">当前拍</div><h3>当前拍检查器</h3></div>
            <span>#{currentTick} · {selectedParticipant?.name ?? '未选择'}</span>
          </div>
          <dl className="review-metrics">
            <div><dt>可达空间</dt><dd>{formatNumber(space)}</dd></div>
            <div><dt>安全方向</dt><dd>{formatNumber(safeMoves)}</dd></div>
            <div><dt>食物距离</dt><dd>{foodDist === null ? '不可达' : formatNumber(foodDist)}</dd></div>
            <div><dt>决策</dt><dd>{decision ? DECISION_LABEL[decision] : '—'}</dd></div>
            <div><dt>耗时</dt><dd>{moveMs === null || moveMs === undefined ? '—' : `${formatNumber(moveMs, 2)} ms`}</dd></div>
            <div><dt>实际移动</dt><dd>{move ? `${DIRECTION_LABEL[move]} · ${move}` : '—'}</dd></div>
          </dl>
          <h4>候选方向反事实</h4>
          {!paused ? <p className="hint">播放中不请求候选方向；暂停后自动显示，并在主棋盘标出安全格、致死格和实际选择。</p>
            : frameLoading ? <p className="hint" role="status">正在读取第 {currentTick} 拍候选方向…</p>
            : frameError ? <div className="form-error" role="alert">候选方向加载失败：{frameError}</div>
            : frameReview ? <ReviewOptionsTable options={frameReview.options} />
            : <p className="hint">本拍没有可分析的决策轮。</p>}
        </section>

        <ReviewMoments moments={review.moments} participants={review.participants} onSeek={onSeek} />
      </div>

      <section className="panel review-deaths">
        <div className="review-section-heading"><div><div className="eyebrow">归因分析</div><h3>死亡归因</h3></div><span>{deaths.length} 条记录</span></div>
        {deaths.length === 0 ? <p className="hint">本场没有死亡记录。</p> : (
          <div className="review-death-list">
            {review.participants.map((participant) => <ReviewDeathCard key={participant.slot} participant={participant} participants={review.participants} onSeek={onSeek} />)}
          </div>
        )}
      </section>

      <section className="panel review-advice">
        <div className="eyebrow">下一轮迭代</div><h3>改进建议</h3>
        {review.advice.length === 0 ? <p className="hint">这场对局没有生成额外建议。</p> : (
          <ol>{review.advice.map((advice, index) => <li key={`${index}-${advice}`}>{advice}</li>)}</ol>
        )}
      </section>
    </section>
  );
}

function formatChartValue(value: number): string {
  return formatNumber(value);
}
