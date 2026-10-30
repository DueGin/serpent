import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { createScript, SCRIPT_TEMPLATES, validateScript } from '../api';
import type { AgentDTO, CheckReport, ScriptLanguage, ScriptVisibility } from '../types';
import { errorMessage, SCRIPT_LANGUAGE_LABEL } from '../utils';
import { EmptyState } from './StateView';

const SCRIPT_LANGUAGES: ScriptLanguage[] = ['javascript', 'python'];

export function ScriptCreatePanel({ agents, onCreated }: { agents: AgentDTO[]; onCreated: () => void }) {
  const navigate = useNavigate();
  const [agentId, setAgentId] = useState(0);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<ScriptVisibility>('listed');
  const [language, setLanguage] = useState<ScriptLanguage>('javascript');
  const [code, setCode] = useState(SCRIPT_TEMPLATES.javascript);
  const [busy, setBusy] = useState<'validate' | 'create' | ''>('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [report, setReport] = useState<CheckReport | null>(null);

  useEffect(() => {
    if (agents.some((agent) => agent.id === agentId)) return;
    setAgentId(agents[0]?.id ?? 0);
  }, [agents, agentId]);

  function changeLanguage(next: ScriptLanguage) {
    if (next === language) return;
    const preserveCode = Boolean(code.trim()) && code !== SCRIPT_TEMPLATES[language];
    if (!preserveCode) setCode(SCRIPT_TEMPLATES[next]);
    setLanguage(next);
    setReport(null);
    setNotice(preserveCode ? '已保留当前代码，请确认它与所选语言一致。' : `已填入 ${SCRIPT_LANGUAGE_LABEL[next]} 模板。`);
    setError('');
  }

  async function validate() {
    if (busy || !code.trim()) return;
    setBusy('validate');
    setError('');
    setNotice('');
    setReport(null);
    try {
      const result = await validateScript(code, language);
      setReport(result);
      setNotice(result.ok ? '检测通过，可以创建脚本。' : '检测完成，请按报告修复后再创建。');
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy('');
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !agentId || !name.trim() || !code.trim()) return;
    setBusy('create');
    setError('');
    setNotice('');
    try {
      const created = await createScript({
        agentId,
        name: name.trim(),
        description: description.trim(),
        visibility,
        code,
        language,
      });
      onCreated();
      navigate(`/scripts/${created.id}`);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy('');
    }
  }

  return (
    <section className="panel script-create-panel" aria-labelledby="script-create-title">
      <div className="section-heading">
        <div>
          <div className="eyebrow">SCRIPT WORKBENCH</div>
          <h2 id="script-create-title">创建脚本</h2>
          <p>选择语言并提交首版代码。语言创建后不可修改，Python 与 JavaScript 使用相同的对局状态字段。</p>
        </div>
      </div>
      {agents.length === 0 ? (
        <EmptyState title="请先创建一个 Agent，再为它编写脚本。" />
      ) : (
        <form className="script-create-form" onSubmit={submit}>
          <div className="form-grid two">
            <label>所属 Agent
              <select value={agentId} disabled={busy !== ''} onChange={(event) => setAgentId(Number(event.target.value))}>
                {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              </select>
            </label>
            <label>脚本名称
              <input value={name} maxLength={60} required disabled={busy !== ''} onChange={(event) => setName(event.target.value)} placeholder="例如：疾风觅食者" />
            </label>
          </div>
          <label>脚本简介（可选）
            <textarea value={description} maxLength={500} rows={3} disabled={busy !== ''} onChange={(event) => setDescription(event.target.value)} placeholder="简述觅食、避障与头对头策略。" />
          </label>
          <div className="form-grid two script-create-options">
            <fieldset className="script-language-field" disabled={busy !== ''}>
              <legend>脚本语言（创建后不可改）</legend>
              <div className="script-language-options" role="group" aria-label="脚本语言">
                {SCRIPT_LANGUAGES.map((item) => (
                  <button
                    type="button"
                    key={item}
                    className={language === item ? 'active' : ''}
                    aria-pressed={language === item}
                    onClick={() => changeLanguage(item)}
                  >
                    <strong>{SCRIPT_LANGUAGE_LABEL[item]}</strong>
                    <span>{item === 'python' ? 'Pyodide / CPython' : 'QuickJS'}</span>
                  </button>
                ))}
              </div>
            </fieldset>
            <label>可见性
              <select
                value={visibility}
                disabled={busy !== ''}
                onChange={(event) => {
                  const value = event.target.value;
                  setVisibility(value === 'private' || value === 'open' ? value : 'listed');
                }}
              >
                <option value="private">私有</option>
                <option value="listed">公开挑战</option>
                <option value="open">代码公开</option>
              </select>
            </label>
          </div>
          <div className="script-create-code">
            <div className="code-editor-tools">
              <span className={`script-language-badge ${language}`}>{SCRIPT_LANGUAGE_LABEL[language]}</span>
              <span>首版代码 ≤ 64 KB</span>
              <button className="text-button" type="button" disabled={busy !== ''} onClick={() => { setCode(SCRIPT_TEMPLATES[language]); setReport(null); setNotice(''); }}>填入语言模板</button>
            </div>
            <textarea
              className="code-editor"
              spellCheck={false}
              value={code}
              disabled={busy !== ''}
              onChange={(event) => { setCode(event.target.value); setReport(null); setNotice(''); }}
              placeholder={language === 'python' ? 'def move(state):\n    ...' : 'function move(state) { ... }'}
              aria-label={`${SCRIPT_LANGUAGE_LABEL[language]} 脚本代码`}
            />
          </div>
          {error && <div className="form-error" role="alert">{error}</div>}
          {notice && <div className="form-notice" role="status">{notice}</div>}
          {report && (
            <div className="check-list script-create-report">
              {report.items.map((item) => (
                <div className={`check-item ${item.status}`} key={item.id}>
                  <span className="check-icon">{item.status === 'pass' ? '✓' : item.status === 'warn' ? '!' : '×'}</span>
                  <div><strong>{item.label}</strong><small>{item.id}</small>{item.detail && <p>{item.detail}</p>}</div>
                  <b>{item.status === 'pass' ? '通过' : item.status === 'warn' ? '警告' : '失败'}</b>
                </div>
              ))}
            </div>
          )}
          <div className="form-actions">
            <button className="btn ghost" type="button" disabled={busy !== '' || !code.trim()} onClick={validate}>
              {busy === 'validate' ? '检测中…' : '仅检测代码'}
            </button>
            <button className="btn" type="submit" disabled={busy !== '' || !agentId || !name.trim() || !code.trim()}>
              {busy === 'create' ? '检测并创建中…' : '检测并创建脚本'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
