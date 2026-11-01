import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BUILTIN_LABEL, getMatch, getMatchReview, getReplay } from '../api';
import { Arena } from '../components/Arena';
import { MatchReviewPanel } from '../components/MatchReviewPanel';
import { useAsync } from '../hooks';
import { useReviewFrame } from '../hooks/useReviewFrame';
import { PLAYBACK_TICK_MS } from '../types';
import type { Frame, FrameEvent, MatchDetailDTO, MatchParticipantDTO, ReplayDTO } from '../types';
import {
  DEATH_LABEL,
  END_LABEL,
  KIND_LABEL,
  MODE_LABEL,
  STATUS_LABEL,
  errorMessage,
  formatDate,
  formatNumber,
} from '../utils';

const SPEEDS = [0.5, 1, 2, 4, 8];

type VisibleEvent = {
  key: string;
  tick: number;
  type: FrameEvent['type'];
  slot?: number;
  message: string;
};

export function MatchPage() {
  const { id = '' } = useParams();
  const matchId = Number(id);
  const validId = /^\d+$/.test(id) && Number.isSafeInteger(matchId) && matchId > 0;
  const [match, setMatch] = useState<MatchDetailDTO | null>(null);
  const [replay, setReplay] = useState<ReplayDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadIndex, setReloadIndex] = useState(0);
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [revealed, setRevealed] = useState(false);
  const [followLive, setFollowLive] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const [reviewSlot, setReviewSlot] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!validId) {
      setMatch(null);
      setReplay(null);
      setPlaying(false);
      setFollowLive(false);
      setLoading(false);
      setError('对局编号无效');
      return;
    }
    setLoading(true);
    setError('');
    setMatch(null);
    setReplay(null);
    Promise.all([getMatch(matchId), getReplay(matchId)]).then(([matchData, replayData]) => {
      if (cancelled) return;
      const now = Date.now();
      const tickMs = validTickMs(replayData.tickMs);
      const maxIndex = Math.max(0, replayData.frames.length - 1);
      const live = isLiveAt(matchData, now);
      setMatch(matchData);
      setReplay(replayData);
      setClock(now);
      setFrameIndex(live ? liveFrameAt(now, replayData.broadcastAt ?? matchData.broadcastAt, tickMs, maxIndex) : 0);
      setFollowLive(live && maxIndex > 0);
      setPlaying(maxIndex > 0);
      setRevealed(false);
      setLoading(false);
    }).catch((reason: unknown) => {
      if (cancelled) return;
      setError(errorMessage(reason));
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [matchId, validId, reloadIndex]);

  useEffect(() => {
    if (!validId) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      getMatch(matchId).then((data) => {
        if (!cancelled) setMatch(data);
      }).catch(() => {});
    }, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [matchId, validId]);

  const tickMs = validTickMs(replay?.tickMs);
  const maxIndex = Math.max(0, (replay?.frames.length ?? 1) - 1);
  const frame = replay?.frames.length ? replay.frames[Math.min(frameIndex, maxIndex)] : undefined;
  const finalTick = replay?.frames[maxIndex]?.tick ?? maxIndex;
  const broadcastAt = replay?.broadcastAt ?? match?.broadcastAt ?? null;
  const playbackMs = match && match.playbackMs > 0 ? match.playbackMs : maxIndex * tickMs;
  const liveActive = Boolean(match?.live && broadcastAt != null && clock < broadcastAt + playbackMs);
  const followingLive = followLive && liveActive;
  const hasFrames = Boolean(replay?.frames.length);
  const reviewEnabled = validId && match?.status === 'done' && !liveActive;
  const {
    data: fetchedReview,
    loading: reviewLoading,
    error: reviewError,
    reload: reloadReview,
  } = useAsync(async () => reviewEnabled ? getMatchReview(matchId, { series: 1 }) : null, [matchId, reviewEnabled]);
  const review = fetchedReview?.matchId === matchId ? fetchedReview : null;
  const reviewPaused = Boolean(review && revealed && !playing && !followingLive && !liveActive);
  const {
    review: frameReview,
    loading: frameReviewLoading,
    error: frameReviewError,
  } = useReviewFrame(matchId, frame?.tick ?? null, reviewSlot, reviewPaused);

  useEffect(() => {
    if (!review || review.participants.some((participant) => participant.slot === reviewSlot)) return;
    const first = review.participants[0];
    if (first) setReviewSlot(first.slot);
  }, [review, reviewSlot]);

  useEffect(() => {
    if (!match?.live || broadcastAt == null || !liveActive) return;
    const sync = () => {
      const now = Date.now();
      setClock(now);
      if (followLive) setFrameIndex(liveFrameAt(now, broadcastAt, tickMs, maxIndex));
    };
    sync();
    const timer = window.setInterval(sync, 100);
    return () => window.clearInterval(timer);
  }, [match?.live, broadcastAt, playbackMs, liveActive, followLive, tickMs, maxIndex]);

  useEffect(() => {
    if (!playing || followingLive || maxIndex <= 0) return;
    let animation = 0;
    let previous: number | null = null;
    let elapsed = 0;
    const animate = (time: number) => {
      if (previous !== null) elapsed += time - previous;
      previous = time;
      const frameMs = tickMs / speed;
      if (elapsed >= frameMs) {
        const steps = Math.max(1, Math.floor(elapsed / frameMs));
        elapsed %= frameMs;
        setFrameIndex((current) => Math.min(maxIndex, current + steps));
      }
      animation = window.requestAnimationFrame(animate);
    };
    animation = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(animation);
  }, [playing, followingLive, maxIndex, tickMs, speed]);

  useEffect(() => {
    if (!hasFrames || frameIndex < maxIndex) return;
    setPlaying(false);
    setFollowLive(false);
    setRevealed(true);
  }, [hasFrames, frameIndex, maxIndex]);

  const visibleEvents = useMemo<VisibleEvent[]>(() => {
    if (!replay) return [];
    const rows: VisibleEvent[] = [];
    replay.frames.slice(0, frameIndex + 1).forEach((item) => {
      item.events.forEach((event, eventIndex) => {
        rows.push({
          key: `${item.tick}-${eventIndex}`,
          tick: item.tick,
          type: event.type,
          slot: event.slot,
          message: event.message,
        });
      });
    });
    return rows.reverse().slice(0, 80);
  }, [replay, frameIndex]);

  function selectFrame(index: number) {
    const next = Math.max(0, Math.min(maxIndex, index));
    setFollowLive(false);
    setPlaying(false);
    setFrameIndex(next);
    if (next < maxIndex) setRevealed(false);
  }

  function seekReviewTick(tick: number) {
    if (!replay) return;
    const index = replay.frames.findIndex((item) => item.tick >= tick);
    selectFrame(index < 0 ? maxIndex : index);
    if (!liveActive) setRevealed(true);
  }

  function togglePlayback() {
    if (playing || followingLive) {
      setPlaying(false);
      setFollowLive(false);
      return;
    }
    if (maxIndex <= 0) return;
    if (frameIndex >= maxIndex) {
      setFrameIndex(0);
      setRevealed(false);
    }
    setFollowLive(false);
    setPlaying(true);
  }

  function resumeLive() {
    if (!liveActive) return;
    const now = Date.now();
    setClock(now);
    setFrameIndex(liveFrameAt(now, broadcastAt, tickMs, maxIndex));
    setFollowLive(true);
    setPlaying(true);
    setRevealed(false);
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!hasFrames || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(target.tagName))) return;
      if (event.code === 'Space') {
        if (event.repeat) return;
        event.preventDefault();
        togglePlayback();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        selectFrame(frameIndex - 1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        selectFrame(frameIndex + 1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hasFrames, playing, followingLive, frameIndex, maxIndex]);

  if (loading) {
    return <div className="shell match-page"><div className="panel match-state" role="status">正在加载对局与回放…</div></div>;
  }
  if (error || !match || !replay) {
    return (
      <div className="shell match-page">
        <div className="panel match-state" role="alert">
          <h2>无法打开回放</h2>
          <p>{error || '未找到这场对局'}</p>
          <div className="toolbar">
            {validId && <button className="btn" onClick={() => setReloadIndex((value) => value + 1)}>重新加载</button>}
            <Link className="btn ghost" to="/">返回大厅</Link>
          </div>
        </div>
      </div>
    );
  }

  if (!frame) {
    return (
      <div className="shell match-page">
        <MatchHeader match={match} liveActive={false} />
        {match.error && <div className="panel flash" role="alert">对局异常：{match.error}</div>}
        <div className="panel match-state">
          <h2>暂无回放帧</h2>
          <p className="hint">这场对局尚未生成可播放的画面，请稍后重试。</p>
          <button className="btn" onClick={() => setReloadIndex((value) => value + 1)}>刷新回放</button>
        </div>
      </div>
    );
  }

  return (
    <div className="shell match-page">
      <MatchHeader match={match} liveActive={liveActive} />
      {match.error && <div className="panel flash match-error" role="alert">对局异常：{match.error}</div>}

      <div className={`play match-layout ${replay.config.maxHp !== null ? 'match-layout-survival' : ''}`}>
        <main className="match-main">
          <div className="cabinet match-cabinet">
            <Arena
              frame={frame}
              config={replay.config}
              players={replay.players}
              overlay={frameReview ? { slot: reviewSlot, options: frameReview.options } : undefined}
            />
            <div className="scan" />
            {followingLive && <div className="match-live-badge">直播中</div>}
          </div>

          <section className="panel match-controls" aria-label="回放控制">
            <div className="toolbar match-playback-buttons">
              <button className="btn ghost" onClick={() => selectFrame(frameIndex - 1)} disabled={frameIndex <= 0}>上一帧</button>
              <button className="btn" onClick={togglePlayback} disabled={maxIndex <= 0}>
                {playing || followingLive ? '暂停' : frameIndex >= maxIndex ? '重新播放' : '播放'}
              </button>
              <button className="btn ghost" onClick={() => selectFrame(frameIndex + 1)} disabled={frameIndex >= maxIndex}>下一帧</button>
              <label className="match-speed">
                倍速
                <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
                  {SPEEDS.map((value) => <option key={value} value={value}>{value}×</option>)}
                </select>
              </label>
              {liveActive && !followingLive && <button className="btn mint" onClick={resumeLive}>回到直播</button>}
              {!revealed && <button className="btn ghost" onClick={() => setRevealed(true)}>手动揭晓结果</button>}
            </div>
            <input
              className="match-progress"
              type="range"
              min={0}
              max={maxIndex}
              step={1}
              value={frameIndex}
              disabled={maxIndex <= 0}
              aria-label="回放进度"
              onChange={(event) => selectFrame(Number(event.target.value))}
            />
            <div className="match-playback-meta">
              <span>第 {frame.tick} / {finalTick} 拍</span>
              <span>{formatClock(frame.tick * tickMs)} / {formatClock(finalTick * tickMs)}</span>
              <span>{followingLive ? '正在按直播时钟同步' : liveActive ? '直播仍在继续' : '空格播放 / 暂停 · 左右键逐帧'}</span>
            </div>
          </section>

          <section className="panel match-events">
            <h3>事件流</h3>
            {visibleEvents.length === 0 ? (
              <p className="hint">当前进度还没有事件。</p>
            ) : (
              <ol className="match-event-list">
                {visibleEvents.map((event) => (
                  <li className={`match-event match-event-${event.type}`} key={event.key}>
                    <span className="match-event-tick">#{event.tick}</span>
                    <span className="match-event-type">{eventTypeLabel(event.type)}</span>
                    <span>{event.message}{event.slot != null ? `（${participantName(match.participants, event.slot)}）` : ''}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </main>

        <aside className="side match-sidebar">
          <ResultPanel match={match} revealed={revealed} onReveal={() => setRevealed(true)} />
          <ParticipantsPanel match={match} frame={frame} revealed={revealed} />
        </aside>
      </div>

      {liveActive || match.status !== 'done' ? (
        <section className="panel review-gate">
          <div className="eyebrow">对局复盘</div><h2>逐拍复盘</h2>
          <p>{liveActive ? '直播结束后可查看完整复盘，避免提前剧透结果。' : '对局完成后可查看完整复盘。'}</p>
        </section>
      ) : !revealed ? (
        <section className="panel review-gate">
          <div className="eyebrow">对局复盘</div><h2>逐拍复盘</h2>
          <p>复盘包含关键时刻、死亡归因和赛果。揭晓结果后即可查看，也可先继续观看回放。</p>
          <button className="btn ghost" onClick={() => setRevealed(true)}>揭晓结果并查看复盘</button>
        </section>
      ) : reviewLoading && !review ? (
        <section className="panel review-gate" role="status"><h2>正在生成复盘视图…</h2><p>回放仍可正常播放。</p></section>
      ) : reviewError && !review ? (
        <section className="panel review-gate review-load-error" role="alert">
          <h2>复盘数据加载失败</h2><p>{reviewError}。原有回放不受影响。</p>
          <button className="btn ghost" onClick={reloadReview}>重试复盘</button>
        </section>
      ) : review ? (
        <MatchReviewPanel
          review={review}
          currentTick={frame.tick}
          selectedSlot={reviewSlot}
          onSelectSlot={setReviewSlot}
          onSeek={seekReviewTick}
          paused={reviewPaused}
          frameReview={frameReview}
          frameLoading={frameReviewLoading}
          frameError={frameReviewError}
        />
      ) : (
        <section className="panel review-gate"><h2>暂无复盘数据</h2><button className="btn ghost" onClick={reloadReview}>重新加载</button></section>
      )}

      <OwnerLogs participants={review?.participants ?? match.participants} currentTick={frame.tick} onSeek={seekReviewTick} />
    </div>
  );
}

function MatchHeader({ match, liveActive }: { match: MatchDetailDTO; liveActive: boolean }) {
  return (
    <header className="topbar match-header">
      <div>
        <Link to="/" className="match-back-link">← 大厅</Link>
        <div className="brand-en match-brand">REPLAY</div>
        <div className="brand-zh">对局 #{match.id} · {MODE_LABEL[match.mode]}{match.teams ? ' · 组队' : ''}</div>
        <div className="brand-sub">
          {KIND_LABEL[match.kind]} / seed {match.seed} / {formatDate(match.createdAt)}
          {match.durationMs != null ? ` / 模拟 ${formatNumber(match.durationMs, 0)}ms` : ''}
        </div>
      </div>
      <div className="match-header-status">
        {liveActive && <span className="pill live">直播中</span>}
        <span className="pill">{STATUS_LABEL[match.status]}</span>
      </div>
    </header>
  );
}

function ResultPanel({ match, revealed, onReveal }: { match: MatchDetailDTO; revealed: boolean; onReveal: () => void }) {
  const winnerNames = match.winners.map((slot) => participantName(match.participants, slot));
  const winningTeam = match.winnerTeam == null ? null : match.participants.find((player) => player.team === match.winnerTeam);
  return (
    <section className={`panel match-result ${revealed ? 'is-revealed' : 'is-hidden'}`}>
      <h3>赛果</h3>
      {!revealed ? (
        <>
          <p className="hint">结果将在播放结束后自动揭晓，避免提前剧透。</p>
          <button className="btn ghost" onClick={onReveal}>提前揭晓</button>
        </>
      ) : (
        <>
          <strong className="match-winner">
            {match.winnerTeam != null
              ? `${teamLabel(match.winnerTeam, winningTeam?.teamName)}获胜`
              : winnerNames.length > 0 ? `${winnerNames.join(' / ')} 获胜` : '本场平局'}
          </strong>
          <div className="hint">{match.endReason ? END_LABEL[match.endReason] : STATUS_LABEL[match.status]}</div>
          {match.winnerTeam != null && winnerNames.length > 0 && <div className="hint">获胜成员：{winnerNames.join(' / ')}</div>}
        </>
      )}
    </section>
  );
}

function ParticipantsPanel({ match, frame, revealed }: { match: MatchDetailDTO; frame: Frame; revealed: boolean }) {
  if (!match.teams) {
    return (
      <section className="panel match-participants">
        <h3>参赛者</h3>
        {match.participants.map((participant) => (
          <ParticipantCard key={participant.slot} participant={participant} frame={frame} revealed={revealed} maxHp={match.config.maxHp} />
        ))}
      </section>
    );
  }
  return (
    <section className="panel match-participants">
      <h3>队伍与参赛者</h3>
      {[0, 1].map((team) => {
        const members = match.participants.filter((participant) => participant.team === team);
        if (members.length === 0) return null;
        const teamName = members.find((member) => member.teamName)?.teamName ?? null;
        const score = members.reduce((total, member) => total + (frame.snakes.find((snake) => snake.slot === member.slot)?.score ?? 0), 0);
        const alive = members.filter((member) => frame.snakes.find((snake) => snake.slot === member.slot)?.alive).length;
        return (
          <div className={`match-team match-team-${team}`} key={team}>
            <div className="match-team-heading">
              <strong>{teamLabel(team, teamName)}</strong>
              <span>{score} 分 · {alive}/{members.length} 存活</span>
            </div>
            {members.map((participant) => (
              <ParticipantCard key={participant.slot} participant={participant} frame={frame} revealed={revealed} maxHp={match.config.maxHp} />
            ))}
          </div>
        );
      })}
    </section>
  );
}

function ParticipantCard({ participant, frame, revealed, maxHp }: { participant: MatchParticipantDTO; frame: Frame; revealed: boolean; maxHp: number | null }) {
  const snake = frame.snakes.find((item) => item.slot === participant.slot);
  const health = snake && typeof snake.hp === 'number' && Number.isFinite(snake.hp) && maxHp !== null && maxHp > 0
    ? { value: snake.hp, max: maxHp, percent: Math.max(0, Math.min(100, (snake.hp / maxHp) * 100)) }
    : null;
  const script = participant.scriptName
    ? `${participant.scriptName} · ${participant.version == null ? '版本 —' : `v${participant.version}`}`
    : participant.builtin ? BUILTIN_LABEL[participant.builtin] : '未绑定脚本';
  return (
    <article className={`match-participant ${snake?.alive === false ? 'is-dead' : ''}`}>
      <div className="match-participant-title">
        <span className="match-player-name">
          <i className="dot" style={{ background: participant.color }} />
          {participant.name}
        </span>
        {revealed && participant.rank != null && <span className="pill">第 {participant.rank} 名</span>}
      </div>
      <div className="match-participant-source">
        <span>Agent：{participant.agentId != null
          ? <Link to={`/agents/${participant.agentId}`}>{participant.agentName || `#${participant.agentId}`}</Link>
          : participant.agentName || '内置选手'}</span>
        <span>脚本：{script}</span>
        {matchTeamName(participant) && <span>队伍：{matchTeamName(participant)}</span>}
      </div>
      <div className="match-participant-stats">
        <span><b>{snake?.score ?? '—'}</b> 分</span>
        <span>长度 <b>{snake?.length ?? '—'}</b></span>
        <span className={snake?.alive ? 'is-alive' : 'is-dead'}>
          {snake ? snake.alive ? '存活' : `阵亡${participant.deathReason ? ` · ${DEATH_LABEL[participant.deathReason]}` : ''}` : '无帧数据'}
        </span>
      </div>
      {health && (
        <div className={`match-health ${health.value <= 25 ? 'is-low' : ''}`}>
          <div className="match-health-heading">
            <span>生命值</span>
            <strong>{formatNumber(health.value)} / {formatNumber(health.max)}</strong>
          </div>
          <div
            className="match-health-track"
            role="progressbar"
            aria-label={`${participant.name}生命值`}
            aria-valuemin={0}
            aria-valuemax={health.max}
            aria-valuenow={health.value}
          >
            <i style={{ width: `${health.percent}%` }} />
          </div>
          {health.value <= 25 && <span className="match-health-warning">生命值偏低，需要尽快进食</span>}
        </div>
      )}
      <div className="match-participant-metrics">
        <span>耗时 平均 {formatNumber(participant.avgMoveMs, 1)}ms / 峰值 {formatNumber(participant.maxMoveMs, 1)}ms</span>
        <span>击杀 {participant.kills} · 超时 {participant.timeouts} · 错误 {participant.errors}</span>
        <span>评分 {revealed ? ratingText(participant) : '结果揭晓后可见'}</span>
      </div>
      {participant.firstError && (
        <details className="match-first-error">
          <summary>首次错误</summary>
          <pre>{participant.firstError}</pre>
        </details>
      )}
    </article>
  );
}

function OwnerLogs({ participants, currentTick, onSeek }: {
  participants: Array<Pick<MatchParticipantDTO, 'slot' | 'name' | 'logs'>>;
  currentTick: number;
  onSeek: (tick: number) => void;
}) {
  const withLogs = participants.filter((participant) => participant.logs && participant.logs.length > 0);
  if (withLogs.length === 0) return null;
  return (
    <section className="panel match-owner-logs">
      <h3>所有者日志</h3>
      <p className="hint">仅脚本所有者可见；优先显示当前第 {currentTick} 拍前后 12 拍的日志，点击拍号跳拍并暂停。</p>
      {withLogs.map((participant) => {
        const logs = participant.logs ?? [];
        const nearby = logs.filter((log) => Math.abs(log.tick - currentTick) <= 12);
        const aligned = (nearby.length > 0 ? nearby : logs.slice().sort((a, b) => (
          Math.abs(a.tick - currentTick) - Math.abs(b.tick - currentTick) || a.tick - b.tick
        )).slice(0, 16)).slice().sort((a, b) => a.tick - b.tick);
        return (
          <details key={participant.slot}>
            <summary>{participant.name} · 共 {logs.length} 条 · 当前显示 {aligned.length} 条</summary>
            {nearby.length === 0 && <p className="hint">当前拍附近没有日志，改显示最接近的条目。</p>}
            <ol>
              {aligned.map((log, index) => (
                <li key={`${log.tick}-${index}`}>
                  <button className="match-log-seek" onClick={() => onSeek(log.tick)} aria-label={`跳到第 ${log.tick} 拍`}>#{log.tick}</button>
                  <pre>{log.text}</pre>
                </li>
              ))}
            </ol>
          </details>
        );
      })}
    </section>
  );
}

function ratingText(participant: MatchParticipantDTO): string {
  if (participant.ratingBefore == null && participant.ratingAfter == null) return '未计分';
  const delta = participant.ratingBefore != null && participant.ratingAfter != null
    ? participant.ratingAfter - participant.ratingBefore
    : null;
  const change = delta == null ? '' : `（${delta > 0 ? '+' : ''}${formatNumber(delta)}）`;
  return `${formatNumber(participant.ratingBefore)} → ${formatNumber(participant.ratingAfter)}${change}`;
}

function validTickMs(value: number | undefined): number {
  return value != null && Number.isFinite(value) && value > 0 ? value : PLAYBACK_TICK_MS;
}

function isLiveAt(match: MatchDetailDTO, now: number): boolean {
  return Boolean(match.live && match.broadcastAt != null && now < match.broadcastAt + match.playbackMs);
}

function liveFrameAt(now: number, broadcastAt: number | null, tickMs: number, maxIndex: number): number {
  if (broadcastAt == null || maxIndex <= 0) return 0;
  return Math.max(0, Math.min(maxIndex, Math.floor((now - broadcastAt) / tickMs)));
}

function participantName(participants: MatchParticipantDTO[], slot: number): string {
  return participants.find((participant) => participant.slot === slot)?.name ?? `槽位 ${slot}`;
}

function matchTeamName(participant: MatchParticipantDTO): string | null {
  if (participant.team == null) return null;
  return teamLabel(participant.team, participant.teamName);
}

function teamLabel(team: number, name: string | null | undefined): string {
  return name ? `${name}（队伍 ${team + 1}）` : `队伍 ${team + 1}`;
}

function eventTypeLabel(type: FrameEvent['type']): string {
  if (type === 'eat') return '进食';
  if (type === 'die') return '阵亡';
  return '胜利';
}

function formatClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
