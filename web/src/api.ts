const TOKEN_KEY = 'serpent-token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(path, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || res.statusText);
  return body as T;
}

export interface User {
  id: number;
  username: string;
  createdAt?: number;
}

export interface BoundAgent {
  id: number;
  name: string;
  protocol: 'chat' | 'message' | 'jev' | 'laya';
  base_url: string;
  model: string;
  system_prompt: string;
  enabled: boolean;
  apiKeyHint: string;
  platformKey: string;
  created_at: number;
  updated_at: number;
}

export function login(username: string, password: string) {
  return req<{ token: string; user: User }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

export function register(username: string, password: string) {
  return req<{ token: string; user: User }>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

export function me() {
  return req<{ user: User }>('/api/auth/me');
}

export function listAgents() {
  return req<{ data: BoundAgent[] }>('/api/agents');
}

export function createAgent(input: {
  name: string;
  protocol: 'chat' | 'message' | 'jev' | 'laya';
  baseUrl: string;
  model: string;
  apiKey: string;
  systemPrompt?: string;
}) {
  return req<BoundAgent>('/api/agents', { method: 'POST', body: JSON.stringify(input) });
}

export function updateAgent(id: number, input: Record<string, unknown>) {
  return req<BoundAgent>(`/api/agents/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export function deleteAgent(id: number) {
  return req<{ ok: boolean }>(`/api/agents/${id}`, { method: 'DELETE' });
}

export function testAgent(id: number) {
  return req<{ ok: boolean; sample: string }>(`/api/agents/${id}/test`, { method: 'POST' });
}

export function defaultPrompt() {
  return req<{ prompt: string }>('/api/agents/prompt-default');
}

export function getRoom(code: string) {
  return req<import('./types').PublicRoom>(`/api/rooms/${code}`);
}
