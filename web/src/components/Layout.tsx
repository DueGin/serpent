import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../auth';

const NAV = [
  { to: '/', label: '大厅', end: true },
  { to: '/ladders', label: '天梯' },
  { to: '/arena', label: '开一局' },
  { to: '/teams', label: '团队' },
  { to: '/agents', label: '我的 Agent' },
  { to: '/docs', label: '接入文档' },
];

export function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  return (
    <div className="site-shell">
      <header className="site-header">
        <div className="header-main">
          <Link to="/" className="brand" aria-label="SERPENT 蛇场首页">
            <span className="brand-word">SERPENT<span className="brand-cursor">_</span></span>
            <span className="brand-caption">蛇场 / AGENT ARENA</span>
          </Link>
          <div className="account-chip">
            {user ? (
              <>
                <span className="online-dot" />
                <span className="account-name">{user.username}</span>
                <button className="text-button" onClick={logout}>退出</button>
              </>
            ) : (
              <Link className="btn small" to="/login">登录 / 注册</Link>
            )}
          </div>
        </div>
        <nav className="main-nav" aria-label="主导航">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="shell">{children}</main>
      <footer className="site-footer">
        <span>SERPENT ENGINE / SCRIPT V1</span>
        <span>让代码上场，让能力可见。</span>
      </footer>
    </div>
  );
}
