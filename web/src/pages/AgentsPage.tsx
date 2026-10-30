import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  createAgent,
  defaultPrompt,
  deleteAgent,
  listAgents,
  testAgent,
  updateAgent,
  type BoundAgent,
} from '../api';
import { useAuth } from '../auth';

const PRESETS = [
  { label: 'Chat 兼容网关', protocol: 'chat' as const, baseUrl: 'https://code.teralemo.com/v1', model: 'gpt-5.6-sol' },
  { label: 'Messages 兼容网关', protocol: 'message' as const, baseUrl: 'https://flux-code.cc/v1', model: 'grok-4.7' },
  { label: 'OpenAI Chat', protocol: 'chat' as const, baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: 'Anthropic Messages', protocol: 'message' as const, baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5' },
  { label: 'Jev / TypeSafe', protocol: 'jev' as const, baseUrl: 'https://api.typesafe.ai', model: 'jev-latest' },
  { label: 'Laya', protocol: 'laya' as const, baseUrl: 'http://127.0.0.1:8787', model: 'laya-multilingual' },
];

export function AgentsPage() {
  const { user, logout } = useAuth();
  const [agents, setAgents] = useState<BoundAgent[]>([]);
  const [editing, setEditing] = useState<number | 'new' | null>('new');
  const [name, setName] = useState('');
  const [protocol, setProtocol] = useState<'chat' | 'message' | 'jev' | 'laya'>('chat');
  const [baseUrl, setBaseUrl] = useState('https://code.teralemo.com/v1');
  const [model, setModel] = useState('gpt-5.6-sol');
  const [apiKey, setApiKey] = useState('');
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  async function reload() {
    const { data } = await listAgents();
    setAgents(data);
  }

  useEffect(() => {
    reload().catch((e) => setError(e.message));
    defaultPrompt().then((r) => {
      if (!prompt) setPrompt(r.prompt);
    }).catch(() => {});
  }, []);

  function startNew() {
    setEditing('new');
    setName('');
    setProtocol('chat');
    setBaseUrl('https://code.teralemo.com/v1');
    setModel('gpt-5.6-sol');
    setApiKey('');
    setError('');
    setInfo('');
    defaultPrompt().then((r) => setPrompt(r.prompt)).catch(() => {});
  }

  function load(agent: BoundAgent) {
    setEditing(agent.id);
    setName(agent.name);
    setProtocol(agent.protocol);
    setBaseUrl(agent.base_url);
    setModel(agent.model);
    setApiKey('');
    setPrompt(agent.system_prompt);
    setError('');
    setInfo(`正在编辑 ${agent.name}，上游 Key ${agent.apiKeyHint}`);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setInfo('');
    try {
      if (editing === 'new' || editing == null) {
        await createAgent({ name, protocol, baseUrl, model, apiKey, systemPrompt: prompt });
        setInfo('已绑定 Agent');
        setApiKey('');
      } else {
        await updateAgent(editing, {
          name, protocol, baseUrl, model, systemPrompt: prompt,
          ...(apiKey.trim() ? { apiKey } : {}),
        });
        setInfo('已保存');
        setApiKey('');
      }
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    }
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <Link to="/" className="brand-sub">← 大厅</Link>
          <div className="brand-en" style={{ fontSize: 42 }}>AGENTS</div>
          <div className="brand-zh">{user?.username} 的绑定 Agent</div>
        </div>
        <div className="toolbar">
          <button className="btn" type="button" onClick={startNew}>新增 Agent</button>
          <button className="btn ghost" onClick={logout}>退出</button>
        </div>
      </header>

      <div className="agent-layout">
        <section className="panel">
          <div className="toolbar" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>已绑定</h3>
            <button className="btn" type="button" onClick={startNew}>＋ 新增</button>
          </div>
          {agents.length === 0 && <p className="hint">还没有 Agent。点右上角或这里的「新增」，填网关和 Key 后保存。</p>}
          {agents.map((a) => (
            <div className="agent-row" key={a.id}>
              <div>
                <strong>{a.name}</strong>
                <div className="hint">{a.protocol} · {a.model}</div>
                <div className="hint">{a.apiKeyHint}</div>
              </div>
              <div className="toolbar">
                <button className="btn ghost" onClick={() => load(a)}>编辑</button>
                <button className="btn ghost" onClick={async () => {
                  setInfo('探测中…');
                  try {
                    const r = await testAgent(a.id);
                    setInfo(r.ok ? `连通：${r.sample}` : `已响应：${r.sample}`);
                  } catch (err) {
                    setError(err instanceof Error ? err.message : '探测失败');
                  }
                }}>探测</button>
                <button className="btn danger" onClick={async () => {
                  await deleteAgent(a.id);
                  if (editing === a.id) setEditing('new');
                  await reload();
                }}>解绑</button>
              </div>
            </div>
          ))}
        </section>

        <form className="panel auth-form" onSubmit={onSubmit}>
          <h3>{editing === 'new' || editing == null ? '绑定新 Agent' : '编辑 Agent'}</h3>
          <div className="toolbar">
            {PRESETS.map((p) => (
              <button key={p.label} type="button" className="btn ghost" onClick={() => {
                setProtocol(p.protocol);
                setBaseUrl(p.baseUrl);
                setModel(p.model);
              }}>{p.label}</button>
            ))}
          </div>
          <label>显示名<input value={name} maxLength={24} onChange={(e) => setName(e.target.value)} /></label>
          <label>协议
            <select value={protocol} onChange={(e) => setProtocol(e.target.value as 'chat' | 'message' | 'jev' | 'laya')}>
              <option value="chat">chat（OpenAI /chat/completions）</option>
              <option value="message">message（Anthropic /messages）</option>
              <option value="jev">jev（TypeSafe noul /v1/systemone）</option>
              <option value="laya">laya（System One choice /v1/systemone）</option>
            </select>
          </label>
          <label>Base URL<input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></label>
          <label>模型 ID<input value={model} onChange={(e) => setModel(e.target.value)} /></label>
          <label>上游 API Key
            <input value={apiKey} placeholder={editing === 'new' ? 'sk-…' : '留空则不改'} onChange={(e) => setApiKey(e.target.value)} />
          </label>
          <label>系统提示词
            <textarea rows={10} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </label>
          <div className="flash">{error}</div>
          {info && <div className="hint">{info}</div>}
          <div className="toolbar">
            <button className="btn" disabled={!name || !model || (editing === 'new' && !apiKey)}>
              {editing === 'new' || editing == null ? '创建 Agent' : '保存修改'}
            </button>
            {editing !== 'new' && editing != null && (
              <button type="button" className="btn ghost" onClick={startNew}>改为新增</button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
