import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { listAgents, type BoundAgent } from '../api';
import { useAuth } from '../auth';
import { socket, type PresenceUser } from '../socket';
import { MODE_META, type GameMode, type RoomSummary } from '../types';

export function LobbyPage() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [online, setOnline] = useState<PresenceUser[]>([]);
  const [agents, setAgents] = useState<BoundAgent[]>([]);
  const [error, setError] = useState('');
  const [thinkTimeoutSec, setThinkTimeoutSec] = useState(10);
  const expectJoin = useRef(false);
  const live = rooms.filter((r) => r.status === 'running' || r.status === 'countdown');
  const waiting = rooms.filter((r) => r.status === 'lobby');

  useEffect(() => {
    listAgents().then((r) => setAgents(r.data)).catch(() => {});
  }, []);

  useEffect(() => {
    const onList = (list: RoomSummary[]) => setRooms(list);
    const onPresence = (list: PresenceUser[]) => setOnline(list);
    const onJoined = (room: { code: string }) => {
      if (!expectJoin.current) return;
      expectJoin.current = false;
      nav(`/r/${room.code}`);
    };
    const onErr = (e: { message: string }) => setError(e.message);
    const onConnect = () => socket.emit('rooms:list');
    socket.on('rooms:list', onList);
    socket.on('presence:list', onPresence);
    socket.on('room:joined', onJoined);
    socket.on('error', onErr);
    socket.on('connect', onConnect);
    if (socket.connected) socket.emit('rooms:list');
    return () => {
      socket.off('rooms:list', onList);
      socket.off('presence:list', onPresence);
      socket.off('room:joined', onJoined);
      socket.off('error', onErr);
      socket.off('connect', onConnect);
    };
  }, [nav]);

  function create(mode: GameMode) {
    setError('');
    expectJoin.current = true;
    socket.emit('room:create', { mode, thinkTimeoutSec });
  }

  function join(target: string) {
    setError('');
    expectJoin.current = true;
    socket.emit('room:join', { code: target.trim().toUpperCase(), play: true });
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <div className="brand-en">SERPENT</div>
          <div className="brand-zh">蛇场 · 联网竞技</div>
          <div className="brand-sub">online  {online.length}  /  rooms {rooms.length}</div>
        </div>
        <div className="account-chip">
          <div>
            <div className="hint">已登录</div>
            <strong>{user?.username}</strong>
          </div>
          <Link className="btn ghost" to="/agents">我的 Agent</Link>
          <button className="btn ghost" onClick={logout}>退出</button>
        </div>
      </header>

      <div className="lobby-grid">
        <div>
          <div className="panel" style={{ marginBottom: 16 }}>
            <h3>房间设定</h3>
            <label>
              Agent 每步最长思考 {thinkTimeoutSec}s
              <input
                type="range"
                min={3}
                max={60}
                step={1}
                value={thinkTimeoutSec}
                onChange={(e) => setThinkTimeoutSec(Number(e.target.value))}
              />
            </label>
            <p className="hint">超时仍未返回则沿原方向走一格。可设 3～60 秒，默认 10 秒。</p>
          </div>
          <div className="mode-grid">
            {(Object.keys(MODE_META) as GameMode[]).map((mode) => (
              <button key={mode} className="mode-card" onClick={() => create(mode)}>
                <div className="en">{MODE_META[mode].en}</div>
                <div>{MODE_META[mode].title}</div>
                <p>{MODE_META[mode].blurb}</p>
                <span className="btn">开一局</span>
              </button>
            ))}
          </div>

          <div className="flash">{error}</div>

          <section className="rooms">
            <h2>正在对局</h2>
            {live.length === 0 && <p className="hint">现在没有进行中的对局。开一局，或等别人开打后来看。</p>}
            {live.map((r) => (
              <button key={r.id} className="room-row" onClick={() => nav(`/r/${r.code}`)}>
                <span className="pill live">{r.status === 'countdown' ? '倒计时' : 'LIVE'}</span>
                <span>
                  {MODE_META[r.mode].title} · {(r.names || []).join(' / ') || r.hostName}
                  {r.scores?.length ? `  ${r.scores.map((s) => `${s.name} ${s.score}`).join(' · ')}` : ''}
                </span>
                <span className="hint">{r.watchers ? `${r.watchers} 人在看` : ''}</span>
                <span className="btn">观战</span>
              </button>
            ))}
          </section>

          <section className="rooms">
            <h2>等待开局</h2>
            {waiting.length === 0 && <p className="hint">没有等人的房间。上面开一局即可。</p>}
            {waiting.map((r) => (
              <button key={r.id} className="room-row" onClick={() => join(r.code)}>
                <span className="pill">LOBBY</span>
                <span>{MODE_META[r.mode].title} · {(r.names || []).join(' / ') || r.hostName || '空房间'}</span>
                <span>{r.players}/{r.maxPlayers}</span>
                <span className="btn ghost">加入</span>
              </button>
            ))}
          </section>
        </div>

        <aside className="side">
          <div className="panel">
            <h3>ONLINE</h3>
            {online.length === 0 && <p className="hint">暂时只有你。</p>}
            {online.map((p) => (
              <div className="score-line" key={p.userId}>
                <span>{p.username}</span>
                <span className="hint">{p.roomCode ? `#${p.roomCode}` : '大厅'}</span>
              </div>
            ))}
          </div>
          <div className="panel">
            <h3>MY AGENTS</h3>
            {agents.length === 0 && (
              <p className="hint">去绑定自己的模型。进房后可以把 Agent 派进对局。</p>
            )}
            {agents.map((a) => (
              <div className="score-line" key={a.id}>
                <span>{a.name}</span>
                <span className="hint">{a.model}</span>
              </div>
            ))}
            <Link className="btn ghost" to="/agents" style={{ marginTop: 10, display: 'inline-block' }}>管理 / 改提示词</Link>
          </div>
        </aside>
      </div>
    </div>
  );
}
