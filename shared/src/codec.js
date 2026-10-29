import { BINARY_PROTOCOL_VERSION, MESSAGE_KIND, validateInputCommand } from './protocol.js';

const HEADER_BYTES = 2;
const SNAPSHOT_HEADER_BYTES = 10;
const ACK_BYTES = 8;
const ENTITY_BYTES = 50;
const ANGLE_SCALE = 10_000;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });
const ENTITY_KINDS = Object.freeze(['ship', 'asteroid', 'bullet', 'pickup', 'explosion']);
const ENTITY_KIND_IDS = new Map(ENTITY_KINDS.map((kind, index) => [kind, index + 1]));
const PICKUP_EFFECTS = Object.freeze(['shield', 'rapid-fire', 'repair']);
const PICKUP_EFFECT_IDS = new Map(PICKUP_EFFECTS.map((effect, index) => [effect, index + 1]));

// Binary v1: LE header (version:u8,type:u8); input (seq:u32,tick:u32,turn:i8,flags:u8);
// snapshot (tick:u32,count:u16,ackCount:u16), then 50-byte entity and 8-byte ack records.
// Entity record: id:u32, kind:u8, flags:u8, x/y/vx/vy/radius:f32, angle:i16 at 1/10000 rad,
// hp:u8, reserved:u8, ownerId:u32, ttl/invulnerability:f32, commandSeq/score:u32.
// Flags: thrust, invulnerable, shield, then pickup effect id (1 shield, 2 rapid-fire, 3 repair).
export const BINARY_PACKET_SPEC = Object.freeze({
  version: BINARY_PROTOCOL_VERSION,
  endianness: 'little-endian',
  angleScale: ANGLE_SCALE,
  snapshotHeaderBytes: SNAPSHOT_HEADER_BYTES,
  entityBytes: ENTITY_BYTES,
  ackBytes: ACK_BYTES,
});

export function encodeBinary(message) {
  if (message?.type === 'input') {
    const input = validateInputCommand({
      seq: message.seq,
      tick: message.tick,
      turn: message.turn,
      thrust: message.thrust,
      brake: message.brake,
      fire: message.fire,
    });
    const buffer = new ArrayBuffer(HEADER_BYTES + 10);
    const view = new DataView(buffer);
    view.setUint8(0, BINARY_PROTOCOL_VERSION);
    view.setUint8(1, MESSAGE_KIND.input);
    view.setUint32(2, input.seq, true);
    view.setUint32(6, input.tick, true);
    view.setInt8(10, input.turn);
    view.setUint8(
      11,
      Number(input.thrust) | (Number(input.brake) << 1) | (Number(input.fire) << 2),
    );
    return buffer;
  }
  if (message?.type === 'ping') {
    if (!Number.isFinite(message.sentAt)) throw new TypeError('Ping timestamp is invalid.');
    const buffer = new ArrayBuffer(HEADER_BYTES + 8);
    const view = new DataView(buffer);
    view.setUint8(0, BINARY_PROTOCOL_VERSION);
    view.setUint8(1, MESSAGE_KIND.ping);
    view.setFloat64(2, message.sentAt, true);
    return buffer;
  }
  if (message?.type === 'pong') {
    if (
      !Number.isSafeInteger(message.tick) ||
      message.tick < 0 ||
      message.tick > 0xffffffff ||
      !Number.isFinite(message.sentAt)
    ) {
      throw new TypeError('Pong fields are invalid.');
    }
    const buffer = new ArrayBuffer(HEADER_BYTES + 12);
    const view = new DataView(buffer);
    view.setUint8(0, BINARY_PROTOCOL_VERSION);
    view.setUint8(1, MESSAGE_KIND.pong);
    view.setUint32(2, message.tick, true);
    view.setFloat64(6, message.sentAt, true);
    return buffer;
  }
  if (message?.type === 'snapshot') {
    return encodeSnapshot(message);
  }
  throw new TypeError('Unsupported binary message type.');
}

function encodeSnapshot(message) {
  if (
    !Number.isSafeInteger(message.tick) ||
    message.tick < 0 ||
    message.tick > 0xffffffff ||
    !Array.isArray(message.entities) ||
    !Array.isArray(message.acks) ||
    message.entities.length > 1000 ||
    message.acks.length > 64
  ) {
    throw new TypeError('Snapshot fields are invalid.');
  }
  const buffer = new ArrayBuffer(
    SNAPSHOT_HEADER_BYTES +
      message.acks.length * ACK_BYTES +
      message.entities.length * ENTITY_BYTES,
  );
  const view = new DataView(buffer);
  view.setUint8(0, BINARY_PROTOCOL_VERSION);
  view.setUint8(1, MESSAGE_KIND.snapshot);
  view.setUint32(2, message.tick, true);
  view.setUint16(6, message.entities.length, true);
  view.setUint16(8, message.acks.length, true);
  let offset = SNAPSHOT_HEADER_BYTES;
  for (const ack of message.acks) {
    if (
      !Number.isSafeInteger(ack.entityId) ||
      ack.entityId < 0 ||
      ack.entityId > 0xffffffff ||
      !Number.isSafeInteger(ack.seq) ||
      ack.seq < 0 ||
      ack.seq > 0xffffffff
    ) {
      throw new TypeError('Snapshot acknowledgement is invalid.');
    }
    view.setUint32(offset, ack.entityId, true);
    view.setUint32(offset + 4, ack.seq, true);
    offset += ACK_BYTES;
  }
  for (const entity of message.entities) {
    const kind = ENTITY_KIND_IDS.get(entity.kind);
    const pickupEffect =
      entity.kind === 'pickup' ? PICKUP_EFFECT_IDS.get(entity.effect) : undefined;
    if (
      !kind ||
      !Number.isSafeInteger(entity.id) ||
      entity.id < 0 ||
      entity.id > 0xffffffff ||
      ![
        entity.x,
        entity.y,
        entity.vx,
        entity.vy,
        entity.radius,
        entity.angle,
        entity.ttl ?? 0,
        entity.invulnerableTime ?? 0,
      ].every(isFloat32Value) ||
      entity.radius < 0 ||
      (entity.ttl ?? 0) < 0 ||
      (entity.invulnerableTime ?? 0) < 0 ||
      !isByte(entity.hp ?? 0) ||
      !isUint32(entity.ownerId ?? 0) ||
      !isUint32(entity.commandSeq ?? 0) ||
      !isUint32(entity.score ?? 0) ||
      (entity.kind === 'pickup' && !pickupEffect) ||
      (entity.kind !== 'pickup' && entity.effect !== undefined)
    ) {
      throw new TypeError('Snapshot entity is invalid.');
    }
    view.setUint32(offset, entity.id, true);
    view.setUint8(offset + 4, kind);
    const flags =
      Number(Boolean(entity.thrust)) |
      (Number(Boolean(entity.invulnerableTime > 0)) << 1) |
      (Number(Boolean(entity.shield)) << 2) |
      ((pickupEffect ?? 0) << 3);
    view.setUint8(offset + 5, flags);
    view.setFloat32(offset + 6, entity.x, true);
    view.setFloat32(offset + 10, entity.y, true);
    view.setFloat32(offset + 14, entity.vx, true);
    view.setFloat32(offset + 18, entity.vy, true);
    view.setFloat32(offset + 22, entity.radius, true);
    const normalizedAngle = Math.atan2(Math.sin(entity.angle), Math.cos(entity.angle));
    view.setInt16(offset + 26, Math.round(normalizedAngle * ANGLE_SCALE), true);
    view.setUint8(offset + 28, entity.hp ?? 0);
    view.setUint8(offset + 29, 0);
    view.setUint32(offset + 30, entity.ownerId ?? 0, true);
    view.setFloat32(offset + 34, entity.ttl ?? 0, true);
    view.setFloat32(offset + 38, entity.invulnerableTime ?? 0, true);
    view.setUint32(offset + 42, entity.commandSeq ?? 0, true);
    view.setUint32(offset + 46, entity.score ?? 0, true);
    offset += ENTITY_BYTES;
  }
  return buffer;
}

export function decodeBinary(data) {
  const buffer = toArrayBuffer(data);
  if (buffer.byteLength < HEADER_BYTES) throw new RangeError('Binary packet is truncated.');
  const view = new DataView(buffer);
  const version = view.getUint8(0);
  const type = view.getUint8(1);
  if (version !== BINARY_PROTOCOL_VERSION)
    throw new RangeError('Binary protocol version mismatch.');
  if (type === MESSAGE_KIND.input) {
    if (buffer.byteLength !== HEADER_BYTES + 10)
      throw new RangeError('Input packet length is invalid.');
    const flags = view.getUint8(11);
    if ((flags & 0xf8) !== 0) throw new RangeError('Input flags are invalid.');
    return {
      type: 'input',
      seq: view.getUint32(2, true),
      tick: view.getUint32(6, true),
      turn: view.getInt8(10),
      thrust: Boolean(flags & 1),
      brake: Boolean(flags & 2),
      fire: Boolean(flags & 4),
    };
  }
  if (type === MESSAGE_KIND.ping) {
    if (buffer.byteLength !== HEADER_BYTES + 8)
      throw new RangeError('Ping packet length is invalid.');
    const sentAt = view.getFloat64(2, true);
    if (!Number.isFinite(sentAt)) throw new RangeError('Ping timestamp is invalid.');
    return { type: 'ping', sentAt };
  }
  if (type === MESSAGE_KIND.pong) {
    if (buffer.byteLength !== HEADER_BYTES + 12)
      throw new RangeError('Pong packet length is invalid.');
    const tick = view.getUint32(2, true);
    const sentAt = view.getFloat64(6, true);
    if (!Number.isFinite(sentAt)) throw new RangeError('Pong timestamp is invalid.');
    return { type: 'pong', tick, sentAt };
  }
  if (type === MESSAGE_KIND.snapshot) return decodeSnapshot(buffer, view);
  throw new RangeError('Binary message type is unsupported.');
}

function decodeSnapshot(buffer, view) {
  if (buffer.byteLength < SNAPSHOT_HEADER_BYTES)
    throw new RangeError('Snapshot header is truncated.');
  const tick = view.getUint32(2, true);
  const entityCount = view.getUint16(6, true);
  const ackCount = view.getUint16(8, true);
  const expectedLength = SNAPSHOT_HEADER_BYTES + ackCount * ACK_BYTES + entityCount * ENTITY_BYTES;
  if (entityCount > 1000 || ackCount > 64 || buffer.byteLength !== expectedLength) {
    throw new RangeError('Snapshot packet length or counts are invalid.');
  }
  const acks = [];
  let offset = SNAPSHOT_HEADER_BYTES;
  for (let index = 0; index < ackCount; index += 1) {
    acks.push({
      entityId: view.getUint32(offset, true),
      seq: view.getUint32(offset + 4, true),
    });
    offset += ACK_BYTES;
  }
  const entities = [];
  for (let index = 0; index < entityCount; index += 1) {
    const kind = ENTITY_KINDS[view.getUint8(offset + 4) - 1];
    const flags = view.getUint8(offset + 5);
    const pickupEffectId = (flags >> 3) & 0x03;
    if (
      !kind ||
      (flags & 0xe0) !== 0 ||
      (kind === 'pickup' ? pickupEffectId === 0 : pickupEffectId !== 0)
    ) {
      throw new RangeError('Snapshot entity type or flags are invalid.');
    }
    const entity = {
      id: view.getUint32(offset, true),
      kind,
      thrust: Boolean(flags & 1),
      invulnerableTime: view.getFloat32(offset + 38, true),
      shield: Boolean(flags & 4),
      ...(kind === 'pickup' ? { effect: PICKUP_EFFECTS[pickupEffectId - 1] } : {}),
      x: view.getFloat32(offset + 6, true),
      y: view.getFloat32(offset + 10, true),
      vx: view.getFloat32(offset + 14, true),
      vy: view.getFloat32(offset + 18, true),
      radius: view.getFloat32(offset + 22, true),
      angle: view.getInt16(offset + 26, true) / ANGLE_SCALE,
      hp: view.getUint8(offset + 28),
      ownerId: view.getUint32(offset + 30, true),
      ttl: view.getFloat32(offset + 34, true),
      commandSeq: view.getUint32(offset + 42, true),
      score: view.getUint32(offset + 46, true),
    };
    if (
      ![
        entity.x,
        entity.y,
        entity.vx,
        entity.vy,
        entity.radius,
        entity.angle,
        entity.ttl,
        entity.invulnerableTime,
      ].every(Number.isFinite) ||
      entity.radius < 0 ||
      entity.ttl < 0 ||
      entity.invulnerableTime < 0
    ) {
      throw new RangeError('Snapshot entity values are out of range.');
    }
    entities.push(entity);
    offset += ENTITY_BYTES;
  }
  return { type: 'snapshot', tick, acks, entities };
}

export function encodeJson(message) {
  return JSON.stringify(message);
}

export function decodeJson(data) {
  let text;
  if (typeof data === 'string') {
    text = data;
  } else {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    text = TEXT_DECODER.decode(bytes);
  }
  const message = JSON.parse(text);
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new TypeError('JSON protocol message must be an object.');
  }
  return message;
}

export function measureJsonBytes(message) {
  return TEXT_ENCODER.encode(encodeJson(message)).byteLength;
}

export function measureBinaryBytes(message) {
  return encodeBinary(message).byteLength;
}

function toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  throw new TypeError('Binary packet must be an ArrayBuffer or typed-array view.');
}

function isFloat32Value(value) {
  return Number.isFinite(value) && Math.abs(value) <= 3.4028234663852886e38;
}

function isByte(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0xff;
}

function isUint32(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}
