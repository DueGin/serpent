import { useState } from 'react';
import { Link } from 'react-router-dom';
import { getScriptTrend } from '../api';
import { useAsync } from '../hooks';
import type { DeathReason, GameMode, ScriptTrendVersion } from '../types';
import { DEATH_LABEL, KIND_LABEL, MODE_LABEL, formatDate, formatNumber, formatPercent } from '../utils';
import { Sparkline } from './Sparkline';
import { EmptyState, ErrorState, Loading } from './StateView';

type TrendMode = GameMode | 'all';

const MODE_OPTIONS: Array<{ value: TrendMode; label: string }> = [
  { value: 'all', label: '全部模式' },
  { value: 'solo', label: MODE_LABEL.solo },
  { value: 'score', label: MODE_LABEL.score },
  { value: 'battle', label: MODE_LABEL.battle },
];

const DEATH_REASONS: DeathReason[] = ['wall', 'self', 'snake', 'head', 'disqualified'];

function formatDeathReasons(reasons: ScriptTrendVersion['deathReasons']): string {
  const items = DEATH_REASONS.flatMap((reason) => {
    const count = reasons[reason] ?? 0;
    return count > 0 ? [`${DEATH_LABEL[reason]} ${formatNumber(count)}`] : [];
  });
  return items.length > 0 ? items.join('、') : '—';
}

export function ScriptTrendPanel({ scriptId }: { scriptId: number }) {
  const [mode, setMode] = useState<TrendMode>('all');
  const { data, loading, error, reload } = useAsync(
    () => getScriptTrend(scriptId, { mode: mode === 'all' ? undefined : mode, limit: 50 }),
    [scriptId, mode],
  );

  const recent = data?.recent.slice().sort((a, b) => a.createdAt - b.createdAt || a.matchId - b.matchId) ?? [];
  const hasData = Boolean(data && (data.versions.length > 0 || data.recent.length > 0));

  return (
    <section className="trend-panel">
      <div className="trend-header">
        <div className="trend-heading">
          <div className="trend-eyebrow">跨局表现</div>
          <h2 className="trend-title">跨局趋势</h2>
        </div>
        <div className="trend-mode-options" aria-label="趋势模式筛选">
          {MODE_OPTIONS.map((option) => (
            <button
              type="button"
              key={option.value}
              className={mode === option.value ? 'trend-mode-option trend-mode-option-active' : 'trend-mode-option'}
              aria-pressed={mode === option.value}
              onClick={() => setMode(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? <Loading label="读取跨局趋势…" /> : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : !data || !hasData ? (
        <EmptyState title="暂无跨局对局数据">完成测试赛、表演赛或天梯赛后，这里会显示版本表现与最近走势。</EmptyState>
      ) : (
        <div className="trend-content">
          <section className="trend-versions">
            <div className="trend-section-header">
              <h3 className="trend-section-title">按版本汇总</h3>
              <span className="trend-section-meta">最多展示最近 50 场</span>
            </div>
            {data.versions.length > 0 ? (
              <div className="trend-table-wrap">
                <table className="trend-table">
                  <thead>
                    <tr>
                      <th>版本</th>
                      <th>场次</th>
                      <th>胜率</th>
                      <th>平均名次</th>
                      <th>平均分</th>
                      <th>存活率</th>
                      <th>死因分布</th>
                      <th>超时率</th>
                      <th>报错率</th>
                      <th>非法率</th>
                      <th>平均耗时</th>
                      <th>最大耗时</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.versions.map((version) => (
                      <tr key={version.version}>
                        <td><strong className="trend-version">v{version.version}</strong></td>
                        <td>{formatNumber(version.matches)}</td>
                        <td>{formatPercent(version.winRate)}</td>
                        <td>{formatNumber(version.avgRank, 2)}</td>
                        <td>{formatNumber(version.avgScore, 1)}</td>
                        <td>{formatPercent(version.survivalRate)}</td>
                        <td className="trend-death-reasons">{formatDeathReasons(version.deathReasons)}</td>
                        <td>{formatPercent(version.timeoutRate)}</td>
                        <td>{formatPercent(version.errorRate)}</td>
                        <td>{formatPercent(version.invalidRate)}</td>
                        <td>{formatNumber(version.avgMoveMs, 2)} ms</td>
                        <td>{formatNumber(version.maxMoveMs, 2)} ms</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <EmptyState title="暂无版本汇总" />}
          </section>

          <section className="trend-recent">
            <div className="trend-section-header">
              <h3 className="trend-section-title">最近对局</h3>
              <span className="trend-section-meta">{recent.length} 场</span>
            </div>
            {recent.length > 0 ? (
              <>
                <p className="trend-chart-help">按对局创建时间升序；名次保持原始数值，越低越好。</p>
                <div className="trend-charts">
                  <div className="trend-chart">
                    <div className="trend-chart-header">
                      <h4 className="trend-chart-title">分数走势</h4>
                    </div>
                    <Sparkline
                      values={recent.map((match) => match.score)}
                      label="最近对局分数走势"
                      color="#e8c547"
                      formatValue={(value: number) => formatNumber(value)}
                    />
                  </div>
                  <div className="trend-chart">
                    <div className="trend-chart-header">
                      <h4 className="trend-chart-title">名次走势</h4>
                      <span className="trend-chart-note">越低越好</span>
                    </div>
                    <Sparkline
                      values={recent.map((match) => match.rank)}
                      label="最近对局名次走势，越低越好"
                      color="#4ea3f0"
                      formatValue={(value: number) => formatNumber(value)}
                    />
                  </div>
                </div>
                <div className="trend-match-list">
                  {recent.slice().reverse().map((match) => (
                    <Link className="trend-match-link" to={`/matches/${match.matchId}`} key={match.matchId}>
                      <span className="trend-match-primary">
                        <strong className="trend-match-mode">{MODE_LABEL[match.mode]}</strong>
                        <span className="trend-match-kind">{KIND_LABEL[match.kind]}{match.teams ? ' · 2v2' : ''}</span>
                      </span>
                      <span className="trend-match-version">{match.version === null ? '版本 —' : `v${match.version}`}</span>
                      <span className="trend-match-rank">{match.rank === null ? '名次 —' : `第 ${formatNumber(match.rank)} 名`}</span>
                      <span className="trend-match-score">{formatNumber(match.score)} 分</span>
                      <time className="trend-match-time">{formatDate(match.createdAt)}</time>
                    </Link>
                  ))}
                </div>
              </>
            ) : <EmptyState title="暂无最近对局" />}
          </section>
        </div>
      )}
    </section>
  );
}
