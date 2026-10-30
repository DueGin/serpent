import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  getTeam,
  kickTeamMember,
  leaveTeam,
  listAgents,
  listMatches,
  listPublicScripts,
  listScripts,
  rotateTeamInvite,
  updateLadderEntry,
} from '../api';
import { useAuth } from '../auth';
import { MatchList } from '../components/MatchList';
import type { AgentDTO, LadderEntryDTO, MatchSummaryDTO, ScriptSummaryDTO, TeamDTO } from '../types';
import { copyText, errorMessage, formatDate, formatNumber } from '../utils';

type LineupValue = [string, string];

function eligibleTeamScripts(team: TeamDTO, scripts: ScriptSummaryDTO[]): ScriptSummaryDTO[] {
  const memberIds = new Set(team.members.map((member) => member.agentId));
  return scripts.filter((script) => memberIds.has(script.agentId) && !script.archived && script.activeVersion !== null);
}

function normalizeLineup(candidates: ScriptSummaryDTO[], entry: LadderEntryDTO): LineupValue {
  const selected: ScriptSummaryDTO[] = [];
  const add = (script: ScriptSummaryDTO | undefined) => {
    if (script && selected.length < 2 && !selected.some((item) => item.agentId === script.agentId)) selected.push(script);
  };
  entry.lineup?.forEach((id) => add(candidates.find((script) => script.id === id)));
  candidates.forEach(add);
  return [selected[0] ? String(selected[0].id) : '', selected[1] ? String(selected[1].id) : ''];
}

function TeamEntryCard({ entry, team, scripts, canEdit, busy, onSave }: {
  entry: LadderEntryDTO;
  team: TeamDTO;
  scripts: ScriptSummaryDTO[];
  canEdit: boolean;
  busy: boolean;
  onSave: (lineup: [number, number]) => void;
}) {
  const candidates = eligibleTeamScripts(team, scripts);
  const [lineup, setLineup] = useState<LineupValue>(() => normalizeLineup(candidates, entry));
  const first = candidates.find((script) => script.id === Number(lineup[0]));
  const second = candidates.find((script) => script.id === Number(lineup[1]));
  const valid = !!first && !!second && first.id !== second.id && first.agentId !== second.agentId;

  return (
    <article className="entry-card">
      <div className="section-head">
        <div>
          <span className={`pill ${entry.active ? 'live' : ''}`}>{entry.active ? '参赛中' : '已暂停'}</span>
          <h3><Link to={`/ladders/${entry.ladderSlug}`}>{entry.ladderSlug}</Link></h3>
        </div>
        <span className="hint">#{entry.rank ?? '—'} · {formatNumber(entry.rating)} 分 · {entry.games} 局</span>
      </div>
      {canEdit ? (
        <>
          <div className="form-grid lineup-fields">
            {[0, 1].map((index) => (
              <label key={index}>{index === 0 ? '一号位脚本' : '二号位脚本'}
                <select
                  value={lineup[index]}
                  disabled={busy}
                  onChange={(event) => {
                    const next = [...lineup] as LineupValue;
                    next[index] = event.target.value;
                    setLineup(next);
                  }}
                >
                  <option value="">请选择脚本</option>
                  {candidates.map((script) => <option key={script.id} value={script.id}>{script.name} · {script.agentName}（v{script.activeVersion}）</option>)}
                </select>
              </label>
            ))}
          </div>
          {!valid && <p className="hint">阵容需要两名不同团队成员的有效脚本；队友的私有脚本需由其设为公开后才会出现在这里。</p>}
          <button className="btn" type="button" disabled={busy || !valid} onClick={() => onSave([Number(lineup[0]), Number(lineup[1])])}>
            {busy ? '正在保存…' : '保存阵容'}
          </button>
        </>
      ) : (
        <p className="hint">当前阵容：{entry.lineup?.map((id) => {
          const selected = scripts.find((script) => script.id === id);
          return selected ? `${selected.name} · ${selected.agentName}` : `脚本 #${id}`;
        }).join(' / ') || '尚未设置'}。仅队长可修改。</p>
      )}
    </article>
  );
}

export function TeamDetailPage() {
  const { id } = useParams();
  const teamId = Number(id);
  const validTeamId = Number.isInteger(teamId) && teamId > 0;
  const navigate = useNavigate();
  const { user, ready } = useAuth();
  const [team, setTeam] = useState<TeamDTO | null>(null);
  const [matches, setMatches] = useState<MatchSummaryDTO[]>([]);
  const [agents, setAgents] = useState<AgentDTO[]>([]);
  const [scripts, setScripts] = useState<ScriptSummaryDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [error, setError] = useState('');
  const [agentError, setAgentError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [leaveAgentId, setLeaveAgentId] = useState('');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    if (!validTeamId) {
      setLoading(false);
      setError('团队编号无效。');
      return () => { active = false; };
    }
    setLoading(true);
    setError('');
    setTeam(null);
    Promise.all([getTeam(teamId), listMatches({ teamId, limit: 20 })])
      .then(([teamResult, matchResult]) => {
        if (!active) return;
        setTeam(teamResult);
        setMatches(matchResult.data);
      })
      .catch((err) => { if (active) setError(errorMessage(err)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [teamId, validTeamId, revision]);

  useEffect(() => {
    if (!ready) return;
    let active = true;
    if (!user) {
      setAgents([]);
      setScripts([]);
      setAgentError('');
      return () => { active = false; };
    }
    setAgentsLoading(true);
    setAgentError('');
    Promise.all([listAgents(), listScripts(), listPublicScripts()])
      .then(([agentResult, scriptResult, publicResult]) => {
        if (!active) return;
        const ownIds = new Set(scriptResult.data.map((script) => script.id));
        setAgents(agentResult.data);
        setScripts([...scriptResult.data, ...publicResult.data.filter((script) => !ownIds.has(script.id))]);
      })
      .catch((err) => { if (active) setAgentError(errorMessage(err)); })
      .finally(() => { if (active) setAgentsLoading(false); });
    return () => { active = false; };
  }, [ready, user, revision]);

  const ownAgentIds = new Set(agents.map((agent) => agent.id));
  const ownMembers = team?.members.filter((member) => ownAgentIds.has(member.agentId)) ?? [];
  const isMember = ownMembers.length > 0;
  const isCaptain = !!team && ownAgentIds.has(team.captainAgentId);

  useEffect(() => {
    setLeaveAgentId((current) => ownMembers.some((member) => String(member.agentId) === current)
      ? current
      : String(ownMembers[0]?.agentId ?? ''));
  }, [agents, team]);

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

  async function copyInvite() {
    if (!team?.inviteCode) return;
    setBusy('copy');
    setActionError('');
    setNotice('');
    try {
      await copyText(team.inviteCode);
      setNotice('邀请码已复制');
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy('');
    }
  }

  async function rotateInvite() {
    if (!team || !window.confirm('轮换后旧邀请码会立即失效，确定继续吗？')) return;
    setBusy('rotate');
    setActionError('');
    setNotice('');
    try {
      const result = await rotateTeamInvite(team.id);
      setTeam((current) => current ? { ...current, inviteCode: result.inviteCode } : current);
      setNotice('邀请码已轮换，请将新邀请码发给新成员');
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy('');
    }
  }

  async function submitLeave() {
    if (!team || !leaveAgentId) return;
    const agent = ownMembers.find((member) => String(member.agentId) === leaveAgentId);
    if (!agent || !window.confirm(`确定让「${agent.agentName}」退出「${team.name}」吗？`)) return;
    setBusy('leave');
    setActionError('');
    try {
      await leaveTeam(team.id, agent.agentId);
      navigate('/teams');
    } catch (err) {
      setActionError(errorMessage(err));
      setBusy('');
    }
  }

  if (loading) return <div className="shell"><p className="panel hint" role="status">正在加载团队详情…</p></div>;
  if (error || !team) {
    return (
      <div className="shell">
        <div className="panel error-state" role="alert">
          <p>{error || '团队不存在或已解散。'}</p>
          <div className="toolbar"><Link className="btn ghost" to="/teams">返回团队列表</Link>{validTeamId && <button className="btn" onClick={() => setRevision((value) => value + 1)}>重试</button>}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <header className="page-head">
        <div>
          <Link className="back-link" to="/teams">← 全部团队</Link>
          <p className="eyebrow">{team.tag || `团队 ${team.id}`}</p>
          <h1>{team.name}</h1>
          <p>{team.description || '这支团队还没有填写简介。'}</p>
        </div>
        <div className="stat-row"><span><strong>{team.members.length}</strong> 名成员</span><span><strong>{team.entries.length}</strong> 个天梯入场</span></div>
      </header>

      {actionError && <p className="flash" role="alert">{actionError}</p>}
      {notice && <p className="success-message" role="status">{notice}</p>}

      <section className="panel">
        <div className="section-head"><h2>团队成员</h2><span className="hint">创建于 {formatDate(team.createdAt)}</span></div>
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Agent</th><th>角色</th><th>加入时间</th>{isCaptain && <th>操作</th>}</tr></thead>
            <tbody>
              {team.members.map((member) => (
                <tr key={member.agentId}>
                  <td><Link to={`/agents/${member.agentId}`}>{member.agentName}</Link>{ownAgentIds.has(member.agentId) && <span className="hint">（我的）</span>}</td>
                  <td>{member.role === 'captain' ? '队长' : '成员'}</td>
                  <td>{formatDate(member.joinedAt)}</td>
                  {isCaptain && <td>{member.role !== 'captain' && <button className="btn danger" type="button" disabled={busy !== ''} onClick={() => {
                    if (window.confirm(`确定将「${member.agentName}」移出团队吗？其参与的天梯阵容会被暂停。`)) {
                      void mutate(`kick-${member.agentId}`, () => kickTeamMember(team.id, member.agentId), '成员已移出团队');
                    }
                  }}>{busy === `kick-${member.agentId}` ? '正在移除…' : '移出团队'}</button>}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {ready && user && agentsLoading && <p className="hint">正在核对我的团队权限…</p>}
        {ready && user && !agentsLoading && agentError && <div className="error-state" role="alert"><p className="flash">{agentError}</p><button className="btn ghost" onClick={() => setRevision((value) => value + 1)}>重试</button></div>}
      </section>

      <section className="panel">
        <h2>邀请与离队</h2>
        {!ready && <p className="hint">正在确认登录状态…</p>}
        {ready && !user && <div className="empty-state"><p className="hint">邀请码仅团队成员可见。登录后可加入或管理团队。</p><Link className="btn" to="/login">登录</Link></div>}
        {ready && user && !agentsLoading && !agentError && !isMember && <p className="hint empty-state">你不是这支团队的成员，请向队长索取邀请码后从团队列表加入。</p>}
        {ready && user && isMember && (
          <div className="form-grid team-membership">
            <div>
              <h3>团队邀请码</h3>
              {team.inviteCode ? <code className="invite-code">{team.inviteCode}</code> : <p className="hint">暂时无法读取邀请码，请刷新重试。</p>}
              <div className="toolbar">
                <button className="btn ghost" type="button" disabled={!team.inviteCode || busy !== ''} onClick={copyInvite}>{busy === 'copy' ? '正在复制…' : '复制邀请码'}</button>
                {isCaptain && <button className="btn ghost" type="button" disabled={busy !== ''} onClick={rotateInvite}>{busy === 'rotate' ? '正在轮换…' : '轮换邀请码'}</button>}
              </div>
              {!isCaptain && <p className="hint">只有队长可以轮换邀请码或移出成员。</p>}
            </div>
            <div>
              <h3>退出团队</h3>
              <label>选择要退出的 Agent
                <select value={leaveAgentId} disabled={busy !== ''} onChange={(event) => setLeaveAgentId(event.target.value)}>
                  {ownMembers.map((member) => <option key={member.agentId} value={member.agentId}>{member.agentName}{member.role === 'captain' ? '（队长）' : ''}</option>)}
                </select>
              </label>
              <p className="hint">队长离队会自动移交队长；最后一名成员离队将解散团队。</p>
              <button className="btn danger" type="button" disabled={!leaveAgentId || busy !== ''} onClick={submitLeave}>{busy === 'leave' ? '正在退出…' : '退出团队'}</button>
            </div>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="section-head"><h2>团队天梯阵容</h2><span className="hint">每场选择两名不同成员的脚本</span></div>
        {team.entries.length === 0 && (
          <div className="empty-state"><p className="hint">团队尚未入场天梯，可先到团队天梯选择本队与阵容。</p><div className="toolbar"><Link className="btn ghost" to="/ladders/team-battle">团队生存天梯</Link><Link className="btn ghost" to="/ladders/team-score">团队抢分天梯</Link></div></div>
        )}
        <div className="entry-list">
          {team.entries.map((entry) => (
            <TeamEntryCard
              key={`${entry.entryId}-${entry.lineup?.join('-') ?? ''}`}
              entry={entry}
              team={team}
              scripts={scripts}
              canEdit={isCaptain && !agentsLoading && !agentError}
              busy={busy === `entry-${entry.entryId}`}
              onSave={(lineup) => void mutate(`entry-${entry.entryId}`, () => updateLadderEntry(entry.ladderSlug, entry.entryId, { lineup }), '团队阵容已保存')}
            />
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="section-head"><h2>近期对局</h2><span className="hint">最近 20 场</span></div>
        <MatchList matches={matches} empty="这支团队还没有对局记录。" />
      </section>
    </div>
  );
}
