import { expect, test } from 'vitest';
import { reconcilePrediction } from '../src/netcode.ts';
import type { PendingInput, SequencedInput } from '../src/netcode.ts';
import type { ShipState } from '@dogfight/shared/sim';

const command: SequencedInput = {
  seq: 2,
  tick: 2,
  turn: 0,
  thrust: true,
  brake: false,
  fire: false,
};

test('netcode: reconciliation replays only inputs newer than the acknowledgement', () => {
  const authoritative: ShipState = {
    x: 100,
    y: 100,
    vx: 0,
    vy: 0,
    angle: -Math.PI / 2,
    thrust: 0,
  };
  const pending: PendingInput[] = [
    { command: { ...command, seq: 1 }, dt: 1 / 30 },
    { command, dt: 1 / 30 },
  ];
  const originalAuthoritative = { ...authoritative };
  const result = reconcilePrediction(authoritative, pending, 1, 960, 600);
  expect(result.pending).toEqual([pending[1]]);
  expect(result.state.y).toBeLessThan(authoritative.y);
  expect(authoritative).toEqual(originalAuthoritative);
  expect(pending).toHaveLength(2);
  expect(reconcilePrediction(authoritative, pending, 1, 960, 600)).toEqual(result);
});
