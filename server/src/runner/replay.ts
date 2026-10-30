import type { Direction, Frame, Replay, ScriptState } from '../types';
import { asciiGrid, buildScriptState } from '../game/observe';
import { createGame, disqualify, evaluateEnd, queueDirection, step, type GameState } from '../game/engine';
import { ENGINE_VERSION } from './config';

const symbols: Record<string, Direction> = { U: 'up', D: 'down', L: 'left', R: 'right' };

function newGame(replay: Replay): GameState {
  if (replay.v !== 1 || replay.engine !== ENGINE_VERSION) throw new Error('Unsupported replay engine version');
  return createGame({
    config: replay.config,
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
  if (encoded.length !== replay.players.length) throw new Error('Malformed replay moves');
  for (let i = 0; i < replay.players.length; i++) {
    const char = encoded[i]!;
    if (char === '.') continue;
    const direction = symbols[char];
    if (!direction) throw new Error('Malformed replay direction');
    queueDirection(game, replay.players[i]!.slot, direction);
  }
  step(game);
}

function frame(game: GameState): Frame {
  return {
    tick: game.tick,
    snakes: game.snakes.map((snake) => ({ slot: snake.slot, body: snake.body.map((point) => ({ ...point })),
      dir: snake.dir, alive: snake.alive, score: snake.score, length: snake.body.length })),
    foods: game.foods.map((food) => ({ ...food })),
    events: game.events.map(({ type, slot, message }) => ({ type, ...(slot === undefined ? {} : { slot }), message })),
  };
}

export function replayFrames(replay: Replay): Frame[] {
  const game = newGame(replay);
  applyDisqualifications(game, replay, 'init');
  // Frames include decisions that disqualify a snake at this tick, even when
  // other snakes survive and the next engine step will still be taken.
  applyDisqualifications(game, replay, 'move');
  const frames: Frame[] = [frame(game)];
  for (const move of replay.moves) {
    if (game.status === 'ended') throw new Error('Replay contains moves after match ended');
    applyNext(game, replay, move);
    applyDisqualifications(game, replay, 'move');
    frames.push(frame(game));
  }
  return frames;
}

export function frameState(replay: Replay, tick: number, viewerSlot: number): { ascii: string; state: ScriptState } {
  if (!Number.isInteger(tick) || tick < 0 || tick > replay.moves.length) throw new RangeError('Replay tick out of range');
  if (!replay.players.some((player) => player.slot === viewerSlot)) throw new RangeError('Unknown replay viewer slot');
  const game = newGame(replay);
  applyDisqualifications(game, replay, 'init');
  applyDisqualifications(game, replay, 'move');
  for (let i = 0; i < tick; i++) {
    applyNext(game, replay, replay.moves[i]!);
    applyDisqualifications(game, replay, 'move');
  }
  return { ascii: asciiGrid(game, viewerSlot), state: buildScriptState(game, viewerSlot) };
}
