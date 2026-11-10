import { BINARY_PROTOCOL_VERSION, MESSAGE_KIND } from './protocol-constants.ts';
import { validateInputCommand } from './input.ts';
import type { EntityKind, PickupEffect } from './types.ts';

const HEADER_BYTES = 2;
const SNAPSHOT_HEADER_BYTES = 10;
const ACK_BYTES = 8;
const ENTITY_BYTES = 50;
const ANGLE_SCALE = 10_000;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });
const ENTITY_KINDS: readonly EntityKind[] = ['ship', 'asteroid', 'bullet', 'pickup', 'explosion'];
const ENTITY_KIND_IDS = new Map(ENTITY_KINDS.map((kind, index) => [kind, index + 1]));
const PICKUP_EFFECTS: readonly PickupEffect[] = ['shield', 'rapid-fire', 'repair'];
const PICKUP_EFFECT_IDS = new Map(PICKUP_EFFECTS.map((effect, index) => [effect, index + 1]));
const isPickupEffect = (value: unknown): value is PickupEffect =>
  value === 'shield' || value === 'rapid-fire' || value === 'repair';

export interface BinaryInputMessage {
  readonly type: 'input';
  readonly seq: number;
  readonly tick: number;
  readonly turn: -1 | 0 | 1;
  readonly thrust: boolean;
  readonly brake: boolean;
  readonly fire: boolean;
}

export interface BinaryPingMessage {
  readonly type: 'ping';
  readonly sentAt: number;
}

export interface BinaryPongMessage {
  readonly type: 'pong';
  readonly tick: number;
  readonly sentAt: number;
}

interface BinarySnapshotEntityFields {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly radius: number;
  readonly angle: number;
  readonly hp: number;
  readonly thrust: number;
  readonly invulnerableTime: number;
  readonly shield: boolean;
  readonly ownerId: number;
  readonly ttl: number;
  readonly commandSeq: number;
  readonly score: number;
}

export type BinarySnapshotEntity = BinarySnapshotEntityFields &
  (
    | { readonly kind: 'pickup'; readonly effect: PickupEffect }
    | { readonly kind: Exclude<EntityKind, 'pickup'>; readonly effect?: never }
  );

export interface BinarySnapshotMessage {
  readonly type: 'snapshot';
  readonly tick: number;
  readonly acks: readonly { readonly entityId: number; readonly seq: number }[];
  readonly entities: readonly BinarySnapshotEntity[];
}

export type BinaryMessage =
  BinaryInputMessage | BinaryPingMessage | BinaryPongMessage | BinarySnapshotMessage;

export interface Codec<Input, Output> {
  encode(message: Input): string | ArrayBuffer;
  decode(data: unknown): Output;
}

export const BINARY_PACKET_SPEC = Object.freeze({
  version: BINARY_PROTOCOL_VERSION,
  endianness: 'little-endian',
  angleScale: ANGLE_SCALE,
  snapshotHeaderBytes: SNAPSHOT_HEADER_BYTES,
  entityBytes: ENTITY_BYTES,
  ackBytes: ACK_BYTES,
});

export function encodeBinary(message: unknown): ArrayBuffer {
  if (!isRecord(message) || typeof message.type !== 'string') {
    throw new TypeError('Unsupported binary message type.');
  }
  switch (message.type) {
    case 'input': {
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
    case 'ping': {
      if (typeof message.sentAt !== 'number' || !Number.isFinite(message.sentAt)) {
        throw new TypeError('Ping timestamp is invalid.');
      }
      const buffer = new ArrayBuffer(HEADER_BYTES + 8);
      const view = new DataView(buffer);
      view.setUint8(0, BINARY_PROTOCOL_VERSION);
      view.setUint8(1, MESSAGE_KIND.ping);
      view.setFloat64(2, message.sentAt, true);
      return buffer;
    }
    case 'pong': {
      if (
        !isUint32(message.tick) ||
        typeof message.sentAt !== 'number' ||
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
    case 'snapshot':
      return encodeSnapshot(message);
    default:
      throw new TypeError('Unsupported binary message type.');
  }
}

function encodeSnapshot(value: Record<string, unknown>): ArrayBuffer {
  if (
    !isUint32(value.tick) ||
    !Array.isArray(value.entities) ||
    !Array.isArray(value.acks) ||
    value.entities.length > 1000 ||
    value.acks.length > 64
  ) {
    throw new TypeError('Snapshot fields are invalid.');
  }
  const rawEntities: unknown[] = value.entities;
  const rawAcks: unknown[] = value.acks;
  const entities = rawEntities.map(parseSnapshotEntity);
  const acks = rawAcks.map(parseSnapshotAck);
  const message: BinarySnapshotMessage = {
    type: 'snapshot',
    tick: value.tick,
    entities,
    acks,
  };
  if (!isUint32(message.tick) || message.entities.length > 1000 || message.acks.length > 64) {
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
    if (!isUint32(ack.entityId) || !isUint32(ack.seq)) {
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
      kind === undefined ||
      !isUint32(entity.id) ||
      ![
        entity.x,
        entity.y,
        entity.vx,
        entity.vy,
        entity.radius,
        entity.angle,
        entity.ttl,
        entity.invulnerableTime,
      ].every(isFloat32Value) ||
      entity.radius < 0 ||
      entity.ttl < 0 ||
      entity.invulnerableTime < 0 ||
      !isByte(entity.hp) ||
      !isUint32(entity.ownerId) ||
      !isUint32(entity.commandSeq) ||
      !isUint32(entity.score) ||
      !Number.isFinite(entity.thrust) ||
      (entity.kind === 'pickup' && pickupEffect === undefined) ||
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
    view.setUint8(offset + 28, entity.hp);
    view.setUint8(offset + 29, 0);
    view.setUint32(offset + 30, entity.ownerId, true);
    view.setFloat32(offset + 34, entity.ttl, true);
    view.setFloat32(offset + 38, entity.invulnerableTime, true);
    view.setUint32(offset + 42, entity.commandSeq, true);
    view.setUint32(offset + 46, entity.score, true);
    offset += ENTITY_BYTES;
  }
  return buffer;
}

export function decodeBinary(data: unknown): BinaryMessage {
  const buffer = toArrayBuffer(data);
  if (buffer.byteLength < HEADER_BYTES) throw new RangeError('Binary packet is truncated.');
  const view = new DataView(buffer);
  const version = view.getUint8(0);
  const type = view.getUint8(1);
  if (version !== BINARY_PROTOCOL_VERSION) {
    throw new RangeError('Binary protocol version mismatch.');
  }
  switch (type) {
    case MESSAGE_KIND.input: {
      if (buffer.byteLength !== HEADER_BYTES + 10) {
        throw new RangeError('Input packet length is invalid.');
      }
      const flags = view.getUint8(11);
      if ((flags & 0xf8) !== 0) throw new RangeError('Input flags are invalid.');
      const input = {
        seq: view.getUint32(2, true),
        tick: view.getUint32(6, true),
        turn: view.getInt8(10),
        thrust: Boolean(flags & 1),
        brake: Boolean(flags & 2),
        fire: Boolean(flags & 4),
      };
      return validateDecodedInput(input);
    }
    case MESSAGE_KIND.ping: {
      if (buffer.byteLength !== HEADER_BYTES + 8) {
        throw new RangeError('Ping packet length is invalid.');
      }
      const sentAt = view.getFloat64(2, true);
      if (!Number.isFinite(sentAt)) throw new RangeError('Ping timestamp is invalid.');
      return { type: 'ping', sentAt };
    }
    case MESSAGE_KIND.pong: {
      if (buffer.byteLength !== HEADER_BYTES + 12) {
        throw new RangeError('Pong packet length is invalid.');
      }
      const tick = view.getUint32(2, true);
      const sentAt = view.getFloat64(6, true);
      if (!Number.isFinite(sentAt)) throw new RangeError('Pong timestamp is invalid.');
      return { type: 'pong', tick, sentAt };
    }
    case MESSAGE_KIND.snapshot:
      return decodeSnapshot(buffer, view);
    default:
      throw new RangeError('Binary message type is unsupported.');
  }
}

function validateDecodedInput(input: {
  readonly seq: number;
  readonly tick: number;
  readonly turn: number;
  readonly thrust: boolean;
  readonly brake: boolean;
  readonly fire: boolean;
}): BinaryInputMessage {
  const parsed = validateInputCommand(input);
  return { type: 'input', ...parsed };
}

function parseSnapshotEntity(value: unknown): BinarySnapshotEntity {
  if (!isRecord(value)) throw new TypeError('Snapshot entity is invalid.');
  const common: BinarySnapshotEntityFields = {
    id: requiredUint32(value, 'id', 'Snapshot entity is invalid.'),
    x: requiredFloat32(value, 'x'),
    y: requiredFloat32(value, 'y'),
    vx: requiredFloat32(value, 'vx'),
    vy: requiredFloat32(value, 'vy'),
    angle: requiredFloat32(value, 'angle'),
    radius: requiredNonnegativeFloat32(value, 'radius'),
    thrust: requiredFiniteNumber(value, 'thrust'),
    hp: requiredByte(value, 'hp', 'Snapshot entity is invalid.'),
    shield: requiredBoolean(value, 'shield'),
    invulnerableTime: requiredNonnegativeFloat32(value, 'invulnerableTime'),
    ownerId: requiredUint32(value, 'ownerId', 'Snapshot entity is invalid.'),
    commandSeq: requiredUint32(value, 'commandSeq', 'Snapshot entity is invalid.'),
    ttl: requiredNonnegativeFloat32(value, 'ttl'),
    score: requiredUint32(value, 'score', 'Snapshot entity is invalid.'),
  };
  switch (value.kind) {
    case 'pickup':
      if (!isPickupEffect(value.effect)) throw new TypeError('Snapshot entity is invalid.');
      return { ...common, kind: 'pickup', effect: value.effect };
    case 'ship':
    case 'asteroid':
    case 'bullet':
    case 'explosion':
      if (value.effect !== undefined) throw new TypeError('Snapshot entity is invalid.');
      return { ...common, kind: value.kind };
    default:
      throw new TypeError('Snapshot entity is invalid.');
  }
}

function parseSnapshotAck(value: unknown): { entityId: number; seq: number } {
  if (!isRecord(value)) throw new TypeError('Snapshot acknowledgement is invalid.');
  return {
    entityId: requiredUint32(value, 'entityId', 'Snapshot acknowledgement is invalid.'),
    seq: requiredUint32(value, 'seq', 'Snapshot acknowledgement is invalid.'),
  };
}

function requiredFiniteNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('Snapshot entity is invalid.');
  }
  return value;
}

function requiredFloat32(record: Record<string, unknown>, key: string): number {
  const value = requiredFiniteNumber(record, key);
  if (!isFloat32Value(value)) throw new TypeError('Snapshot entity is invalid.');
  return value;
}

function requiredNonnegativeFloat32(record: Record<string, unknown>, key: string): number {
  const value = requiredFloat32(record, key);
  if (value < 0) throw new TypeError('Snapshot entity is invalid.');
  return value;
}

function requiredUint32(record: Record<string, unknown>, key: string, message: string): number {
  const value = record[key];
  if (!isUint32(value)) throw new TypeError(message);
  return value;
}

function requiredByte(record: Record<string, unknown>, key: string, message: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !isByte(value)) throw new TypeError(message);
  return value;
}

function requiredBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') throw new TypeError('Snapshot entity is invalid.');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeSnapshot(buffer: ArrayBuffer, view: DataView): BinarySnapshotMessage {
  if (buffer.byteLength < SNAPSHOT_HEADER_BYTES) {
    throw new RangeError('Snapshot header is truncated.');
  }
  const tick = view.getUint32(2, true);
  const entityCount = view.getUint16(6, true);
  const ackCount = view.getUint16(8, true);
  const expectedLength = SNAPSHOT_HEADER_BYTES + ackCount * ACK_BYTES + entityCount * ENTITY_BYTES;
  if (entityCount > 1000 || ackCount > 64 || buffer.byteLength !== expectedLength) {
    throw new RangeError('Snapshot packet length or counts are invalid.');
  }
  const acks: { entityId: number; seq: number }[] = [];
  let offset = SNAPSHOT_HEADER_BYTES;
  for (let index = 0; index < ackCount; index += 1) {
    acks.push({
      entityId: view.getUint32(offset, true),
      seq: view.getUint32(offset + 4, true),
    });
    offset += ACK_BYTES;
  }
  const entities: BinarySnapshotEntity[] = [];
  for (let index = 0; index < entityCount; index += 1) {
    const kind = ENTITY_KINDS[view.getUint8(offset + 4) - 1];
    const flags = view.getUint8(offset + 5);
    const pickupEffectId = (flags >> 3) & 0x03;
    const effect = PICKUP_EFFECTS[pickupEffectId - 1];
    if (
      kind === undefined ||
      (flags & 0xe0) !== 0 ||
      (kind === 'pickup' ? effect === undefined : pickupEffectId !== 0)
    ) {
      throw new RangeError('Snapshot entity type or flags are invalid.');
    }
    const common = {
      id: view.getUint32(offset, true),
      x: view.getFloat32(offset + 6, true),
      y: view.getFloat32(offset + 10, true),
      vx: view.getFloat32(offset + 14, true),
      vy: view.getFloat32(offset + 18, true),
      radius: view.getFloat32(offset + 22, true),
      angle: view.getInt16(offset + 26, true) / ANGLE_SCALE,
      hp: view.getUint8(offset + 28),
      thrust: Number(Boolean(flags & 1)),
      invulnerableTime: view.getFloat32(offset + 38, true),
      shield: Boolean(flags & 4),
      ownerId: view.getUint32(offset + 30, true),
      ttl: view.getFloat32(offset + 34, true),
      commandSeq: view.getUint32(offset + 42, true),
      score: view.getUint32(offset + 46, true),
    };
    let entity: BinarySnapshotEntity;
    if (kind === 'pickup') {
      if (effect === undefined) throw new RangeError('Snapshot entity type or flags are invalid.');
      entity = { ...common, kind, effect };
    } else {
      entity = { ...common, kind };
    }
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

export function encodeJson(message: unknown): string {
  return JSON.stringify(message);
}

export function decodeJson(data: unknown): unknown {
  if (typeof data !== 'string' && !(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
    throw new TypeError('JSON protocol data must be a string or byte buffer.');
  }
  const text =
    typeof data === 'string'
      ? data
      : TEXT_DECODER.decode(
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        );
  const message: unknown = JSON.parse(text);
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new TypeError('JSON protocol message must be an object.');
  }
  return message;
}

export function measureJsonBytes(message: unknown): number {
  return TEXT_ENCODER.encode(encodeJson(message)).byteLength;
}

export function measureBinaryBytes(message: BinaryMessage): number {
  return encodeBinary(message).byteLength;
}

export const jsonCodec: Codec<unknown, unknown> = {
  encode: encodeJson,
  decode: decodeJson,
};

export const binaryCodec: Codec<BinaryMessage, BinaryMessage> = {
  encode: encodeBinary,
  decode: decodeBinary,
};

function toArrayBuffer(data: unknown): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer;
  }
  throw new TypeError('Binary packet must be an ArrayBuffer or typed-array view.');
}

function isFloat32Value(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= 3.4028234663852886e38;
}

function isByte(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xff;
}

function isUint32(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff
  );
}
