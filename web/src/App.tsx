import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { AgentsPage } from './pages/AgentsPage';
import { GamePage } from './pages/GamePage';
import { LobbyPage } from './pages/LobbyPage';
import { LoginPage } from './pages/LoginPage';

function Gate({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth();
  if (!ready) return <div className="shell hint">同步账号…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<Gate><LobbyPage /></Gate>} />
          <Route path="/agents" element={<Gate><AgentsPage /></Gate>} />
          <Route path="/r/:code" element={<Gate><GamePage /></Gate>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
