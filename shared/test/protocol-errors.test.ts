import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeBinary } from '../src/codec.ts';
import {
  CONTROL_PROTOCOL_VERSION,
  parseClientMessage,
  parseServerMessage,
  serverMessage,
} from '../src/protocol.ts';

test('protocol parser reports unsupported inputs, invalid UTF-8, and malformed JSON safely', () => {
  const unsupported = parseClientMessage(42);
  assert.equal(unsupported.success, false);
  if (!unsupported.success) assert.equal(unsupported.error.code, 'invalid-json');

  const invalidUtf8 = parseClientMessage(Uint8Array.of(0xff));
  assert.equal(invalidUtf8.success, false);
  if (!invalidUtf8.success) assert.equal(invalidUtf8.error.code, 'invalid-json');

  const malformedJson = parseClientMessage('{');
  assert.equal(malformedJson.success, false);
  if (!malformedJson.success) assert.equal(malformedJson.error.code, 'invalid-json');

  const invalidMessage = parseClientMessage('null');
  assert.equal(invalidMessage.success, false);
  if (!invalidMessage.success) assert.equal(invalidMessage.error.code, 'invalid-message');
});

test('protocol parser distinguishes wrong versions and validates text and byte-buffer messages', () => {
  const wrongVersion = JSON.stringify({
    version: CONTROL_PROTOCOL_VERSION + 1,
    type: 'join',
    room: 'training-sector',
    name: 'Pilot',
  });
  const wrongVersionResult = parseClientMessage(wrongVersion);
  assert.equal(wrongVersionResult.success, false);
  if (!wrongVersionResult.success) {
    assert.equal(wrongVersionResult.error.code, 'invalid-version');
  }

  const valid = JSON.stringify({
    version: CONTROL_PROTOCOL_VERSION,
    type: 'join',
    room: 'training-sector',
    name: 'Pilot',
  });
  assert.equal(parseClientMessage(new TextEncoder().encode(valid)).success, true);
  assert.equal(parseServerMessage(new TextEncoder().encode('{')).success, false);
  assert.equal(parseServerMessage('null').success, false);

  const serverPong = JSON.stringify({
    version: CONTROL_PROTOCOL_VERSION,
    type: 'pong',
    tick: 0,
    sentAt: 12.5,
  });
  assert.equal(parseServerMessage(new TextEncoder().encode(serverPong).buffer).success, true);
});

test('binary client parser accepts control packets and rejects server-only or malformed packets', () => {
  const ping = encodeBinary({ type: 'ping', sentAt: 12.5 });
  const pingResult = parseClientMessage(ping, true);
  assert.equal(pingResult.success, true);
  if (pingResult.success) {
    assert.deepEqual(pingResult.data, { version: 0, type: 'ping', sentAt: 12.5 });
  }

  const snapshot = encodeBinary({ type: 'snapshot', tick: 0, entities: [], acks: [] });
  const snapshotResult = parseClientMessage(snapshot, true);
  assert.equal(snapshotResult.success, false);
  if (!snapshotResult.success) assert.equal(snapshotResult.error.code, 'invalid-binary');
  assert.equal(parseClientMessage(Uint8Array.of(1, 255), true).success, false);
});

test('protocol server message factory rejects payloads that violate the shared schema', () => {
  assert.throws(() => serverMessage('error', { message: '' }), TypeError);
  assert.equal(
    parseServerMessage(serverMessage('error', { message: 'Valid message.' })).success,
    true,
  );
});
