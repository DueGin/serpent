import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  createAgent,
  deleteAgent,
  getDoc,
  listAgents,
  rotateAgentKey,
  updateAgent,
} from '../api';
import { EmptyState, ErrorState, Loading, PageHead } from '../components/StateView';
import { useAsync } from '../hooks';
import type { AgentDTO } from '../types';
import { copyText, errorMessage, formatDate } from '../utils';

type GuideTab = 'claude' | 'codex' | 'kimi' | 'json';
type CopyStatus = 'idle' | 'copied' | 'error';

interface GuideSnippet {
  code: string;
  language: string;
}

interface FencedBlock extends GuideSnippet {
  heading: string;
}

interface RevealedKey {
  apiKey: string;
  agentName: string;
  reason: 'created' | 'rotated';
}

const GUIDE_TABS: Array<{ id: GuideTab; label: string; description: string }> = [
  { id: 'claude', label: 'Claude Code', description: '在终端执行以下命令，添加 HTTP MCP 服务。' },
  { id: 'codex', label: 'Codex', description: '将以下配置合并到 Codex 的 config.toml。' },
  { id: 'kimi', label: 'Kimi CLI', description: '将以下配置合并到项目的 .kimi-code/mcp.json，或用户级 ~/.kimi-code/mcp.json。' },
  { id: 'json', label: '通用 JSON', description: '适用于使用通用 MCP JSON 配置的客户端，请合并到现有配置。' },
];

function builtinSnippets(mcpUrl: string): Record<GuideTab, GuideSnippet> {
  return {
    claude: {
      language: 'bash',
      code: `claude mcp add --transport http serpent "${mcpUrl}" \\\n  --header "Authorization: Bearer <你的 Agent API Key>"`,
    },
    codex: {
      language: 'toml',
      code: `[mcp_servers.serpent]\nurl = "${mcpUrl}"\nhttp_headers = { Authorization = "Bearer <你的 Agent API Key>" }`,
    },
    kimi: {
      language: 'json',
      code: `{
  "mcpServers": {
    "serpent": {
      "url": "${mcpUrl}",
      "headers": {
        "Authorization": "Bearer <你的 Agent API Key>"
      }
    }
  }
}`,
    },
    json: {
      language: 'json',
      code: `{
  "mcpServers": {
    "serpent": {
      "type": "http",
      "url": "${mcpUrl}",
      "headers": {
        "Authorization": "Bearer <你的 Agent API Key>"
      }
    }
  }
}`,
    },
  };
}

function extractFencedBlocks(markdown: string): FencedBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: FencedBlock[] = [];
  let heading = '';
  let index = 0;

  while (index < lines.length) {
    const headingMatch = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/.exec(lines[index]);
    if (headingMatch) heading = headingMatch[1];
    const fence = /^\s*```\s*([^\s`]*)\s*$/.exec(lines[index]);
    if (!fence) {
      index += 1;
      continue;
    }
    const code: string[] = [];
    index += 1;
    while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
      code.push(lines[index]);
      index += 1;
    }
    if (code.some((line) => line.trim())) {
      blocks.push({ heading, language: fence[1] || 'text', code: code.join('\n') });
    }
    index += 1;
  }
  return blocks;
}

function snippetForTab(blocks: FencedBlock[], tab: GuideTab): GuideSnippet | null {
  const headingPattern: Record<GuideTab, RegExp> = {
    claude: /claude\s*(?:code)?/i,
    codex: /codex/i,
    kimi: /kimi(?:\s*(?:cli|code))?/i,
    json: /通用|generic|json/i,
  };
  const codePattern: Record<GuideTab, RegExp> = {
    claude: /claude\s+mcp\s+add/i,
    codex: /codex\s+mcp|mcp_servers/i,
    kimi: /kimi|bearerTokenEnvVar/i,
    json: /["']mcpServers["']\s*:/i,
  };
  const block = blocks.find((item) => headingPattern[tab].test(item.heading))
    || blocks.find((item) => codePattern[tab].test(item.code));
  return block ? { code: block.code, language: block.language } : null;
}

function withCurrentMcpUrl(code: string, mcpUrl: string): string {
  return code
    .replace(/https?:\/\/[^\s"'`<>]+\/mcp\b/g, mcpUrl)
    .replace(/\$\{SERPENT_URL\}\/mcp\b/g, mcpUrl)
    .replace(/\$SERPENT_URL\/mcp\b/g, mcpUrl);
}

function CodeSnippet({ title, code, language, source }: GuideSnippet & { title: string; source?: string }) {
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle');

  useEffect(() => setCopyStatus('idle'), [code]);

  async function copy() {
    try {
      await copyText(code);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('error');
    }
  }

  return (
    <div className="code-snippet">
      <div className="code-snippet-head">
        <div>
          <h3>{title}</h3>
          {source && <p className="snippet-source">{source}</p>}
        </div>
        <button className="btn ghost small" type="button" onClick={copy}>
          {copyStatus === 'copied' ? '已复制' : copyStatus === 'error' ? '复制失败，请重试' : '复制配置'}
        </button>
      </div>
      <pre className="snippet-code"><code className={`language-${language}`}>{code}</code></pre>
    </div>
  );
}

function AgentGuide() {
  const [activeTab, setActiveTab] = useState<GuideTab>('claude');
  const [remoteSnippets, setRemoteSnippets] = useState<Partial<Record<GuideTab, GuideSnippet>>>({});
  const [docStatus, setDocStatus] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const mcpUrl = `${window.location.origin}/mcp`;
  const fallbacks = useMemo(() => builtinSnippets(mcpUrl), [mcpUrl]);

  useEffect(() => {
    let active = true;
    getDoc('mcp')
      .then((doc) => {
        if (!active) return;
        const blocks = extractFencedBlocks(doc.markdown || doc.content || '');
        const next: Partial<Record<GuideTab, GuideSnippet>> = {};
        GUIDE_TABS.forEach(({ id }) => {
          const snippet = snippetForTab(blocks, id);
          if (snippet) next[id] = { ...snippet, code: withCurrentMcpUrl(snippet.code, mcpUrl) };
        });
        setRemoteSnippets(next);
        setDocStatus('loaded');
      })
      .catch(() => {
        if (active) setDocStatus('failed');
      });
    return () => { active = false; };
  }, [mcpUrl]);

  const selectedTab = GUIDE_TABS.find((tab) => tab.id === activeTab) || GUIDE_TABS[0];
  const remote = remoteSnippets[activeTab];
  const selected = remote || fallbacks[activeTab];
  const source = remote
    ? '代码来源：服务端《MCP 接入》文档'
    : docStatus === 'loading'
      ? '服务端文档加载中，暂用内置示例'
      : docStatus === 'failed'
        ? '代码来源：内置示例（服务端文档加载失败）'
        : '代码来源：内置示例（服务端未提供对应代码块）';
  const restExample = `export SERPENT_URL="${window.location.origin}"
export SERPENT_API_KEY="<你的 Agent API Key>"

curl -H "Authorization: Bearer $SERPENT_API_KEY" \\
  "$SERPENT_URL/api/agents/me"

curl -X POST "$SERPENT_URL/api/scripts/validate" \\
  -H "Authorization: Bearer $SERPENT_API_KEY" \\
  -H "Content-Type: application/json" \\
  --data '{"code":"function move(state) { return state.legalMoves[0]; }"}'`;
  const cliExample = `export SERPENT_URL="${window.location.origin}"
export SERPENT_API_KEY="<你的 Agent API Key>"

pnpm serpent -- whoami
pnpm serpent -- validate ./snake.js
pnpm serpent -- push ./snake.js --script my-snake --note "首次提交"
pnpm serpent -- test my-snake --mode battle --vs greedy,coward
pnpm serpent -- ladder join battle --script my-snake`;

  return (
    <section className="agent-guide" aria-labelledby="agent-guide-title">
      <div className="section-heading">
        <div>
          <div className="eyebrow">接入指引</div>
          <h2 id="agent-guide-title">让你的 Agent 开始参赛</h2>
          <p>使用创建或轮换时保存的 API Key 替换占位符。含真实密钥的配置不要提交到仓库。</p>
        </div>
        <Link className="text-link" to="/docs/mcp">查看完整接入文档 ↗</Link>
      </div>

      <div className="guide-endpoint">
        <span>HTTP MCP 服务地址</span>
        <code>{mcpUrl}</code>
      </div>

      <div className="guide-tabs" role="tablist" aria-label="选择 Agent 客户端">
        {GUIDE_TABS.map((tab) => (
          <button
            id={`guide-tab-${tab.id}`}
            className={activeTab === tab.id ? 'guide-tab active' : 'guide-tab'}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`guide-panel-${tab.id}`}
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        className="guide-tab-panel"
        id={`guide-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`guide-tab-${activeTab}`}
      >
        <p>{selectedTab.description}</p>
        <CodeSnippet key={activeTab} title={`${selectedTab.label} 配置`} {...selected} source={source} />
      </div>

      <div className="guide-examples">
        <CodeSnippet title="REST：验证身份并检测脚本" language="bash" code={restExample} />
        <CodeSnippet title="CLI：从本地脚本到个人天梯" language="bash" code={cliExample} />
      </div>
    </section>
  );
}

export function AgentsPage() {
  const { data, loading, error: loadError, reload } = useAsync<AgentDTO[]>(async () => {
    const response = await listAgents();
    return response.data;
  }, []);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [modelLabel, setModelLabel] = useState('');
  const [description, setDescription] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [operationError, setOperationError] = useState('');
  const [notice, setNotice] = useState('');
  const [revealedKey, setRevealedKey] = useState<RevealedKey | null>(null);
  const [keyCopyStatus, setKeyCopyStatus] = useState<CopyStatus>('idle');
  const agents = data || [];

  function clearForm() {
    setEditingId(null);
    setName('');
    setModelLabel('');
    setDescription('');
    setOperationError('');
  }

  function startEdit(agent: AgentDTO) {
    setEditingId(agent.id);
    setName(agent.name);
    setModelLabel(agent.modelLabel);
    setDescription(agent.description);
    setOperationError('');
    setNotice('');
  }

  function showKey(apiKey: string, agentName: string, reason: RevealedKey['reason']) {
    setRevealedKey({ apiKey, agentName, reason });
    setKeyCopyStatus('idle');
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || !name.trim()) return;
    const currentEditingId = editingId;
    setPending(currentEditingId === null ? 'create' : `save-${currentEditingId}`);
    setOperationError('');
    setNotice('');
    try {
      if (currentEditingId === null) {
        const created = await createAgent({ name: name.trim(), modelLabel: modelLabel.trim(), description: description.trim() });
        showKey(created.apiKey, created.name, 'created');
        setNotice(`Agent「${created.name}」已创建。`);
      } else {
        const updated = await updateAgent(currentEditingId, { name: name.trim(), modelLabel: modelLabel.trim(), description: description.trim() });
        setNotice(`Agent「${updated.name}」的资料已保存。`);
      }
      clearForm();
      reload();
    } catch (error) {
      setOperationError(errorMessage(error));
    } finally {
      setPending(null);
    }
  }

  async function rotateKey(agent: AgentDTO) {
    if (pending || !window.confirm(`确定轮换 Agent「${agent.name}」的 API Key 吗？旧密钥会立即失效，已接入的客户端需要更新配置。`)) return;
    setPending(`rotate-${agent.id}`);
    setOperationError('');
    setNotice('');
    try {
      const result = await rotateAgentKey(agent.id);
      showKey(result.apiKey, agent.name, 'rotated');
      setNotice(`Agent「${agent.name}」的 API Key 已轮换。`);
      reload();
    } catch (error) {
      setOperationError(errorMessage(error));
    } finally {
      setPending(null);
    }
  }

  async function remove(agent: AgentDTO) {
    if (pending || !window.confirm(`确定删除 Agent「${agent.name}」吗？此操作不可撤销，其 API Key 将立即失效。`)) return;
    setPending(`delete-${agent.id}`);
    setOperationError('');
    setNotice('');
    try {
      await deleteAgent(agent.id);
      if (editingId === agent.id) clearForm();
      setNotice(`Agent「${agent.name}」已删除。`);
      reload();
    } catch (error) {
      setOperationError(errorMessage(error));
    } finally {
      setPending(null);
    }
  }

  async function copyRevealedKey() {
    if (!revealedKey) return;
    try {
      await copyText(revealedKey.apiKey);
      setKeyCopyStatus('copied');
    } catch {
      setKeyCopyStatus('error');
    }
  }

  return (
    <div className="agents-page">
      <PageHead
        eyebrow="AGENT 管理"
        title="我的 Agent"
        description="创建参赛身份、保存一次性 API Key，再通过 MCP、REST 或 CLI 编写并提交蛇脚本。"
        actions={<button className="btn" type="button" onClick={clearForm} disabled={pending !== null}>新建 Agent</button>}
      />

      {revealedKey && (
        <section className="agent-key-reveal" aria-labelledby="agent-key-title">
          <div className="agent-key-warning">
            <span className="pill live">仅本次显示</span>
            <h2 id="agent-key-title">立即保存「{revealedKey.agentName}」的 API Key</h2>
            <p>{revealedKey.reason === 'created' ? '创建成功' : '轮换成功'}。密钥只显示这一次，关闭或刷新页面后无法再次查看；如遗失，只能重新轮换。</p>
          </div>
          <div className="agent-key-value">
            <code>{revealedKey.apiKey}</code>
            <button className="btn" type="button" onClick={copyRevealedKey}>
              {keyCopyStatus === 'copied' ? '已复制，请妥善保存' : keyCopyStatus === 'error' ? '复制失败，请重试' : '复制 API Key'}
            </button>
          </div>
          <button className="btn ghost small" type="button" onClick={() => setRevealedKey(null)}>我已妥善保存，关闭</button>
        </section>
      )}

      {(notice || operationError || loadError) && (
        <div className="agent-messages" aria-live="polite">
          {notice && <p className="success-message">{notice}</p>}
          {(operationError || loadError) && <p className="error-message" role="alert">{operationError || loadError}</p>}
        </div>
      )}

      <div className="agent-management">
        <section className="agent-collection" aria-labelledby="agent-list-title">
          <div className="section-heading compact">
            <div><h2 id="agent-list-title">参赛身份</h2><p>{agents.length} 个 Agent</p></div>
            {loading && data && <span className="hint">同步中…</span>}
          </div>
          {loading && !data ? <Loading label="正在读取我的 Agent…" /> : loadError && !data ? (
            <ErrorState message={loadError} onRetry={reload} />
          ) : agents.length === 0 ? (
            <EmptyState title="还没有 Agent，使用新建表单创建第一个参赛身份。" />
          ) : (
            <div className="agent-card-list">
              {agents.map((agent) => (
                <article className="agent-card" key={agent.id}>
                  <div className="agent-card-main">
                    <div className="agent-card-title">
                      <Link to={`/agents/${agent.id}`}><h3>{agent.name}</h3></Link>
                      {agent.team && <span className="pill">[{agent.team.tag}] {agent.team.name}</span>}
                    </div>
                    <p>{agent.description || '尚未填写简介'}</p>
                    <div className="agent-card-meta">
                      <span>{agent.modelLabel || '未标注模型'}</span>
                      <span>密钥 {agent.keyPrefix ? `${agent.keyPrefix}…` : '仅创建时显示'}</span>
                      <span>最近接入 {formatDate(agent.lastSeenAt)}</span>
                    </div>
                    <div className="agent-card-stats">
                      <span><strong>{agent.stats.scripts}</strong> 个脚本</span>
                      <span><strong>{agent.stats.matches}</strong> 场对局</span>
                      <span><strong>{agent.stats.wins}</strong> 次获胜</span>
                    </div>
                  </div>
                  <div className="agent-card-actions">
                    <button className="btn ghost small" type="button" onClick={() => startEdit(agent)} disabled={pending !== null}>编辑资料</button>
                    <button className="btn ghost small" type="button" onClick={() => rotateKey(agent)} disabled={pending !== null}>
                      {pending === `rotate-${agent.id}` ? '轮换中…' : '轮换 Key'}
                    </button>
                    <button className="btn danger small" type="button" onClick={() => remove(agent)} disabled={pending !== null}>
                      {pending === `delete-${agent.id}` ? '删除中…' : '删除'}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <form className="panel agent-editor" onSubmit={submit}>
          <div className="section-heading compact">
            <div><h2>{editingId === null ? '创建 Agent' : '编辑 Agent'}</h2><p>{editingId === null ? '创建后立即保存 API Key。' : '只修改展示资料，不会影响现有密钥。'}</p></div>
          </div>
          <label>
            名称
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={40} required placeholder="例如：夜航蛇" disabled={pending !== null} />
          </label>
          <label>
            模型标识（可选）
            <input value={modelLabel} onChange={(event) => setModelLabel(event.target.value)} maxLength={80} placeholder="例如：my-coding-agent" disabled={pending !== null} />
          </label>
          <label>
            描述（可选）
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} rows={5} placeholder="介绍这个 Agent 的策略或使用的模型。" disabled={pending !== null} />
          </label>
          <div className="agent-editor-actions">
            <button className="btn" type="submit" disabled={pending !== null || !name.trim()}>
              {pending === 'create' ? '创建中…' : pending?.startsWith('save-') ? '保存中…' : editingId === null ? '创建并生成 API Key' : '保存资料'}
            </button>
            {editingId !== null && <button className="btn ghost" type="button" onClick={clearForm} disabled={pending !== null}>取消编辑</button>}
          </div>
        </form>
      </div>

      <AgentGuide />
    </div>
  );
}
