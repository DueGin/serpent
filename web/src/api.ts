import type {
  AgentCreatedDTO,
  AgentDTO,
  AgentProfileDTO,
  BuiltinBot,
  CheckReport,
  CreateMatchInput,
  DocContent,
  DocSummary,
  DryRunResult,
  FrameDTO,
  GameMode,
  LadderDTO,
  LadderEntryDTO,
  LeaderboardRow,
  MatchDetailDTO,
  MatchReviewDTO,
  MatchSummaryDTO,
  PlatformStats,
  ReplayDTO,
  ScenarioInfo,
  ScriptDetailDTO,
  ScriptLanguage,
  ScriptSummaryDTO,
  ScriptTrendDTO,
  ScriptVersionDTO,
  TeamDTO,
} from './types';

const TOKEN_KEY = 'serpent-token';

export interface User { id: number; username: string; createdAt?: number }
export interface ApiErrorBody { error?: { code?: string; message?: string } }

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export function getToken(): string | null { return localStorage.getItem(TOKEN_KEY); }
export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

function query(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  });
  const text = search.toString();
  return text ? `?${text}` : '';
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...(init.body ? { 'content-type': 'application/json' } : {}),
    ...(init.headers as Record<string, string> | undefined),
  };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`/api${path}`, { ...init, headers });
  const body = await res.json().catch(() => ({})) as T & ApiErrorBody;
  if (!res.ok) throw new ApiError(res.status, body?.error?.code || 'REQUEST_FAILED', body?.error?.message || `请求失败（${res.status}）`);
  return body;
}

function send<T>(path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown): Promise<T> {
  return req<T>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

export const login = (username: string, password: string) => send<{ token: string; user: User }>('/auth/login', 'POST', { username, password });
export const register = (username: string, password: string) => send<{ token: string; user: User }>('/auth/register', 'POST', { username, password });
export const me = () => req<{ user: User }>('/auth/me');
export const getHealth = () => req<{ ok: boolean }>('/health');
export const getStats = () => req<PlatformStats>('/stats');

export const listAgents = () => req<{ data: AgentDTO[] }>('/agents');
export const getAgentMe = () => req<AgentDTO>('/agents/me');
export const createAgent = (input: { name: string; modelLabel?: string; description?: string }) => send<AgentCreatedDTO>('/agents', 'POST', input);
export const updateAgent = (id: number, input: { name?: string; modelLabel?: string; description?: string; color?: string; disabled?: boolean }) => send<AgentDTO>(`/agents/${id}`, 'PATCH', input);
export const deleteAgent = (id: number) => send<{ ok: boolean }>(`/agents/${id}`, 'DELETE');
export const rotateAgentKey = (id: number) => send<{ apiKey: string }>(`/agents/${id}/rotate-key`, 'POST', {});
export const getAgentProfile = (id: number) => req<AgentProfileDTO>(`/agents/${id}/profile`);
export const getAgentDirectory = () => req<{ data: AgentDTO[] }>('/agents/directory');

export const listScripts = (agentId?: number) => req<{ data: ScriptSummaryDTO[] }>(`/scripts${query({ agentId })}`);
export const listPublicScripts = (q = '', limit = 100) => req<{ data: ScriptSummaryDTO[] }>(`/scripts/public${query({ q, limit })}`);
export const getScript = (id: number) => req<ScriptDetailDTO>(`/scripts/${id}`);
export const createScript = (input: { agentId?: number; name: string; description?: string; visibility?: 'private' | 'listed' | 'open'; code: string; language: ScriptLanguage; note?: string }) => send<ScriptDetailDTO>('/scripts', 'POST', input);
export const updateScript = (id: number, input: { name?: string; description?: string; visibility?: 'private' | 'listed' | 'open'; activeVersion?: number }) => send<ScriptDetailDTO>(`/scripts/${id}`, 'PATCH', input);
export const archiveScript = (id: number) => send<{ ok: boolean }>(`/scripts/${id}`, 'DELETE');
export const addScriptVersion = (id: number, input: { code: string; note?: string; activate?: boolean }) => send<ScriptVersionDTO>(`/scripts/${id}/versions`, 'POST', input);
export const getScriptVersion = (id: number, version: number) => req<ScriptVersionDTO>(`/scripts/${id}/versions/${version}`);
export const getScriptTrend = (id: number, params: { mode?: GameMode; limit?: number } = {}) => req<ScriptTrendDTO>(`/scripts/${id}/trend${query(params)}`);
export const validateScript = (code: string, language: ScriptLanguage) => send<CheckReport>('/scripts/validate', 'POST', { code, language });
export const dryRunScript = (input: { code?: string; language?: ScriptLanguage; scriptId?: number; version?: number; scenario?: string; state?: unknown; init?: unknown }) => send<DryRunResult>('/scripts/dry-run', 'POST', input);
export const getScenarios = () => req<{ data: ScenarioInfo[] }>('/scripts/scenarios');

export const createMatch = (input: CreateMatchInput) => send<MatchDetailDTO>('/matches', 'POST', input);
export const listMatches = (params: { kind?: string; ladder?: string; agentId?: number; scriptId?: number; teamId?: number; limit?: number; before?: number } = {}) => req<{ data: MatchSummaryDTO[] }>(`/matches${query(params)}`);
export const listLiveMatches = () => req<{ data: MatchSummaryDTO[] }>('/matches/live');
export const getMatch = (id: number) => req<MatchDetailDTO>(`/matches/${id}`);
export const getReplay = (id: number) => req<ReplayDTO>(`/matches/${id}/replay`);
export const getMatchFrame = (id: number, tick: number, viewer?: number) => req<FrameDTO>(`/matches/${id}/frames/${tick}${query({ viewer })}`);
export const getMatchReview = (id: number, params: { slot?: number; series?: 1; from?: number; to?: number } = {}) => req<MatchReviewDTO>(`/matches/${id}/review${query(params)}`);

export const listLadders = () => req<{ data: LadderDTO[] }>('/ladders');
export const getLadder = (slug: string) => req<LadderDTO>(`/ladders/${slug}`);
export const getLeaderboard = (slug: string, by: 'entry' | 'agent' = 'entry', limit = 100) => req<{ data: LeaderboardRow[] }>(`/ladders/${slug}/leaderboard${query({ by, limit })}`);
export const getMyLadderEntries = () => req<{ data: LadderEntryDTO[] }>('/ladders/mine');
export const joinLadder = (slug: string, input: { scriptId: number } | { teamId: number; lineup: [number, number] }) => send<LadderEntryDTO>(`/ladders/${slug}/entries`, 'POST', input);
export const updateLadderEntry = (slug: string, entryId: number, input: { scriptId?: number; lineup?: [number, number]; active?: boolean }) => send<LadderEntryDTO>(`/ladders/${slug}/entries/${entryId}`, 'PATCH', input);
export const leaveLadder = (slug: string, entryId: number) => send<{ ok: boolean }>(`/ladders/${slug}/entries/${entryId}`, 'DELETE');
export const queueLadderMatch = (slug: string, entryId: number) => send<MatchSummaryDTO>(`/ladders/${slug}/entries/${entryId}/queue`, 'POST', {});

export const listTeams = () => req<{ data: TeamDTO[] }>('/teams');
export const getTeam = (id: number) => req<TeamDTO>(`/teams/${id}`);
export const createTeam = (input: { agentId?: number; name: string; tag?: string; description?: string }) => send<TeamDTO>('/teams', 'POST', input);
export const updateTeam = (id: number, input: { name?: string; tag?: string; description?: string }) => send<TeamDTO>(`/teams/${id}`, 'PATCH', input);
export const joinTeam = (input: { agentId?: number; inviteCode: string }) => send<TeamDTO>('/teams/join', 'POST', input);
export const leaveTeam = (id: number, agentId?: number) => send<{ ok: boolean }>(`/teams/${id}/leave`, 'POST', { agentId });
export const kickTeamMember = (id: number, agentId: number) => send<TeamDTO>(`/teams/${id}/kick`, 'POST', { agentId });
export const rotateTeamInvite = (id: number) => send<{ inviteCode: string }>(`/teams/${id}/rotate-invite`, 'POST', {});

export const listDocs = () => req<{ data: DocSummary[] }>('/docs');
export const getDoc = (name: string) => req<DocContent>(`/docs/${encodeURIComponent(name)}`);

export const DEFAULT_SCRIPT = `function move(state) {
  const legal = state.legalMoves;
  if (legal.length === 0) return state.you.dir || 'up';
  const head = state.you.head;
  const food = state.foods[0];
  if (!head || !food) return legal[0];
  const dx = food.x - head.x;
  const dy = food.y - head.y;
  const preferred = Math.abs(dx) > Math.abs(dy)
    ? (dx > 0 ? 'right' : 'left')
    : (dy > 0 ? 'down' : 'up');
  return legal.includes(preferred) ? preferred : legal[0];
}`;

export const PYTHON_SCRIPT = `def move(state):
    legal = state["legalMoves"]
    if not legal:
        return state["you"]["dir"] or "up"
    head = state["you"]["head"]
    food = state["foods"][0] if state["foods"] else None
    if head is None or food is None:
        return legal[0]
    dx = food["x"] - head["x"]
    dy = food["y"] - head["y"]
    if abs(dx) > abs(dy):
        preferred = "right" if dx > 0 else "left"
    else:
        preferred = "down" if dy > 0 else "up"
    return preferred if preferred in legal else legal[0]`;

export const SCRIPT_TEMPLATES: Record<ScriptLanguage, string> = {
  javascript: DEFAULT_SCRIPT,
  python: PYTHON_SCRIPT,
};

export const BUILTIN_LABEL: Record<BuiltinBot, string> = {
  greedy: '贪吃 · Greedy',
  coward: '保守 · Coward',
  random: '随机 · Random',
};
