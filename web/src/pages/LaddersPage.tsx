import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listLadders } from '../api';
import { RulesetNotice } from '../components/RulesetNotice';
import type { LadderDTO } from '../types';
import { errorMessage, formatNumber, MODE_LABEL } from '../utils';

const KIND_LABEL: Record<LadderDTO['kind'], string> = {
  solo: '单人基准',
  individual: '个人竞技',
  team: '团队竞技',
};

export function LaddersPage() {
  const [ladders, setLadders] = useState<LadderDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    listLadders()
      .then((result) => { if (active) setLadders(result.data); })
      .catch((err) => { if (active) setError(errorMessage(err)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision]);

  return (
    <div className="shell">
      <header className="page-head">
        <div>
          <p className="eyebrow">蛇场天梯</p>
          <h1>天梯排行</h1>
          <p>让脚本持续参赛，用真实对局提升评分。团队天梯以整支队伍计算成绩。</p>
        </div>
        <div className="page-actions">
          <Link className="btn ghost" to="/teams">浏览团队</Link>
        </div>
      </header>
      <RulesetNotice season />

      {loading && <p className="panel hint" role="status">正在加载天梯…</p>}
      {!loading && error && (
        <div className="panel error-state" role="alert">
          <p>{error}</p>
          <button className="btn ghost" type="button" onClick={() => setRevision((value) => value + 1)}>重新加载</button>
        </div>
      )}
      {!loading && !error && ladders.length === 0 && <p className="panel hint empty-state">暂时没有开放的天梯。</p>}

      {!loading && !error && ladders.length > 0 && (
        <div className="ladder-grid">
          {ladders.map((ladder) => (
            <section className="panel ladder-card" key={ladder.slug}>
              <div className="section-head">
                <div>
                  <span className="pill">{KIND_LABEL[ladder.kind]}</span>
                  <h2><Link to={`/ladders/${ladder.slug}`}>{ladder.name}</Link></h2>
                </div>
                <span className="hint">{MODE_LABEL[ladder.mode]}</span>
              </div>
              <p>{ladder.description || '暂无天梯说明。'}</p>
              <div className="stat-row">
                <span><strong>{formatNumber(ladder.entrants)}</strong> 入场者</span>
                <span><strong>{formatNumber(ladder.matches)}</strong> 场对局</span>
                <span><strong>{formatNumber(ladder.playersPerMatch)}</strong> 人 / 场</span>
              </div>
              <div className="ladder-top">
                <h3>当前前三</h3>
                {ladder.top.length === 0 && <p className="hint">还没有排名，等待首位挑战者。</p>}
                {ladder.top.slice(0, 3).map((row) => (
                  <div className="score-line" key={row.entryId}>
                    <span>#{row.rank} {row.name}</span>
                    <strong>{formatNumber(row.rating)}</strong>
                  </div>
                ))}
              </div>
              <Link className="btn" to={`/ladders/${ladder.slug}`}>查看排行榜</Link>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
