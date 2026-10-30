import type { ReviewParticipant } from '../types';
import { DEATH_LABEL, formatNumber } from '../utils';
import { DIRECTION_LABEL } from './reviewLabels';
import { ReviewOptionsTable } from './ReviewOptionsTable';

interface ReviewDeathCardProps {
  participant: ReviewParticipant;
  participants: ReviewParticipant[];
  onSeek: (tick: number) => void;
}

export function ReviewDeathCard({ participant, participants, onSeek }: ReviewDeathCardProps) {
  const death = participant.death;
  if (!death) return null;
  const killer = death.killerSlot === null ? null : participants.find((item) => item.slot === death.killerSlot);
  return (
    <article className="review-death-card">
      <div className="review-death-heading">
        <div>
          <span className="review-player-dot" style={{ background: participant.color }} />
          <strong>{participant.name}</strong>
          <span>第 {death.tick} 拍 · {DEATH_LABEL[death.reason]}</span>
        </div>
        <button className="btn ghost small" onClick={() => onSeek(death.decisionTick)}>跳到决策拍 #{death.decisionTick}</button>
      </div>
      <div className="review-death-facts">
        <span>凶手 <b>{killer ? `${killer.name}（槽位 ${killer.slot}）` : '—'}</b></span>
        <span>安全替代 <b className={death.hadSafeAlternative ? 'is-safe-text' : ''}>{death.decision === null ? '无法判断' : death.hadSafeAlternative ? '有' : '没有'}</b></span>
        <span>被困起点 <b>{death.trappedSince === null ? '—' : `第 ${death.trappedSince} 拍`}</b></span>
      </div>
      {death.decision ? (
        <ReviewOptionsTable options={death.decision.options} />
      ) : (
        <p className="hint">这次死亡没有可复盘的 move 决策拍。</p>
      )}
      {death.lastTicks.length > 0 && (
        <details className="review-last-ticks">
          <summary>死亡前 {death.lastTicks.length} 拍指标</summary>
          <div>
            {death.lastTicks.map((item) => (
              <button key={item.tick} onClick={() => onSeek(item.tick)}>
                <span>#{item.tick}</span>
                <span>空间 {formatNumber(item.space)}</span>
                <span>安全方向 {item.safeMoves}</span>
                <span>{item.move ? DIRECTION_LABEL[item.move] : '无移动'}</span>
              </button>
            ))}
          </div>
        </details>
      )}
    </article>
  );
}
