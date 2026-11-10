import assert from 'node:assert/strict';
import test from 'node:test';
import { entityId, seq, tick } from '../src/types.ts';

test('branded numeric constructors enforce their unsigned sequence ranges', () => {
  assert.equal(entityId(0), 0);
  assert.equal(tick(1), 1);
  assert.equal(seq(1), 1);
  assert.throws(() => entityId(-1), RangeError);
  assert.throws(() => tick(Number.NaN), RangeError);
  assert.throws(() => seq(0), RangeError);
});
