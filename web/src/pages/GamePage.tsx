import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getRoom, listAgents, type BoundAgent } from '../api';
import { Arena } from '../components/Arena';
import { socket } from '../socket';
import { MODE_META, type AgentThink, type Direction, type PublicRoom } from '../types';

export function GamePage() {
  const { code = '' } = useParams();
  const [room, setRoom] = useState<PublicRoom | null>(null);
  const [playerId, setPlayerId] = useState('');
  const [error, setError] = useState('');
  const [agents, setAgents] = useState<BoundAgent[]>([]);
  const [pick, setPick] = useState<number | ''>('');
  const touch = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    listAgents().then((r) => {
      setAgents(r.data.filter((a) => a.enabled));
      if (r.data[0]) setPick(r.data[0].id);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const roomCode = code.toUpperCase();
    let alive = true;
    const apply = (r: PublicRoom) => {
      if (!alive) return;
      setError('');
      setRoom((prev) => {
        if (!prev) return r;
        if (r.tick < prev.tick && r.status === prev.status) return prev;
        return r;
      });
    };
    const join = () => socket.emit('room:join', { code: roomCode });
    const onSession = (s: { playerId: string }) => setPlayerId(s.playerId);
    const onErr = (e: { message: string }) => {
      if (alive) setError(e.message);
    };
    socket.on('session:ok', onSession);
    socket.on('room:state', apply);
    socket.on('room:joined', apply);
    socket.on('error', onErr);
    socket.on('connect', join);
    if (socket.connected) join();
    getRoom(roomCode).then(apply).catch(() => {});
    const poll = setInterval(() => {
      getRoom(roomCode).then(apply).catch(() => {});
    }, 600);
    return () => {
      alive = false;
      clearInterval(poll);
      socket.emit('room:leave');
      socket.off('session:ok', onSession);
      socket.off('room:state', apply);
      socket.off('room:joined', apply);
      socket.off('error', onErr);
      socket.off('connect', join);
    };
  }, [code]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const map: Record<string, Direction> = {
        ArrowUp: 'up', w: 'up', W: 'up',
        ArrowDown: 'down', s: 'down', S: 'down',
        ArrowLeft: 'left', a: 'left', A: 'left',
        ArrowRight: 'right', d: 'right', D: 'right',
      };
      const dir = map[e.key];
      if (!dir) return;
      e.preventDefault();
      socket.emit('game:act', { direction: dir });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const spectating = Boolean(room && playerId && !room.you);
  const overlay = !room ? (error || 'CONNECTING')
    : room.status === 'lobby' ? 'LOBBY'
      : room.status === 'countdown' ? String(room.countdown || 'GO')
        : room.status === 'ended' ? (room.winners.map((w) => w.name).join(' / ') || 'END')
          : '';

  const youHost = room?.hostId === (room?.you?.id || playerId);

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <Link to="/" className="brand-sub" style={{ position: 'relative', zIndex: 3 }}>← 大厅</Link>
          <div className="brand-en" style={{ fontSize: 42 }}>SERPENT</div>
          <div className="brand-zh">
            房间 {code.toUpperCase()} · {room ? MODE_META[room.mode].title : '...'}
          </div>
        </div>
        <div className="hint">{spectating || (room && !room.you) ? '观战中' : 'WASD / 方向键 · 滑动屏幕'}</div>
      </header>

      <div className="play">
        <div
          className="cabinet"
          onTouchStart={(e) => {
            const t = e.changedTouches[0];
            if (t) touch.current = { x: t.clientX, y: t.clientY };
          }}
          onTouchEnd={(e) => {
            const t = e.changedTouches[0];
            if (!t || !touch.current) return;
            const dx = t.clientX - touch.current.x;
            const dy = t.clientY - touch.current.y;
            if (Math.hypot(dx, dy) < 24) return;
            const direction: Direction = Math.abs(dx) > Math.abs(dy)
              ? (dx > 0 ? 'right' : 'left')
              : (dy > 0 ? 'down' : 'up');
            socket.emit('game:act', { direction });
          }}
        >
          {room && <Arena room={room} />}
          <div className="scan" />
          {overlay && overlay !== 'GO' && room?.status !== 'running' && (
            <div className="overlay-msg">{overlay}</div>
          )}
        </div>

        <aside className="side">
          <div className="panel">
            <h3>SCORE</h3>
            {room?.thinkTimeoutSec != null && (
              <div className="hint">每步超时 {room.thinkTimeoutSec}s，超时沿原方向前进</div>
            )}
            {room?.remainingMs != null && (
              <div className="hint">剩余 {Math.ceil(room.remainingMs / 1000)}s
                {room.targetScore ? ` · 目标 ${room.targetScore}` : ''}
              </div>
            )}
            {(room?.players ?? []).map((p) => (
              <div className="score-line" key={p.id}>
                <span>
                  <i className="dot" style={{ background: p.color }} />
                  {p.name}{p.isBot ? ' · bot' : p.kind === 'agent' ? ' · agent' : ''}
                  {!p.alive && room?.status !== 'lobby' ? ' ×' : ''}
                  {room?.status === 'lobby' && (p.ready ? ' ✓' : '')}
                  {p.kind === 'agent' && !p.isBot && p.think && room?.status === 'running' && (
                    <span className={`think-pill ${p.think.status}`}>{thinkLabel(p.think)}</span>
                  )}
                </span>
                <strong>{p.score}</strong>
              </div>
            ))}
            {room?.status === 'lobby' && youHost && (
              <label className="hint" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
                Agent 思考超时 {room.thinkTimeoutSec ?? 10}s
                <input
                  type="range"
                  min={3}
                  max={60}
                  value={room.thinkTimeoutSec ?? 10}
                  onChange={(e) => socket.emit('room:config', { thinkTimeoutSec: Number(e.target.value) })}
                />
              </label>
            )}
            <div className="toolbar" style={{ marginTop: 12 }}>
              {room?.status === 'lobby' && (
                <>
                  {!room.you && (
                    <button className="btn mint" onClick={() => socket.emit('room:seat')}>下场参赛</button>
                  )}
                  {room.you && (
                    <button className="btn mint" onClick={() => socket.emit('room:ready', { ready: true })}>准备</button>
                  )}
                  {youHost && <button className="btn" onClick={() => socket.emit('room:start')}>开局</button>}
                  {room.mode !== 'solo' && (
                    <button className="btn ghost" onClick={() => socket.emit('room:bot', { strategy: 'greedy' })}>练习 Bot</button>
                  )}
                </>
              )}
            </div>
            <div className="flash">{error}</div>
          </div>

          <div className="panel">
            <h3>派遣 AGENT</h3>
            <p className="hint">把账号里绑定的模型派进这局。提示词在「我的 Agent」里改。</p>
            {agents.length === 0 ? (
              <Link to="/agents">先去绑定 Agent →</Link>
            ) : (
              <div className="toolbar">
                <select value={pick} onChange={(e) => setPick(e.target.value ? Number(e.target.value) : '')}>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>{a.name} · {a.model}</option>
                  ))}
                </select>
                <button
                  className="btn"
                  disabled={!pick || room?.status !== 'lobby'}
                  onClick={() => typeof pick === 'number' && socket.emit('room:deploy-agent', { agentId: pick })}
                >
                  派进房间
                </button>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function thinkLabel(think: AgentThink): string {
  const sec = think.elapsedMs != null ? `${(think.elapsedMs / 1000).toFixed(1)}s` : '';
  const dir = think.direction ? ` ${think.direction}` : '';
  if (think.status === 'thinking') return `思考中 ${sec}`;
  if (think.status === 'done') return `已决策${dir} ${sec}`;
  if (think.status === 'timeout') return `超时，沿原方向${dir} ${sec}`;
  if (think.status === 'error') return `失败，沿原方向${dir}`;
  return '';
}
