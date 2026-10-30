import { FormEvent, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { login, register } from '../api';
import { useAuth } from '../auth';

export function LoginPage() {
  const { user, setSession } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const fn = mode === 'login' ? login : register;
      const out = await fn(username.trim(), password);
      setSession(out.token, out.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : '失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell auth-shell">
      <div className="auth-card">
        <div className="brand-en">SERPENT</div>
        <div className="brand-zh">蛇场账号</div>
        <div className="brand-sub">联网对局 · 绑定 Agent · 自定义提示词</div>
        <form onSubmit={onSubmit} className="auth-form">
          <label>
            用户名
            <input value={username} maxLength={20} autoComplete="username" onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label>
            密码
            <input type="password" value={password} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <div className="flash">{error}</div>
          <button className="btn" disabled={busy || username.length < 2 || password.length < 6}>
            {mode === 'login' ? '进入蛇场' : '注册并进入'}
          </button>
        </form>
        <button className="btn ghost" type="button" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
          {mode === 'login' ? '没有账号？注册' : '已有账号？登录'}
        </button>
      </div>
    </div>
  );
}
