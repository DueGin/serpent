import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  getLadder,
  getLeaderboard,
  getMyLadderEntries,
  joinLadder,
  leaveLadder,
  listAgents,
  listMatches,
  listPublicScripts,
  listScripts,
  listTeams,
  queueLadderMatch,
  updateLadderEntry,
} from '../api';
import { useAuth } from '../auth';
import { MatchList } from '../components/MatchList';
import type {
  AgentDTO,
  LadderDTO,
  LadderEntryDTO,
  LeaderboardRow,
  MatchSummaryDTO,
  ScriptSummaryDTO,
  TeamDTO,
} from '../types';
import { errorMessage, formatDate, formatNumber, formatPercent, MODE_LABEL } from '../utils';

type LineupValue = [string, string];
type EntryPatch = { scriptId?: number; lineup?: [number, number] };

function eligibleTeamScripts(team: TeamDTO | undefined, scripts: ScriptSummaryDTO[]): ScriptSummaryDTO[] {
  const memberIds = new Set(team?.members.map((member) => member.agentId) ?? []);
  return scripts.filter((script) => memberIds.has(script.agentId) && !script.archived && script.activeVersion !== null);
}

function normalizeLineup(candidates: ScriptSummaryDTO[], value?: Array<number | string>): LineupValue {
  const selected: ScriptSummaryDTO[] = [];
  const add = (script: ScriptSummaryDTO | undefined) => {
    if (script && selected.length < 2 && !selected.some((item) => item.agentId === script.agentId)) selected.push(script);
  };
  value?.forEach((id) => add(candidates.find((script) => script.id === Number(id))));
  candidates.forEach(add);
  return [selected[0] ? String(selected[0].id) : '', selected[1] ? String(selected[1].id) : ''];
}

function isLineupValid(candidates: ScriptSummaryDTO[], value: LineupValue): boolean {
  const first = candidates.find((script) => script.id === Number(value[0]));
  const second = candidates.find((script) => script.id === Number(value[1]));
  return !!first && !!second && first.id !== second.id && first.agentId !== second.agentId;
}

function LineupSelects({ scripts, value, onChange, disabled }: {
  scripts: ScriptSummaryDTO[];
  value: LineupValue;
  onChange: (value: LineupValue) => void;
  disabled?: boolean;
}) {
  return (
    <div className="form-grid lineup-fields">
      {[0, 1].map((index) => (
        <label key={index}>
          {index === 0 ? '一号位脚本' : '二号位脚本'}
          <select
            value={value[index]}
            disabled={disabled}
            onChange={(event) => {
              const next: LineupValue = [...value] as LineupValue;
              next[index] = event.target.value;
              onChange(next);
            }}
          >
            <option value="">请选择脚本</option>
            {scripts.map((script) => (
              <option key={script.id} value={script.id}>{script.name} · {script.agentName}（v{script.activeVersion}）</option>
            ))}
          </select>
        </label>
      ))}
    </div>
  );
}

function EntryCard({ entry, scripts, teams, canManage, busy, onUpdate, onToggle, onQueue, onLeave }: {
  entry: LadderEntryDTO;
  scripts: ScriptSummaryDTO[];
  teams: TeamDTO[];
  canManage: boolean;
  busy: boolean;
  onUpdate: (patch: EntryPatch) => void;
  onToggle: () => void;
  onQueue: () => void;
  onLeave: () => void;
}) {
  const isTeam = entry.entrantType === 'team';
  const team = teams.find((item) => item.id === entry.teamId);
  const candidates = isTeam ? eligibleTeamScripts(team, scripts) : [];
  const [scriptId, setScriptId] = useState(String(entry.scriptId ?? ''));
  const [lineup, setLineup] = useState<LineupValue>(() => normalizeLineup(candidates, entry.lineup));
  const lineupValid = isLineupValid(candidates, lineup);
  const script = scripts.find((item) => item.id === Number(scriptId));

  return (
    <article className="entry-card">
      <div className="section-head">
        <div>
          <span className={`pill ${entry.active ? 'live' : ''}`}>{entry.active ? '参赛中' : '已暂停'}</span>
          <h3>{entry.name}</h3>
        </div>
        <span className="hint">#{entry.rank ?? '—'} · {formatNumber(entry.rating)} 分 · {entry.games} 局</span>
      </div>
      {isTeam ? (
        canManage ? (
          <>
            {!team && <p className="flash">无法读取队伍成员，暂时不能调整阵容。</p>}
            <LineupSelects scripts={candidates} value={lineup} onChange={setLineup} disabled={busy || !team} />
            {!lineupValid && <p className="hint">阵容需要两名不同团队成员的有效脚本；队友的私有脚本需由其设为公开后才会出现在这里。</p>}
            <div className="form-actions">
              <button
                className="btn"
                type="button"
                disabled={busy || !team || !lineupValid}
                onClick={() => onUpdate({ lineup: [Number(lineup[0]), Number(lineup[1])] })}
              >保存阵容</button>
            </div>
          </>
        ) : (
          <p className="hint">当前阵容：{entry.lineup?.map((id) => {
            const selected = scripts.find((item) => item.id === id);
            return selected ? `${selected.name} · ${selected.agentName}` : `脚本 #${id}`;
          }).join(' / ') || '尚未设置'}。仅队长可修改。</p>
        )
      ) : (
        <div className="form-grid">
          <label>
            参赛脚本
            <select value={scriptId} disabled={busy} onChange={(event) => setScriptId(event.target.value)}>
              <option value="">请选择脚本</option>
              {scripts.filter((item) => !item.archived).map((item) => (
                <option key={item.id} value={item.id} disabled={item.activeVersion === null && item.id !== entry.scriptId}>
                  {item.name} · {item.agentName}{item.activeVersion === null ? '（未启用版本）' : `（v${item.activeVersion}）`}
                </option>
              ))}
            </select>
          </label>
          <div className="form-actions">
            <button
              className="btn"
              type="button"
              disabled={busy || !script || script.activeVersion === null}
              onClick={() => onUpdate({ scriptId: Number(scriptId) })}
            >更新脚本</button>
          </div>
        </div>
      )}
      {canManage && <div className="toolbar">
        <button className="btn mint" type="button" disabled={busy || !entry.active} onClick={onQueue}>手动排队</button>
        <button className="btn ghost" type="button" disabled={busy} onClick={onToggle}>{entry.active ? '暂停匹配' : '恢复匹配'}</button>
        <button className="btn danger" type="button" disabled={busy} onClick={onLeave}>退出天梯</button>
      </div>}
    </article>
  );
}

export function LadderDetailPage() {
  const { slug = '' } = useParams();
  const { user, ready } = useAuth();
  const [ladder, setLadder] = useState<LadderDTO | null>(null);
  const [matches, setMatches] = useState<MatchSummaryDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [by, setBy] = useState<'entry' | 'agent'>('entry');
  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [boardLoading, setBoardLoading] = useState(true);
  const [boardError, setBoardError] = useState('');
  const [entries, setEntries] = useState<LadderEntryDTO[]>([]);
  const [scripts, setScripts] = useState<ScriptSummaryDTO[]>([]);
  const [teams, setTeams] = useState<TeamDTO[]>([]);
  const [agents, setAgents] = useState<AgentDTO[]>([]);
  const [ownLoading, setOwnLoading] = useState(false);
  const [ownError, setOwnError] = useState('');
  const [joinScriptId, setJoinScriptId] = useState('');
  const [joinTeamId, setJoinTeamId] = useState('');
  const [joinLineup, setJoinLineup] = useState<LineupValue>(['', '']);
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      Promise.all([getLadder(slug), listMatches({ ladder: slug, limit: 20 }), getLeaderboard(slug, by)])
        .then(([ladderResult, matchResult, boardResult]) => {
          if (!active) return;
          setLadder(ladderResult);
          setMatches(matchResult.data);
          setRows(boardResult.data);
        })
        .catch(() => {});
    };
    const timer = window.setInterval(refresh, 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [slug, by]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setLadder(null);
    Promise.all([getLadder(slug), listMatches({ ladder: slug, limit: 20 })])
      .then(([ladderResult, matchResult]) => {
        if (!active) return;
        setLadder(ladderResult);
        setMatches(matchResult.data);
      })
      .catch((err) => { if (active) setError(errorMessage(err)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [slug, revision]);

  useEffect(() => {
    let active = true;
    setBoardLoading(true);
    setBoardError('');
    getLeaderboard(slug, by)
      .then((result) => { if (active) setRows(result.data); })
      .catch((err) => { if (active) setBoardError(errorMessage(err)); })
      .finally(() => { if (active) setBoardLoading(false); });
    return () => { active = false; };
  }, [slug, by, revision]);

  useEffect(() => {
    if (!ready) return;
    let active = true;
    if (!user || !ladder) {
      setEntries([]);
      setScripts([]);
      setTeams([]);
      setAgents([]);
      setOwnError('');
      return () => { active = false; };
    }
    setOwnLoading(true);
    setOwnError('');
    const mineRequest = getMyLadderEntries();
    if (ladder.kind === 'team') {
      Promise.all([mineRequest, listTeams(), listAgents(), listScripts(), listPublicScripts()])
        .then(([mine, teamResult, agentResult, scriptResult, publicResult]) => {
          if (!active) return;
          const ownIds = new Set(scriptResult.data.map((script) => script.id));
          setEntries(mine.data.filter((entry) => entry.ladderSlug === slug));
          setTeams(teamResult.data);
          setAgents(agentResult.data);
          setScripts([...scriptResult.data, ...publicResult.data.filter((script) => !ownIds.has(script.id))]);
        })
        .catch((err) => { if (active) setOwnError(errorMessage(err)); })
        .finally(() => { if (active) setOwnLoading(false); });
    } else {
      Promise.all([mineRequest, listScripts()])
        .then(([mine, scriptResult]) => {
          if (!active) return;
          setEntries(mine.data.filter((entry) => entry.ladderSlug === slug));
          setScripts(scriptResult.data);
        })
        .catch((err) => { if (active) setOwnError(errorMessage(err)); })
        .finally(() => { if (active) setOwnLoading(false); });
    }
    return () => { active = false; };
  }, [ready, user, ladder, slug, revision]);

  const ownAgentIds = new Set(agents.map((agent) => agent.id));
  const ownTeams = teams.filter((team) => ownAgentIds.has(team.captainAgentId));
  const joinTeam = ownTeams.find((team) => team.id === Number(joinTeamId));
  const joinCandidates = eligibleTeamScripts(joinTeam, scripts);
  const joinLineupValid = isLineupValid(joinCandidates, joinLineup);
  const availableScripts = scripts.filter((script) => !script.archived && script.activeVersion !== null);

  useEffect(() => {
    if (ladder?.kind === 'team') return;
    setJoinScriptId((current) => availableScripts.some((script) => String(script.id) === current)
      ? current
      : String(availableScripts[0]?.id ?? ''));
  }, [scripts, ladder?.kind]);

  useEffect(() => {
    if (ladder?.kind !== 'team') return;
    setJoinTeamId((current) => ownTeams.some((team) => String(team.id) === current)
      ? current
      : String(ownTeams[0]?.id ?? ''));
  }, [teams, agents, ladder?.kind]);

  useEffect(() => {
    if (ladder?.kind === 'team') setJoinLineup((current) => normalizeLineup(joinCandidates, current));
  }, [joinTeamId, teams, scripts, ladder?.kind]);

  async function mutate(key: string, action: () => Promise<unknown>, message: string) {
    setBusy(key);
    setActionError('');
    setNotice('');
    try {
      await action();
      setNotice(message);
      setRevision((value) => value + 1);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy('');
    }
  }

  function submitJoin(event: FormEvent) {
    event.preventDefault();
    if (!ladder) return;
    if (ladder.kind === 'team') {
      if (!joinTeam || !joinLineupValid) return;
      void mutate('join', () => joinLadder(slug, {
        teamId: joinTeam.id,
        lineup: [Number(joinLineup[0]), Number(joinLineup[1])],
      }), '队伍已入场，将按当前阵容参与匹配');
    } else {
      if (!joinScriptId) return;
      void mutate('join', () => joinLadder(slug, { scriptId: Number(joinScriptId) }), '脚本已入场');
    }
  }

  if (loading) return <div className="shell"><p className="panel hint" role="status">正在加载天梯详情…</p></div>;
  if (error || !ladder) {
    return (
      <div className="shell">
        <div className="panel error-state" role="alert">
          <p>{error || '天梯不存在。'}</p>
          <div className="toolbar"><Link className="btn ghost" to="/ladders">返回天梯</Link><button className="btn" onClick={() => setRevision((value) => value + 1)}>重试</button></div>
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <header className="page-head">
        <div>
          <Link className="back-link" to="/ladders">← 全部天梯</Link>
          <p className="eyebrow">{ladder.slug}</p>
          <h1>{ladder.name}</h1>
          <p>{ladder.description || `${MODE_LABEL[ladder.mode]}，每场 ${ladder.playersPerMatch} 位选手。`}</p>
        </div>
        <div className="stat-row">
          <span><strong>{ladder.entrants}</strong> 入场者</span>
          <span><strong>{ladder.matches}</strong> 场对局</span>
        </div>
      </header>

      <section className="panel">
        <div className="section-head">
          <h2>排行榜</h2>
          <div className="segmented" aria-label="排行榜维度">
            <button className={`btn ${by === 'entry' ? '' : 'ghost'}`} type="button" aria-pressed={by === 'entry'} onClick={() => setBy('entry')}>按入场</button>
            <button className={`btn ${by === 'agent' ? '' : 'ghost'}`} type="button" aria-pressed={by === 'agent'} onClick={() => setBy('agent')}>按 Agent</button>
          </div>
        </div>
        {boardLoading && <p className="hint" role="status">正在加载排行榜…</p>}
        {!boardLoading && boardError && <div className="error-state" role="alert"><p className="flash">{boardError}</p><button className="btn ghost" onClick={() => setRevision((value) => value + 1)}>重试</button></div>}
        {!boardLoading && !boardError && rows.length === 0 && <p className="hint empty-state">暂无排名，入场并完成一局后再来看看。</p>}
        {!boardLoading && !boardError && rows.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>排名</th><th>入场者</th><th>{ladder.kind === 'solo' ? '基准分' : '评分'}</th><th>对局</th><th>胜场</th><th>胜率</th><th>平均分</th><th>最近对局</th></tr></thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${by}-${row.entryId}-${row.agentId ?? 0}-${row.rank}`}>
                    <td>#{row.rank}</td>
                    <td>
                      {row.scriptId ? <Link to={`/scripts/${row.scriptId}`}>{row.name}</Link> : row.teamId ? <Link to={`/teams/${row.teamId}`}>{row.name}</Link> : row.agentId ? <Link to={`/agents/${row.agentId}`}>{row.name}</Link> : row.name}
                      <div className="hint">{row.teamName ? `团队 · ${row.teamName}` : row.agentName ? `Agent · ${row.agentName}` : row.entrantType === 'builtin' ? '内置 Bot' : ''}</div>
                    </td>
                    <td><strong>{formatNumber(row.rating)}</strong></td>
                    <td>{row.games}</td><td>{row.wins}</td><td>{formatPercent(row.winRate)}</td><td>{formatNumber(row.avgScore, 1)}</td><td>{formatDate(row.lastMatchAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="section-head"><h2>我的入场</h2>{user && <span className="hint">每个 Agent 每天梯最多 3 个入场</span>}</div>
        {!ready && <p className="hint">正在确认登录状态…</p>}
        {ready && !user && <div className="empty-state"><p className="hint">登录后可以让自己的脚本或队伍入场。</p><Link className="btn" to="/login">登录后参赛</Link></div>}
        {ready && user && ownLoading && <p className="hint" role="status">正在加载我的入场与参赛资源…</p>}
        {ready && user && !ownLoading && ownError && <div className="error-state" role="alert"><p className="flash">{ownError}</p><button className="btn ghost" onClick={() => setRevision((value) => value + 1)}>重新加载</button></div>}
        {ready && user && !ownLoading && !ownError && (
          <>
            <div className="entry-list">
              {entries.length === 0 && <p className="hint empty-state">你在这个天梯还没有入场者。</p>}
              {entries.map((entry) => (
                <EntryCard
                  key={`${entry.entryId}-${entry.scriptId ?? 0}-${entry.lineup?.join('-') ?? ''}`}
                  entry={entry}
                  scripts={scripts}
                  teams={teams}
                  canManage={entry.entrantType !== 'team' || ownAgentIds.has(teams.find((team) => team.id === entry.teamId)?.captainAgentId ?? -1)}
                  busy={busy === `entry-${entry.entryId}`}
                  onUpdate={(patch) => void mutate(`entry-${entry.entryId}`, () => updateLadderEntry(slug, entry.entryId, patch), '入场信息已更新')}
                  onToggle={() => void mutate(`entry-${entry.entryId}`, () => updateLadderEntry(slug, entry.entryId, { active: !entry.active }), entry.active ? '已暂停自动匹配' : '已恢复自动匹配')}
                  onQueue={() => void mutate(`entry-${entry.entryId}`, () => queueLadderMatch(slug, entry.entryId), '已加入匹配队列')}
                  onLeave={() => {
                    if (window.confirm(`确定让「${entry.name}」退出这个天梯吗？`)) {
                      void mutate(`entry-${entry.entryId}`, () => leaveLadder(slug, entry.entryId), '已退出天梯');
                    }
                  }}
                />
              ))}
            </div>

            <form className="join-entry" onSubmit={submitJoin}>
              <h3>新增入场</h3>
              {ladder.kind === 'team' ? (
                ownTeams.length === 0 ? <div className="empty-state"><p className="hint">你还没有可参赛的团队；团队天梯仅队长可以入场。</p><Link className="btn ghost" to="/teams">创建或加入团队</Link></div> : (
                  <>
                    <label>参赛团队
                      <select value={joinTeamId} onChange={(event) => setJoinTeamId(event.target.value)}>
                        {ownTeams.map((team) => <option key={team.id} value={team.id}>{team.name}{team.tag ? ` [${team.tag}]` : ''}</option>)}
                      </select>
                    </label>
                    <LineupSelects scripts={joinCandidates} value={joinLineup} onChange={setJoinLineup} disabled={busy === 'join'} />
                    {!joinLineupValid && <p className="hint">请选择两名不同团队成员的有效脚本；队友的私有脚本需由其设为公开后才会出现在这里。</p>}
                  </>
                )
              ) : (
                availableScripts.length === 0 ? <div className="empty-state"><p className="hint">没有已启用有效版本的脚本，请先创建并检测脚本。</p><Link className="btn ghost" to="/agents">管理 Agent 与脚本</Link></div> : (
                  <label>参赛脚本
                    <select value={joinScriptId} onChange={(event) => setJoinScriptId(event.target.value)}>
                      {availableScripts.map((script) => <option key={script.id} value={script.id}>{script.name} · {script.agentName}（v{script.activeVersion}）</option>)}
                    </select>
                  </label>
                )
              )}
              {actionError && <p className="flash" role="alert">{actionError}</p>}
              {notice && <p className="success-message" role="status">{notice}</p>}
              {((ladder.kind === 'team' && ownTeams.length > 0) || (ladder.kind !== 'team' && availableScripts.length > 0)) && (
                <button className="btn" disabled={busy === 'join' || (ladder.kind === 'team' ? !joinTeam || !joinLineupValid : !joinScriptId)}>
                  {busy === 'join' ? '正在入场…' : '确认入场'}
                </button>
              )}
            </form>
          </>
        )}
        {(ownLoading || ownError) && actionError && <p className="flash" role="alert">{actionError}</p>}
      </section>

      <section className="panel">
        <div className="section-head"><h2>近期对局</h2><span className="hint">最近 20 场</span></div>
        <MatchList matches={matches} empty="这个天梯还没有对局。" />
      </section>
    </div>
  );
}
