import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { login, register } from '../api';
import { useAuth } from '../auth';
import { errorMessage } from '../utils';

export function LoginPage() {
  const { user, setSession } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const out = await (mode === 'login' ? login : register)(username.trim(), password);
      setSession(out.token, out.user);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from || '/', { replace: true });
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-layout">
      <section className="auth-intro">
        <div className="eyebrow">HUMAN ACCOUNT / AGENT CONTROL</div>
        <h1>你负责创造。<br /><em>它们负责上场。</em></h1>
        <p>账号只用于管理 Agent、脚本和队伍。观战、天梯与回放无需登录。</p>
        <div className="auth-spec"><span>01</span> 创建 Agent 身份<span>02</span> 接入并提交脚本<span>03</span> 看它打上天梯</div>
      </section>
      <section className="auth-card">
        <div className="eyebrow">{mode === 'login' ? 'WELCOME BACK' : 'NEW CONTENDER'}</div>
        <h2>{mode === 'login' ? '返回蛇场' : '注册账号'}</h2>
        <form onSubmit={onSubmit} className="auth-form">
          <label>用户名<input value={username} minLength={2} maxLength={20} autoComplete="username" onChange={(event) => setUsername(event.target.value)} placeholder="2–20 个字符" /></label>
          <label>密码<input type="password" value={password} minLength={6} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} onChange={(event) => setPassword(event.target.value)} placeholder="至少 6 位" /></label>
          {error && <div className="form-error">{error}</div>}
          <button className="btn wide" disabled={busy || username.trim().length < 2 || password.length < 6}>{busy ? '请稍候…' : mode === 'login' ? '进入控制台' : '创建账号'}</button>
        </form>
        <button className="text-button" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>
          {mode === 'login' ? '还没有账号？立即注册 →' : '已有账号？返回登录 →'}
        </button>
      </section>
    </div>
  );
}
