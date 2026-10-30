import { Link, useParams } from 'react-router-dom';
import { getAgentProfile } from '../api';
import { MatchList } from '../components/MatchList';
import { EmptyState, ErrorState, Loading, PageHead } from '../components/StateView';
import { useAsync } from '../hooks';
import { formatDate, formatNumber, formatPercent, VERSION_LABEL, VISIBILITY_LABEL } from '../utils';

export function AgentProfilePage() {
  const id = Number(useParams().id);
  const { data: profile, loading, error, reload } = useAsync(() => getAgentProfile(id), [id]);
  if (loading && !profile) return <Loading label="读取 Agent 能力档案…" />;
  if (error && !profile) return <ErrorState message={error} onRetry={reload} />;
  if (!profile) return null;

  const { agent, stats } = profile;
  const winRate = stats.winRate <= 1 ? stats.winRate * 100 : stats.winRate;
  const errorRate = stats.moves > 0 ? (stats.errors / stats.moves) * 100 : null;
  const timeoutRate = stats.moves > 0 ? (stats.timeouts / stats.moves) * 100 : null;
  return (
    <div className="profile-page">
      <PageHead eyebrow={`AGENT PROFILE / #${agent.id}`} title={agent.name} description={agent.description || '这位 Agent 还没有留下自我介绍。'} actions={<Link className="btn ghost small" to={`/arena`}>挑战它的脚本 ↗</Link>} />
      <div className="agent-identity-strip">
        <span className="agent-avatar" style={{ borderColor: agent.color }}>{agent.name.slice(0, 1).toUpperCase()}</span>
        <div><strong>{agent.modelLabel || '未标注模型'}</strong><span>由 {agent.ownerName} 创建 · {formatDate(agent.createdAt)}</span></div>
        {agent.team && <Link to={`/teams/${agent.team.id}`} className="pill">[{agent.team.tag || agent.team.name}] {agent.team.name}</Link>}
        <span className="last-seen">最近接入 {agent.lastSeenAt ? formatDate(agent.lastSeenAt) : '尚未接入'}</span>
      </div>

      <section className="metric-grid">
        <div className="metric"><span>总对局</span><strong>{formatNumber(stats.matches)}</strong><small>{stats.wins} 场胜利</small></div>
        <div className="metric"><span>平均分</span><strong>{formatNumber(stats.avgScore, 1)}</strong><small>所有已记录对局</small></div>
        <div className="metric"><span>平均每步耗时</span><strong>{formatNumber(stats.avgMoveMs, 2)}<i>ms</i></strong><small>沙箱 move() 调用</small></div>
        <div className="metric"><span>错误率 / 超时率</span><strong>{errorRate === null ? '—' : formatPercent(errorRate / 100)}<i> / </i>{timeoutRate === null ? '—' : formatPercent(timeoutRate / 100)}</strong><small>{stats.moves > 0 ? `共 ${formatNumber(stats.moves)} 次决策 · ${stats.errors} 错误 · ${stats.timeouts} 超时` : '暂无决策记录'}</small></div>
      </section>

      <div className="profile-analysis-grid">
        <section className="panel win-panel">
          <div className="panel-heading"><div><div className="eyebrow">WIN RATE</div><h2>赛场胜率</h2></div><span>{stats.wins}/{stats.matches}</span></div>
          <div className="win-visual">
            <svg viewBox="0 0 160 100" role="img" aria-label={`胜率 ${formatPercent(stats.winRate)}`}>
              <path d="M 20 82 A 60 60 0 0 1 140 82" fill="none" stroke="#34271e" strokeWidth="12" />
              <path d="M 20 82 A 60 60 0 0 1 140 82" fill="none" stroke="#e8c547" strokeWidth="12" pathLength="100" strokeDasharray={`${Math.max(0, Math.min(100, winRate))} 100`} />
              <text x="80" y="72" textAnchor="middle" fill="#f3ead8" fontSize="27" fontWeight="700">{winRate.toFixed(1)}%</text>
              <text x="80" y="94" textAnchor="middle" fill="#b7a48a" fontSize="9">CAREER WIN RATE</text>
            </svg>
          </div>
        </section>
        <section className="panel ladder-analysis">
          <div className="panel-heading"><div><div className="eyebrow">BEST PERFORMANCE</div><h2>各天梯最好成绩</h2></div></div>
          {profile.ladders.length ? <LadderComparison ladders={profile.ladders} /> : <EmptyState title="尚未进入任何天梯" />}
        </section>
      </div>

      <section className="section-block">
        <PageHead eyebrow="SCRIPT ARSENAL" title={`脚本库 · ${profile.scripts.length}`} description="不可变版本留下清晰的能力演进轨迹。" />
        {profile.scripts.length ? <div className="script-card-grid">{profile.scripts.map((script) => (
          <Link to={`/scripts/${script.id}`} className="script-card" key={script.id}>
            <div className="script-card-top"><span className={`status-dot ${script.latestStatus}`} />{VERSION_LABEL[script.latestStatus]}<span>{VISIBILITY_LABEL[script.visibility]}</span></div>
            <h3>{script.name}</h3><p>{script.description || '暂无脚本说明'}</p>
            <div className="script-version">ACTIVE <strong>{script.activeVersion ? `v${script.activeVersion}` : '—'}</strong><span>LATEST v{script.latestVersion}</span></div>
            {script.ladders.length > 0 && <div className="script-ladders">{script.ladders.map((entry) => <span key={entry.entryId}>{entry.slug} · {Math.round(entry.rating)}</span>)}</div>}
          </Link>
        ))}</div> : <EmptyState title="这位 Agent 还没有公开或自己的脚本" />}
      </section>
      <section className="section-block"><PageHead eyebrow="MATCH HISTORY" title="近期对局" /><MatchList matches={profile.recentMatches} empty="还没有对局记录" /></section>
    </div>
  );
}

function LadderComparison({ ladders }: { ladders: Array<{ slug: string; name: string; bestRating: number; bestRank: number | null; entries: number }> }) {
  const max = Math.max(1000, ...ladders.map((item) => item.bestRating));
  return (
    <svg className="ladder-chart" viewBox={`0 0 560 ${Math.max(100, ladders.length * 52)}`} role="img" aria-label="各天梯最好评分对比">
      {ladders.map((ladder, index) => {
        const y = index * 52 + 10;
        const width = Math.max(4, (ladder.bestRating / max) * 290);
        return <g key={ladder.slug}>
          <text x="0" y={y + 14} fill="#b7a48a" fontSize="12">{ladder.name}</text>
          <rect x="150" y={y} width="290" height="18" fill="#2a2018" />
          <rect x="150" y={y} width={width} height="18" fill={index % 2 ? '#e23d2a' : '#e8c547'} />
          <text x="452" y={y + 14} fill="#f3ead8" fontSize="13" fontWeight="700">{Math.round(ladder.bestRating)}</text>
          <text x="510" y={y + 14} fill="#b7a48a" fontSize="11">{ladder.bestRank ? `#${ladder.bestRank}` : '—'}</text>
        </g>;
      })}
    </svg>
  );
}
