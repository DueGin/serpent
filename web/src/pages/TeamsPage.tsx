import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { createTeam, joinTeam, listAgents, listTeams } from '../api';
import { useAuth } from '../auth';
import type { AgentDTO, TeamDTO } from '../types';
import { errorMessage, formatDate } from '../utils';

export function TeamsPage() {
  const { user, ready } = useAuth();
  const navigate = useNavigate();
  const [teams, setTeams] = useState<TeamDTO[]>([]);
  const [agents, setAgents] = useState<AgentDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [error, setError] = useState('');
  const [agentError, setAgentError] = useState('');
  const [actionError, setActionError] = useState('');
  const [name, setName] = useState('');
  const [tag, setTag] = useState('');
  const [description, setDescription] = useState('');
  const [createAgentId, setCreateAgentId] = useState('');
  const [joinAgentId, setJoinAgentId] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [busy, setBusy] = useState<'create' | 'join' | ''>('');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    listTeams()
      .then((result) => { if (active) setTeams(result.data); })
      .catch((err) => { if (active) setError(errorMessage(err)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision]);

  useEffect(() => {
    if (!ready) return;
    let active = true;
    if (!user) {
      setAgents([]);
      setAgentError('');
      return () => { active = false; };
    }
    setAgentsLoading(true);
    setAgentError('');
    listAgents()
      .then((result) => { if (active) setAgents(result.data); })
      .catch((err) => { if (active) setAgentError(errorMessage(err)); })
      .finally(() => { if (active) setAgentsLoading(false); });
    return () => { active = false; };
  }, [ready, user, revision]);

  const availableAgents = agents.filter((agent) => !agent.team);

  useEffect(() => {
    setCreateAgentId((current) => availableAgents.some((agent) => String(agent.id) === current)
      ? current
      : String(availableAgents[0]?.id ?? ''));
    setJoinAgentId((current) => availableAgents.some((agent) => String(agent.id) === current)
      ? current
      : String(availableAgents[0]?.id ?? ''));
  }, [agents]);

  async function submitCreate(event: FormEvent) {
    event.preventDefault();
    if (!createAgentId || !name.trim()) return;
    setBusy('create');
    setActionError('');
    try {
      const team = await createTeam({
        agentId: Number(createAgentId),
        name: name.trim(),
        tag: tag.trim() || undefined,
        description: description.trim() || undefined,
      });
      navigate(`/teams/${team.id}`);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy('');
    }
  }

  async function submitJoin(event: FormEvent) {
    event.preventDefault();
    if (!joinAgentId || !inviteCode.trim()) return;
    setBusy('join');
    setActionError('');
    try {
      const team = await joinTeam({ agentId: Number(joinAgentId), inviteCode: inviteCode.trim() });
      navigate(`/teams/${team.id}`);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="shell">
      <header className="page-head">
        <div>
          <p className="eyebrow">蛇场团队</p>
          <h1>团队</h1>
          <p>集结不同 Agent 的脚本，以两名成员的阵容参加 2v2 团队天梯。</p>
        </div>
        <div className="page-actions"><Link className="btn ghost" to="/ladders">查看天梯</Link></div>
      </header>

      <section className="panel">
        <div className="section-head"><h2>全部团队</h2><span className="hint">{teams.length} 支</span></div>
        {loading && <p className="hint" role="status">正在加载团队…</p>}
        {!loading && error && <div className="error-state" role="alert"><p className="flash">{error}</p><button className="btn ghost" onClick={() => setRevision((value) => value + 1)}>重新加载</button></div>}
        {!loading && !error && teams.length === 0 && <p className="hint empty-state">还没有团队，登录后创建第一支队伍。</p>}
        {!loading && !error && teams.length > 0 && (
          <div className="team-grid">
            {teams.map((team) => (
              <article className="team-card" key={team.id}>
                <div className="section-head">
                  <h3><Link to={`/teams/${team.id}`}>{team.name}</Link></h3>
                  {team.tag && <span className="pill">{team.tag}</span>}
                </div>
                <p>{team.description || '这支团队还没有填写简介。'}</p>
                <p className="hint">{team.members.length} 名成员 · {team.entries.filter((entry) => entry.active).length} 个活跃天梯入场 · 创建于 {formatDate(team.createdAt)}</p>
                <div className="team-members-preview">
                  {team.members.map((member) => <span key={member.agentId}>{member.agentName}{member.role === 'captain' ? '（队长）' : ''}</span>)}
                </div>
                <Link className="btn ghost" to={`/teams/${team.id}`}>查看团队</Link>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="section-head"><h2>创建或加入团队</h2>{user && <span className="hint">{user.username}</span>}</div>
        {!ready && <p className="hint">正在确认登录状态…</p>}
        {ready && !user && <div className="empty-state"><p className="hint">团队创建与邀请码加入需要登录。</p><Link className="btn" to="/login">登录</Link></div>}
        {ready && user && agentsLoading && <p className="hint" role="status">正在加载我的 Agent…</p>}
        {ready && user && !agentsLoading && agentError && <div className="error-state" role="alert"><p className="flash">{agentError}</p><button className="btn ghost" onClick={() => setRevision((value) => value + 1)}>重试</button></div>}
        {ready && user && !agentsLoading && !agentError && agents.length === 0 && (
          <div className="empty-state"><p className="hint">你需要先创建一个 Agent，才能创建或加入团队。</p><Link className="btn" to="/agents">创建 Agent</Link></div>
        )}
        {ready && user && !agentsLoading && !agentError && agents.length > 0 && availableAgents.length === 0 && (
          <p className="hint empty-state">你的 Agent 都已加入团队。一个 Agent 同时只能属于一支队伍，可先退出原团队。</p>
        )}
        {ready && user && !agentsLoading && !agentError && availableAgents.length > 0 && (
          <div className="form-grid team-forms">
            <form className="team-form" onSubmit={submitCreate}>
              <h3>创建团队</h3>
              <label>队长 Agent
                <select value={createAgentId} onChange={(event) => setCreateAgentId(event.target.value)}>
                  {availableAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                </select>
              </label>
              <label>团队名称<input value={name} maxLength={64} required placeholder="例如：蛇形机动" onChange={(event) => setName(event.target.value)} /></label>
              <label>团队标签（可选）<input value={tag} maxLength={12} placeholder="例如：SNAKE" onChange={(event) => setTag(event.target.value)} /></label>
              <label>团队简介（可选）<textarea rows={3} maxLength={2000} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
              <button className="btn" disabled={busy !== '' || !createAgentId || !name.trim()}>{busy === 'create' ? '正在创建…' : '创建团队'}</button>
            </form>

            <form className="team-form" onSubmit={submitJoin}>
              <h3>使用邀请码加入</h3>
              <label>加入团队的 Agent
                <select value={joinAgentId} onChange={(event) => setJoinAgentId(event.target.value)}>
                  {availableAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                </select>
              </label>
              <label>邀请码
                <input value={inviteCode} maxLength={128} required autoComplete="off" placeholder="粘贴队长分享的邀请码" onChange={(event) => setInviteCode(event.target.value)} />
              </label>
              <button className="btn" disabled={busy !== '' || !joinAgentId || !inviteCode.trim()}>{busy === 'join' ? '正在加入…' : '加入团队'}</button>
            </form>
          </div>
        )}
        {actionError && <p className="flash" role="alert">{actionError}</p>}
      </section>
    </div>
  );
}
