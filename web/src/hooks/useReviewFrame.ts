import { useEffect, useState } from 'react';
import { getMatchFrame } from '../api';
import type { FrameDTO } from '../types';
import { errorMessage } from '../utils';

interface FrameResult {
  matchId: number;
  tick: number;
  slot: number;
  data: FrameDTO;
}

export function useReviewFrame(matchId: number, tick: number | null, slot: number, enabled: boolean) {
  const [result, setResult] = useState<FrameResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setError('');
    if (!enabled || tick === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = window.setTimeout(() => {
      getMatchFrame(matchId, tick, slot).then((data) => {
        if (!cancelled) setResult({ matchId, tick, slot, data });
      }).catch((reason: unknown) => {
        if (!cancelled) setError(errorMessage(reason));
      }).finally(() => {
        if (!cancelled) setLoading(false);
      });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [matchId, tick, slot, enabled]);

  const current = enabled && result && result.matchId === matchId && result.tick === tick && result.slot === slot ? result.data : null;
  return { review: current?.review ?? null, loading, error };
}
