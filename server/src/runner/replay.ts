import type { Direction, Frame, Replay, ScriptState } from '../types';
import { asciiGrid, buildScriptState } from '../game/observe';
import { createGame, disqualify, evaluateEnd, queueDirection, step, type GameState } from '../game/engine';
import { ENGINE_VERSION, normalizeConfig } from './config';

const symbols: Record<string, Direction> = { U: 'up', D: 'down', L: 'left', R: 'right' };

function newGame(replay: Replay): GameState {
  if (replay.v !== 1 || ![ENGINE_VERSION, 'serpent-engine-2'].includes(replay.engine)) throw new Error('不支持此回放引擎版本');
  const normalized = normalizeConfig(replay.config);
  // Engine-2 recordings predate ruleset fields; always replay them as classic,
  // even when a caller has merged a newer default config into the fixture.
  const config = replay.engine === 'serpent-engine-2'
    ? { ...normalized, ruleset: 'classic' as const, maxHp: null }
    : normalized;
  return createGame({
    config,
    participants: replay.players.map((player) => ({
      slot: player.slot, name: player.name, team: player.team,
      source: { kind: 'builtin', bot: 'greedy' },
    })),
  });
}

function applyDisqualifications(game: GameState, replay: Replay, phase: 'init' | 'move'): void {
  for (const item of replay.disqualifications ?? []) {
    if (item.tick === game.tick && (item.phase ?? (item.tick === 0 ? 'init' : 'move')) === phase) {
      disqualify(game, item.slot, { deferEnd: true });
    }
  }
  evaluateEnd(game);
}

function applyNext(game: GameState, replay: Replay, encoded: string): void {
  if (encoded.length !== replay.players.length) throw new Error('回放方向记录格式错误');
  for (const [index, player] of replay.players.entries()) {
    const char = encoded[index];
    if (char === '.') continue;
    if (char === undefined) throw new Error('回放方向记录格式错误');
    const direction = symbols[char];
    if (!direction) throw new Error('回放包含无效方向');
    queueDirection(game, player.slot, direction);
  }
  step(game);
}

/** The callback observes the same mutable game at each frame; copy retained data. */
export function walkReplay(replay: Replay, visit: (game: GameState) => void, through = replay.moves.length): GameState {
  if (!Number.isInteger(through) || through < 0 || through > replay.moves.length) throw new RangeError('回放拍数超出范围');
  const game = newGame(replay);
  applyDisqualifications(game, replay, 'init');
  applyDisqualifications(game, replay, 'move');
  visit(game);
  for (let tick = 0; tick < through; tick++) {
    if (game.status === 'ended') throw new Error('回放在比赛结束后仍包含方向记录');
    const encoded = replay.moves[tick];
    if (encoded === undefined) throw new Error('回放方向记录格式错误');
    applyNext(game, replay, encoded);
    applyDisqualifications(game, replay, 'move');
    visit(game);
  }
  return game;
}

function frame(game: GameState): Frame {
  return {
    tick: game.tick,
    snakes: game.snakes.map((snake) => ({ slot: snake.slot, body: snake.body.map((point) => ({ ...point })),
      dir: snake.dir, alive: snake.alive, score: snake.score, length: snake.body.length, hp: snake.hp })),
    foods: game.foods.map((food) => ({ ...food })),
    events: game.events.map(({ type, slot, message }) => ({ type, ...(slot === undefined ? {} : { slot }), message })),
  };
}

export function replayFrames(replay: Replay): Frame[] {
  const frames: Frame[] = [];
  walkReplay(replay, (game) => frames.push(frame(game)));
  return frames;
}

export function frameState(replay: Replay, tick: number, viewerSlot: number): { ascii: string; state: ScriptState } {
  if (!Number.isInteger(tick) || tick < 0 || tick > replay.moves.length) throw new RangeError('回放拍数超出范围');
  if (!replay.players.some((player) => player.slot === viewerSlot)) throw new RangeError('未知回放观察位置');
  const game = walkReplay(replay, () => {}, tick);
  return { ascii: asciiGrid(game, viewerSlot), state: buildScriptState(game, viewerSlot) };
}
