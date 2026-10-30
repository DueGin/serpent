import { useMemo, useState } from 'react';
import type { ReviewMoment, ReviewParticipant } from '../types';
import { MOMENT_LABEL } from './reviewLabels';

const SEVERITY_LABEL = { info: '信息', warn: '警告', critical: '严重' } as const;

interface ReviewMomentsProps {
  moments: ReviewMoment[];
  participants: ReviewParticipant[];
  onSeek: (tick: number) => void;
}

export function ReviewMoments({ moments, participants, onSeek }: ReviewMomentsProps) {
  const [slot, setSlot] = useState('all');
  const [severity, setSeverity] = useState('all');
  const filtered = useMemo(() => moments.filter((moment) => {
    const slotMatches = slot === 'all' || moment.slot === Number(slot);
    return slotMatches && (severity === 'all' || moment.severity === severity);
  }), [moments, slot, severity]);

  return (
    <section className="panel review-moments">
      <div className="review-section-heading">
        <div><div className="eyebrow">关键事件</div><h3>关键时刻</h3></div>
        <span>{filtered.length} / {moments.length}</span>
      </div>
      <div className="review-filters">
        <label>参赛者
          <select value={slot} onChange={(event) => setSlot(event.target.value)}>
            <option value="all">全部</option>
            {participants.map((participant) => <option key={participant.slot} value={participant.slot}>{participant.name}</option>)}
          </select>
        </label>
        <label>严重度
          <select value={severity} onChange={(event) => setSeverity(event.target.value)}>
            <option value="all">全部</option>
            <option value="critical">严重</option>
            <option value="warn">警告</option>
            <option value="info">信息</option>
          </select>
        </label>
      </div>
      {filtered.length === 0 ? <p className="hint">没有符合筛选条件的关键时刻。</p> : (
        <ol className="review-moment-list">
          {filtered.map((moment, index) => (
            <li key={`${moment.tick}-${moment.slot ?? 'all'}-${moment.kind}-${index}`}>
              <button onClick={() => onSeek(moment.tick)}>
                <span className="review-moment-tick">#{moment.tick}</span>
                <span className={`pill review-severity-${moment.severity}`}>{SEVERITY_LABEL[moment.severity]}</span>
                <span className="review-moment-kind">{MOMENT_LABEL[moment.kind]}</span>
                <span className="review-moment-message">{moment.message}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
