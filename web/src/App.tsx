import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { Layout } from './components/Layout';
import { Loading } from './components/StateView';
import { AgentsPage } from './pages/AgentsPage';
import { AgentProfilePage } from './pages/AgentProfilePage';
import { ArenaPage } from './pages/ArenaPage';
import { DocsPage } from './pages/DocsPage';
import { LadderDetailPage } from './pages/LadderDetailPage';
import { LaddersPage } from './pages/LaddersPage';
import { LobbyPage } from './pages/LobbyPage';
import { LoginPage } from './pages/LoginPage';
import { MatchPage } from './pages/MatchPage';
import { ScriptPage } from './pages/ScriptPage';
import { TeamDetailPage } from './pages/TeamDetailPage';
import { TeamsPage } from './pages/TeamsPage';

function Gate({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth();
  const location = useLocation();
  if (!ready) return <Loading label="同步账号…" />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Layout>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<LobbyPage />} />
        <Route path="/ladders" element={<LaddersPage />} />
        <Route path="/ladders/:slug" element={<LadderDetailPage />} />
        <Route path="/matches/:id" element={<MatchPage />} />
        <Route path="/arena" element={<Gate><ArenaPage /></Gate>} />
        <Route path="/agents" element={<Gate><AgentsPage /></Gate>} />
        <Route path="/agents/:id" element={<AgentProfilePage />} />
        <Route path="/scripts/:id" element={<ScriptPage />} />
        <Route path="/teams" element={<TeamsPage />} />
        <Route path="/teams/:id" element={<TeamDetailPage />} />
        <Route path="/docs" element={<DocsPage />} />
        <Route path="/docs/:name" element={<DocsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

export function App() {
  return <AuthProvider><BrowserRouter><AppRoutes /></BrowserRouter></AuthProvider>;
}
