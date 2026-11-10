import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeBinary, decodeJson, encodeBinary } from '../src/codec.ts';

const ship = {
  id: 1,
  kind: 'ship',
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  radius: 10,
  angle: 0,
  hp: 3,
  thrust: 0,
  invulnerableTime: 0,
  shield: false,
  ownerId: 1,
  ttl: 0,
  commandSeq: 0,
  score: 0,
};

test('binary encoder rejects unsupported and out-of-range packet values', () => {
  assert.throws(() => encodeBinary(null), TypeError);
  assert.throws(() => encodeBinary({ type: 'unknown' }), TypeError);
  assert.throws(() => encodeBinary({ type: 'ping', sentAt: Number.POSITIVE_INFINITY }), TypeError);
  assert.throws(() => encodeBinary({ type: 'pong', tick: -1, sentAt: 1 }), TypeError);
  assert.throws(
    () => encodeBinary({ type: 'snapshot', tick: 0, entities: [null], acks: [] }),
    TypeError,
  );
});

test('binary decoder rejects invalid headers, flags, lengths, and input ranges', () => {
  const ping = new Uint8Array(encodeBinary({ type: 'ping', sentAt: 1 }));
  const badVersion = ping.slice();
  badVersion[0] = 0;
  assert.throws(() => decodeBinary(badVersion), /version/i);

  const badKind = ping.slice();
  badKind[1] = 255;
  assert.throws(() => decodeBinary(badKind), /unsupported/i);
  assert.throws(() => decodeBinary(ping.slice(0, -1)), /length/i);

  const input = new Uint8Array(
    encodeBinary({
      type: 'input',
      seq: 1,
      tick: 0,
      turn: 0,
      thrust: false,
      brake: false,
      fire: false,
    }),
  );
  input[11] = 0x80;
  assert.throws(() => decodeBinary(input), /flags/i);
  input[11] = 0;
  input[10] = 2;
  assert.throws(() => decodeBinary(input));
});

test('binary decoder validates snapshot entity kinds, flags, values, and packet shape', () => {
  const valid = new Uint8Array(
    encodeBinary({ type: 'snapshot', tick: 1, entities: [ship], acks: [] }),
  );

  const badEntityKind = valid.slice();
  badEntityKind[14] = 0;
  assert.throws(() => decodeBinary(badEntityKind), /type or flags/i);

  const badEntityFlags = valid.slice();
  badEntityFlags[15] = 0x20;
  assert.throws(() => decodeBinary(badEntityFlags), /type or flags/i);

  const badEntityValue = valid.slice();
  new DataView(badEntityValue.buffer).setFloat32(16, Number.NaN, true);
  assert.throws(() => decodeBinary(badEntityValue), /out of range/i);
  assert.throws(() => decodeBinary(valid.slice(0, -1)), /length/i);

  const pickupWithoutEffect = valid.slice();
  pickupWithoutEffect[14] = 4;
  assert.throws(() => decodeBinary(pickupWithoutEffect), /type or flags/i);
});

test('JSON codec accepts strings and byte buffers but rejects invalid packet shapes', () => {
  assert.deepEqual(decodeJson('{"type":"ping"}'), { type: 'ping' });
  assert.deepEqual(decodeJson(new TextEncoder().encode('{"type":"pong"}').buffer), {
    type: 'pong',
  });
  assert.deepEqual(decodeJson(new TextEncoder().encode('{"type":"input"}')), {
    type: 'input',
  });
  assert.throws(() => decodeJson(null), TypeError);
  assert.throws(() => decodeJson('[]'), TypeError);
});
