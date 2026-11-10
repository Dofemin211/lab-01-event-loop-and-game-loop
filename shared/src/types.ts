export type Brand<Value, Name extends string> = Value & {
  readonly __brand: Name;
};

export type EntityId = Brand<number, 'EntityId'>;
export type Tick = Brand<number, 'Tick'>;
export type Seq = Brand<number, 'Seq'>;

function brandNumber<Name extends string>(
  value: number,
  name: Name,
  minimum: number,
): Brand<number, Name> {
  if (!Number.isSafeInteger(value) || value < minimum || value > 0xffff_ffff) {
    throw new RangeError(`${name} must be a valid unsigned 32-bit integer.`);
  }
  // The runtime representation is still a number; validation makes the brand safe here.
  return value as Brand<number, Name>;
}

export const entityId = (value: number): EntityId => brandNumber(value, 'EntityId', 0);
export const tick = (value: number): Tick => brandNumber(value, 'Tick', 0);
export const seq = (value: number): Seq => brandNumber(value, 'Seq', 1);

export type EntityKind = 'ship' | 'asteroid' | 'bullet' | 'pickup' | 'explosion';
export type PickupEffect = 'shield' | 'rapid-fire' | 'repair';
export type HomingTargetKind = 'ship' | 'asteroid';

export interface VectorLike {
  readonly x: number;
  readonly y: number;
}

export interface BaseEntitySnapshot {
  readonly id: EntityId;
  readonly pos: VectorLike;
  readonly vel: VectorLike;
  readonly angle: number;
  readonly radius: number;
  readonly alive: boolean;
  readonly collidable: boolean;
}

export interface HomingSnapshot {
  readonly targetKind: HomingTargetKind;
  readonly turnRate: number;
  readonly acceleration: number;
  readonly maxSpeed: number;
}

export interface ShipSnapshot extends BaseEntitySnapshot {
  readonly kind: 'ship';
  readonly hp: number;
  readonly maxHp: number;
  readonly playerId: string | null;
  readonly invulnerableTime: number;
  readonly thrust: number;
  readonly effects: readonly (readonly [PickupEffect, number])[];
  readonly weapon: Readonly<{ cooldown: number; baseInterval: number }>;
  readonly score: number;
}

export interface AsteroidSnapshot extends BaseEntitySnapshot {
  readonly kind: 'asteroid';
  readonly hp: number;
  readonly homing: HomingSnapshot | null;
}

export interface BulletSnapshot extends BaseEntitySnapshot {
  readonly kind: 'bullet';
  readonly ownerId: EntityId | null;
  readonly commandSeq: number;
  readonly damage: number;
  readonly ttl: number;
  readonly homing: HomingSnapshot | null;
}

export interface PickupSnapshot extends BaseEntitySnapshot {
  readonly kind: 'pickup';
  readonly effect: PickupEffect;
  readonly duration: number;
  readonly ttl: number;
}

export interface ExplosionParticleSnapshot {
  readonly pos: VectorLike;
  readonly vel: VectorLike;
  readonly lifetime: number;
  readonly remaining: number;
}

export interface ExplosionSnapshot extends BaseEntitySnapshot {
  readonly kind: 'explosion';
  readonly particles: readonly ExplosionParticleSnapshot[];
}

export type EntitySnapshot =
  ShipSnapshot | AsteroidSnapshot | BulletSnapshot | PickupSnapshot | ExplosionSnapshot;

export interface WorldSnapshot {
  readonly width: number;
  readonly height: number;
  readonly seed: number;
  readonly randomState: number;
  readonly nextEntityId: number;
  readonly entities: readonly EntitySnapshot[];
}

export interface InputCommand {
  readonly seq: Seq;
  readonly tick: Tick;
  readonly turn: -1 | 0 | 1;
  readonly thrust: boolean;
  readonly brake: boolean;
  readonly fire: boolean;
}

export interface InputReader {
  isDown(code: string): boolean;
}

export type WorldInput = InputReader | ReadonlyMap<string, InputReader>;

export interface SnapshotEntity {
  readonly id: EntityId;
  readonly kind: EntityKind;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly angle: number;
  readonly radius: number;
  readonly thrust: number;
  readonly hp: number;
  readonly shield: boolean;
  readonly effect?: PickupEffect;
  readonly invulnerableTime: number;
  readonly ownerId: EntityId;
  readonly commandSeq: Seq;
  readonly ttl: number;
  readonly score: number;
}

export interface SnapshotAck {
  readonly entityId: EntityId;
  readonly seq: Seq;
}

export interface NetworkSnapshot {
  readonly tick: Tick;
  readonly entities: readonly SnapshotEntity[];
  readonly acks: readonly SnapshotAck[];
}
