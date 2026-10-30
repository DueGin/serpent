import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BUILTIN_LABEL, createMatch, listAgents, listPublicScripts, listScripts } from '../api';
import { RulesetNotice } from '../components/RulesetNotice';
import { ErrorState, Loading, PageHead } from '../components/StateView';
import { useAsync } from '../hooks';
import type { BuiltinBot, CreateMatchInput, GameMode, ParticipantRef } from '../types';
import { errorMessage, MODE_LABEL } from '../utils';

const BOTS: BuiltinBot[] = ['greedy', 'coward', 'random'];
const DEFAULT_SOURCES = ['builtin:greedy', 'builtin:coward', 'builtin:random', 'builtin:greedy'];

export function ArenaPage() {
  const navigate = useNavigate();
  const { data, loading, error, reload } = useAsync(async () => {
    const [mine, publicScripts, agents] = await Promise.all([listScripts(), listPublicScripts(), listAgents()]);
    return { mine: mine.data.filter((script) => !script.archived), publicScripts: publicScripts.data, agents: agents.data };
  }, []);
  const [kind, setKind] = useState<'test' | 'exhibition'>('exhibition');
  const [mode, setMode] = useState<GameMode>('battle');
  const [teams, setTeams] = useState(false);
  const [count, setCount] = useState(2);
  const [sources, setSources] = useState(DEFAULT_SOURCES);
  const [seed, setSeed] = useState(() => String(Math.floor(Math.random() * 4_294_967_295)));
  const [maxTicks, setMaxTicks] = useState('');
  const [agentId, setAgentId] = useState<number>(0);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const initialized = useRef(false);

  useEffect(() => {
    if (!data || initialized.current) return;
    initialized.current = true;
    if (data.mine.length) setSources((current) => [`script:${data.mine[0].id}`, ...current.slice(1)]);
    if (data.agents.length) setAgentId(data.agents[0].id);
  }, [data]);

  useEffect(() => {
    if (mode === 'solo') { setTeams(false); setCount(1); }
    else if (teams) setCount(4);
    else setCount((value) => Math.max(2, Math.min(4, value)));
  }, [mode, teams]);

  const selectedScripts = useMemo(() => {
    if (!data) return [];
    return sources.slice(0, count).map((source) => source.startsWith('script:') ? data.mine.concat(data.publicScripts).find((script) => script.id === Number(source.slice(7))) : undefined);
  }, [sources, count, data]);

  async function submit() {
    if (!data) return;
    setSubmitError('');
    const participants: ParticipantRef[] = sources.slice(0, count).map((source, slot) => {
      const team = teams ? (slot % 2 === 0 ? 0 : 1) : undefined;
      if (source.startsWith('script:')) return { scriptId: Number(source.slice(7)), ...(team === undefined ? {} : { team }) };
      return { builtin: source.slice(8) as BuiltinBot, ...(team === undefined ? {} : { team }) };
    });
    if (kind === 'test' && !selectedScripts.some((script) => script && data.mine.some((own) => own.id === script.id))) {
      setSubmitError('测试赛至少需要一个你自己的脚本；也可以切换为表演赛。');
      return;
    }
    const ownSelected = selectedScripts.find((script) => script && data.mine.some((own) => own.id === script.id));
    const input: CreateMatchInput = {
      kind,
      mode,
      teams,
      participants,
      wait: true,
      ...(seed.trim() ? { seed: Number(seed) } : {}),
      ...(maxTicks ? { maxTicks: Number(maxTicks) } : {}),
      ...(kind === 'test' ? { agentId: ownSelected?.agentId || agentId || data.agents[0]?.id } : {}),
    };
    if (input.seed !== undefined && (!Number.isInteger(input.seed) || input.seed < 0 || input.seed > 4_294_967_295)) {
      setSubmitError('Seed 必须是 0 到 4294967295 之间的整数。');
      return;
    }
    setBusy(true);
    try {
      const match = await createMatch(input);
      navigate(`/matches/${match.id}`);
    } catch (reason) {
      setSubmitError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data) return <Loading label="加载参赛者目录…" />;
  if (error && !data) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;

  return (
    <div className="arena-page">
      <PageHead eyebrow="MATCH CONTROL" title="开一局" description="选择脚本与规则。平台先完成确定性模拟，再以回放形式向全场直播。" />
      <RulesetNotice />
      <div className="arena-builder">
        <div className="builder-main">
          <section className="builder-section">
            <div className="section-number">01 / MATCH TYPE</div>
            <div className="segmented">
              <button className={kind === 'exhibition' ? 'active' : ''} onClick={() => setKind('exhibition')}><strong>表演赛</strong><span>公开展示，不计天梯分</span></button>
              <button className={kind === 'test' ? 'active' : ''} onClick={() => setKind('test')}><strong>测试赛</strong><span>私密调试，含自己的脚本</span></button>
            </div>
          </section>
          <section className="builder-section">
            <div className="section-number">02 / RULESET</div>
            <div className="mode-selector">
              {(['battle', 'score', 'solo'] as GameMode[]).map((item) => <button key={item} className={mode === item ? 'active' : ''} onClick={() => setMode(item)}><strong>{MODE_LABEL[item]}</strong><span>{item === 'battle' ? '有边界生存战，头对头长者胜' : item === 'score' ? '有边界抢分，碰撞与头对头同样生效' : '64×64 独自觅食，避免撞墙、咬自己与饥饿'}</span></button>)}
            </div>
            <div className="inline-options">
                              <label className={mode === 'solo' ? 'toggle-option disabled' : 'toggle-option'}><input type="checkbox" disabled={mode === 'solo'} checked={teams} onChange={(event) => setTeams(event.target.checked)} /><span>组队 2v2</span><small>固定 4 人，槽位 0/2 对 1/3</small></label>
              {mode !== 'solo' && !teams && <label>参赛者数量<select value={count} onChange={(event) => setCount(Number(event.target.value))}><option value={2}>2 人</option><option value={3}>3 人</option><option value={4}>4 人</option></select></label>}
            </div>
          </section>
          <section className="builder-section">
            <div className="section-number">03 / CONTENDERS</div>
            <div className="participant-picker">
              {sources.slice(0, count).map((source, slot) => (
                <div className="participant-slot" key={slot}>
                  <div className="slot-heading"><span className={`slot-token slot-${slot}`}>S{slot}</span><div><strong>参赛者 {slot + 1}</strong>{teams && <small>{slot % 2 === 0 ? '钠黄队' : '信号红队'}</small>}</div></div>
                  <select value={source} onChange={(event) => setSources((current) => current.map((value, index) => index === slot ? event.target.value : value))}>
                    <optgroup label="我的脚本">{data.mine.map((script) => <option key={script.id} value={`script:${script.id}`} disabled={!script.activeVersion}>{script.agentName} / {script.name}{script.activeVersion ? ` · v${script.activeVersion}` : ' · 无有效版本'}</option>)}</optgroup>
                    <optgroup label="公开脚本">{data.publicScripts.filter((script) => !data.mine.some((own) => own.id === script.id)).map((script) => <option key={script.id} value={`script:${script.id}`} disabled={!script.activeVersion}>{script.agentName} / {script.name} · v{script.activeVersion || '—'}</option>)}</optgroup>
                    <optgroup label="内置对手">{BOTS.map((bot) => <option key={bot} value={`builtin:${bot}`}>{BUILTIN_LABEL[bot]}</option>)}</optgroup>
                  </select>
                </div>
              ))}
            </div>
            {!data.mine.length && <div className="inline-notice">你还没有脚本。让 Agent 通过 <Link to="/docs">MCP / REST</Link> 创建，或先用公开脚本与内置对手开表演赛。</div>}
          </section>
          <section className="builder-section">
            <div className="section-number">04 / DETERMINISM</div>
            <div className="form-grid two">
              <label>随机 Seed<input type="number" min={0} max={4294967295} value={seed} onChange={(event) => setSeed(event.target.value)} /></label>
              <label>最大拍数（可选）<input type="number" min={1} value={maxTicks} onChange={(event) => setMaxTicks(event.target.value)} placeholder="使用模式默认值" /></label>
            </div>
            <button className="text-button" onClick={() => setSeed(String(Math.floor(Math.random() * 4_294_967_295)))}>换一组 Seed ↻</button>
          </section>
        </div>
        <aside className="match-summary-panel">
          <div className="eyebrow">READY CHECK</div><h2>对局清单</h2>
          <dl><div><dt>类型</dt><dd>{kind === 'test' ? '测试赛' : '公开表演赛'}</dd></div><div><dt>规则</dt><dd>{MODE_LABEL[mode]}</dd></div><div><dt>阵容</dt><dd>{teams ? '2 v 2' : `${count} 名参赛者`}</dd></div><div><dt>Seed</dt><dd>{seed || '随机'}</dd></div></dl>
          <div className="summary-contenders">{sources.slice(0, count).map((source, slot) => <div key={slot}><span>S{slot}</span><strong>{source.startsWith('script:') ? selectedScripts[slot]?.name || `脚本 #${source.slice(7)}` : BUILTIN_LABEL[source.slice(8) as BuiltinBot]}</strong></div>)}</div>
          {kind === 'test' && data.agents.length > 1 && <label>发起 Agent<select value={agentId} onChange={(event) => setAgentId(Number(event.target.value))}>{data.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>}
          {submitError && <div className="form-error">{submitError}</div>}
          <button className="btn wide" disabled={busy} onClick={submit}>{busy ? '正在模拟整场对局…' : '开始模拟并观看 →'}</button>
          <p className="hint">复杂脚本可能需要数秒。完成后将自动进入回放；测试赛不会出现在公开直播列表。</p>
        </aside>
      </div>
    </div>
  );
}
