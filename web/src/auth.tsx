import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { getToken, me, setToken, type User } from './api';
import { connectSocket, disconnectSocket } from './socket';

interface AuthState {
  user: User | null;
  ready: boolean;
  setSession: (token: string, user: User) => void;
  logout: () => void;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      setReady(true);
      return;
    }
    me()
      .then((r) => {
        setUser(r.user);
        connectSocket(token);
      })
      .catch(() => setToken(null))
      .finally(() => setReady(true));
  }, []);

  const value = useMemo<AuthState>(() => ({
    user,
    ready,
    setSession: (token, next) => {
      setToken(token);
      setUser(next);
      connectSocket(token);
    },
    logout: () => {
      setToken(null);
      setUser(null);
      disconnectSocket();
    },
  }), [user, ready]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('AuthProvider missing');
  return ctx;
}
