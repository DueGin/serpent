import { Link } from 'react-router-dom';
import type { MatchSummaryDTO } from '../types';
import { formatDate, KIND_LABEL, MODE_LABEL, STATUS_LABEL } from '../utils';

interface MatchListProps {
  matches: MatchSummaryDTO[];
  empty?: string;
}

export function MatchList({ matches, empty = '暂无对局记录' }: MatchListProps) {
  if (matches.length === 0) return <p className="hint empty-state">{empty}</p>;

  return (
    <ul className="match-list">
      {matches.map((match) => {
        const players = match.participants.map((participant) => participant.name).join(' / ') || '待定选手';
        const scores = match.status === 'done'
          ? match.participants.map((participant) => `${participant.name} ${participant.score}`).join(' · ')
          : '';
        return (
          <li key={match.id}>
            <Link className="match-link" to={`/matches/${match.id}`} aria-label={`查看第 ${match.id} 场对局：${players}`}>
              <span className={`pill ${match.live ? 'live' : ''}`}>
                {match.live ? '直播中' : STATUS_LABEL[match.status]}
              </span>
              <span className="match-main">
                <strong>{KIND_LABEL[match.kind]} · {MODE_LABEL[match.mode]}{match.teams ? ' · 组队' : ''}</strong>
                <span>{players}</span>
                {scores && <span className="hint">{scores}</span>}
              </span>
              <span className="match-meta">
                <span>#{match.id}</span>
                <time>{formatDate(match.createdAt)}</time>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
