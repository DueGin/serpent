import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { addScriptVersion, createMatch, dryRunScript, getScenarios, getScript, getScriptVersion, joinLadder, listLadders, updateScript } from '../api';
import { EmptyState, ErrorState, Loading, PageHead } from '../components/StateView';
import { useAsync } from '../hooks';
import type { DryRunResult } from '../types';
import { errorMessage, formatDate, formatNumber, formatPercent, VERSION_LABEL, VISIBILITY_LABEL } from '../utils';

export function ScriptPage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const { data: script, loading, error, reload } = useAsync(() => getScript(id), [id]);
  const [selected, setSelected] = useState<number | null>(null);
  const { data: fetchedVersion, loading: versionLoading } = useAsync(async () => selected ? getScriptVersion(id, selected) : null, [id, selected]);
  const { data: scenarios } = useAsync(async () => (await getScenarios()).data, []);
  const { data: ladders } = useAsync(async () => (await listLadders()).data, []);
  const [scenario, setScenario] = useState('solo-open');
  const [dryResult, setDryResult] = useState<DryRunResult | null>(null);
  const [newCode, setNewCode] = useState('');
  const [note, setNote] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [ladderSlug, setLadderSlug] = useState('battle');
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (script) setSelected((current) => current && script.versions.some((version) => version.version === current) ? current : script.activeVersion || script.latestVersion);
  }, [script]);

  const summaryVersion = script?.versions.find((version) => version.version === selected) || null;
  const version = fetchedVersion?.version === selected ? fetchedVersion : summaryVersion;
  const code = fetchedVersion?.version === selected && fetchedVersion.code !== undefined
    ? fetchedVersion.code
    : selected === script?.activeVersion ? script.code : undefined;

  useEffect(() => {
    if (code !== undefined && !editorOpen) setNewCode(code);
  }, [code, editorOpen]);

  async function action(name: string, task: () => Promise<void>) {
    setBusy(name);
    setActionError('');
    setNotice('');
    try { await task(); }
    catch (reason) { setActionError(errorMessage(reason)); }
    finally { setBusy(''); }
  }

  if (loading && !script) return <Loading label="读取脚本档案…" />;
  if (error && !script) return <ErrorState message={error} onRetry={reload} />;
  if (!script) return null;

  const canCompete = Boolean(script.activeVersion && script.versions.find((item) => item.version === script.activeVersion)?.status === 'valid');
  return (
    <div className="script-page">
      <PageHead eyebrow={`SCRIPT / #${script.id}`} title={script.name} description={script.description || '暂无脚本说明'} actions={<Link to={`/agents/${script.agentId}`} className="btn ghost small">← {script.agentName}</Link>} />
      <div className="script-meta-bar">
        <span className={`pill ${script.latestStatus}`}>{VERSION_LABEL[script.latestStatus]}</span>
        <span>{VISIBILITY_LABEL[script.visibility]}</span><span>生效 {script.activeVersion ? `v${script.activeVersion}` : '未设置'}</span><span>最新 v{script.latestVersion}</span><span>更新于 {formatDate(script.updatedAt)}</span>
      </div>

      <div className="script-layout">
        <aside className="version-rail">
          <div className="eyebrow">IMMUTABLE VERSIONS</div><h2>版本</h2>
          <div className="version-list">{script.versions.slice().sort((a, b) => b.version - a.version).map((item) => <button key={item.version} className={selected === item.version ? 'active' : ''} onClick={() => { setSelected(item.version); setDryResult(null); }}><span className={`status-dot ${item.status}`} /><strong>v{item.version}</strong><small>{formatDate(item.createdAt)}</small>{item.version === script.activeVersion && <i>ACTIVE</i>}</button>)}</div>
          {script.canEdit && <button className="btn ghost wide" onClick={() => { if (code !== undefined) setNewCode(code); setEditorOpen(!editorOpen); }}>{editorOpen ? '收起新版本' : '＋ 粘贴新版本'}</button>}
        </aside>

        <div className="script-main">
          {actionError && <div className="form-error">{actionError}</div>}
          {notice && <div className="form-notice">{notice}</div>}
          {editorOpen && script.canEdit && <section className="panel code-editor-panel">
            <div className="panel-heading"><div><div className="eyebrow">NEW SNAPSHOT</div><h2>提交不可变新版本</h2></div><span>≤ 64 KB</span></div>
            <textarea className="code-editor" spellCheck={false} value={newCode} onChange={(event) => setNewCode(event.target.value)} placeholder="function move(state) { ... }" />
            <div className="form-grid version-note"><label>版本说明<input value={note} onChange={(event) => setNote(event.target.value)} placeholder="这次改了什么？" /></label><button className="btn" disabled={!newCode.trim() || busy === 'version'} onClick={() => action('version', async () => { const created = await addScriptVersion(id, { code: newCode, note, activate: true }); setNotice(`v${created.version} 已提交，检测${created.status === 'valid' ? '通过并可参赛' : created.status === 'invalid' ? '未通过' : '进行中'}。`); setNote(''); setEditorOpen(false); reload(); setSelected(created.version); })}>{busy === 'version' ? '检测中…' : '检测并提交版本'}</button></div>
          </section>}

          <section className="panel report-panel">
            <div className="panel-heading"><div><div className="eyebrow">VALIDATION REPORT</div><h2>v{selected || '—'} 检测报告</h2></div>{version && <span className={`report-verdict ${version.status}`}>{VERSION_LABEL[version.status]}</span>}</div>
            {versionLoading && !version ? <Loading label="读取报告…" /> : version?.report ? <>
              {version.report.stats && <div className="report-stats"><div><span>单人平均分</span><strong>{formatNumber(version.report.stats.soloAvgScore, 1)}</strong></div><div><span>对 Greedy 胜率</span><strong>{formatPercent(version.report.stats.battleWinRateVsGreedy)}</strong></div><div><span>平均耗时</span><strong>{formatNumber(version.report.stats.avgMoveMs, 2)} ms</strong></div><div><span>检测耗时</span><strong>{formatNumber(version.report.durationMs / 1000, 2)} s</strong></div></div>}
              <div className="check-list">{version.report.items.map((item) => <div className={`check-item ${item.status}`} key={item.id}><span className="check-icon">{item.status === 'pass' ? '✓' : item.status === 'warn' ? '!' : '×'}</span><div><strong>{item.label}</strong><small>{item.id}</small>{item.detail && <p>{item.detail}</p>}</div><b>{item.status === 'pass' ? '通过' : item.status === 'warn' ? '警告' : '失败'}</b></div>)}</div>
            </> : <EmptyState title={version?.status === 'pending' ? '检测仍在进行，请稍后刷新' : '这个版本没有检测报告'} />}
            {version?.note && <blockquote className="version-note-text">{version.note}</blockquote>}
          </section>

          <section className="panel code-panel">
            <div className="panel-heading"><div><div className="eyebrow">SOURCE CODE</div><h2>代码快照</h2></div>{version && <span>{formatNumber(version.size)} B · {version.codeHash.slice(0, 12)}</span>}</div>
            {code !== undefined ? <pre className="code-view"><code>{code}</code></pre> : <EmptyState title="此脚本的代码不公开"><span className="hint">你仍可查看元数据、检测结果，并选择它作为对手。</span></EmptyState>}
          </section>
        </div>

        <aside className="script-actions">
          {script.canEdit && <>
            <section className="panel"><div className="eyebrow">CONTROL</div><h2>版本控制</h2>{selected && <button className="btn ghost wide" disabled={selected === script.activeVersion || version?.status !== 'valid' || busy === 'activate'} onClick={() => action('activate', async () => { await updateScript(id, { activeVersion: selected }); setNotice(`已切换为 v${selected}。`); reload(); })}>{selected === script.activeVersion ? '当前生效版本' : '设为生效版本'}</button>}<label>可见性<select value={script.visibility} disabled={busy === 'visibility'} onChange={(event) => action('visibility', async () => { await updateScript(id, { visibility: event.target.value as typeof script.visibility }); setNotice('可见性已更新。'); reload(); })}><option value="private">私有</option><option value="listed">公开挑战</option><option value="open">代码公开</option></select></label></section>
            <section className="panel"><div className="eyebrow">ONE TICK LAB</div><h2>场景试跑</h2><label>测试场景<select value={scenario} onChange={(event) => setScenario(event.target.value)}>{(scenarios || [{ id: 'solo-open', title: '开放场地' }]).map((item) => <option key={item.id} value={item.id}>{item.title || item.id}</option>)}</select></label><button className="btn wide" disabled={!selected || busy === 'dry'} onClick={() => action('dry', async () => setDryResult(await dryRunScript({ scriptId: id, version: selected || undefined, scenario })))}>{busy === 'dry' ? '沙箱运行中…' : '运行当前版本 →'}</button>{dryResult && <div className={dryResult.ok ? 'dry-result ok' : 'dry-result fail'}><strong>{dryResult.ok ? `方向：${dryResult.direction}` : '试跑失败'}</strong><span>init {formatNumber(dryResult.initMs, 2)}ms · move {formatNumber(dryResult.moveMs, 2)}ms</span><span>{dryResult.legal ? '返回方向合法' : '返回方向不在 legalMoves 中'}</span>{dryResult.error && <p>{dryResult.error}</p>}{dryResult.logs.length > 0 && <pre>{dryResult.logs.join('\n')}</pre>}</div>}</section>
            <section className="panel"><div className="eyebrow">TEST MATCH</div><h2>快速测试赛</h2><p className="hint">使用生效版本，与内置 Greedy 进行一场私密生存战。</p><button className="btn wide" disabled={!canCompete || busy === 'test'} onClick={() => action('test', async () => { const match = await createMatch({ kind: 'test', mode: 'battle', participants: [{ scriptId: id }, { builtin: 'greedy' }], agentId: script.agentId, wait: true }); navigate(`/matches/${match.id}`); })}>{busy === 'test' ? '正在模拟…' : '挑战 Greedy →'}</button></section>
          </>}
          <section className="panel"><div className="eyebrow">LADDER ENTRY</div><h2>天梯入场</h2>{script.ladders.length > 0 && <div className="entry-chips">{script.ladders.map((entry) => <Link to={`/ladders/${entry.slug}`} key={entry.entryId}><span>{entry.slug}</span><strong>{Math.round(entry.rating)}</strong><small>{entry.rank ? `#${entry.rank}` : '未排名'}</small></Link>)}</div>}{script.canEdit && <><label>选择个人天梯<select value={ladderSlug} onChange={(event) => setLadderSlug(event.target.value)}>{(ladders || []).filter((item) => item.kind !== 'team').map((item) => <option key={item.slug} value={item.slug}>{item.name}</option>)}</select></label><button className="btn ghost wide" disabled={!canCompete || busy === 'join'} onClick={() => action('join', async () => { await joinLadder(ladderSlug, { scriptId: id }); setNotice('已入场，后台匹配器会自动安排对局。'); reload(); })}>{busy === 'join' ? '入场中…' : '以生效版本入场'}</button></>}</section>
        </aside>
      </div>
    </div>
  );
}
