import { Entity } from './entity.ts';
import { createHomingBehavior } from './homing.ts';
import { Vector2 } from './vector.ts';
import type { BulletSnapshot, EntityId, VectorLike, WorldInput } from '../types.ts';
import type { HomingBehavior } from './homing.ts';
import type { World } from './world.ts';

export interface BulletOptions {
  readonly id?: EntityId;
  readonly pos?: VectorLike;
  readonly vel?: VectorLike;
  readonly angle?: number;
  readonly ownerId?: EntityId | null;
  readonly commandSeq?: number;
  readonly damage?: number;
  readonly ttl?: number;
  readonly homing?: HomingBehavior | null;
}

export class Bullet extends Entity<'bullet'> {
  homing?: HomingBehavior;
  ownerId: EntityId | null;
  commandSeq: number;
  damage: number;
  ttl: number;

  constructor({
    id,
    pos = new Vector2(),
    vel = new Vector2(),
    angle = 0,
    ownerId = null,
    commandSeq = 0,
    damage = 1,
    ttl = 1.8,
    homing = null,
  }: BulletOptions = {}) {
    super({ id, pos, vel, angle, radius: 3, kind: 'bullet' });
    this.ownerId = ownerId;
    this.commandSeq = commandSeq;
    this.damage = damage;
    this.ttl = ttl;
    if (homing) {
      this.homing = homing;
    }
  }

  override update(dt: number, _input: WorldInput, world: World): void {
    this.ttl -= dt;
    if (this.ttl <= 0) {
      this.alive = false;
      return;
    }
    this.homing?.update(this, world, dt);
    super.update(dt);
    if (
      this.pos.x < -this.radius ||
      this.pos.x > world.width + this.radius ||
      this.pos.y < -this.radius ||
      this.pos.y > world.height + this.radius
    ) {
      this.alive = false;
    }
  }

  override toSnapshot(): BulletSnapshot {
    return {
      ...super.toSnapshot(),
      ownerId: this.ownerId,
      commandSeq: this.commandSeq,
      damage: this.damage,
      ttl: this.ttl,
      homing: this.homing
        ? {
            targetKind: this.homing.targetKind,
            turnRate: this.homing.turnRate,
            acceleration: this.homing.acceleration,
            maxSpeed: this.homing.maxSpeed,
          }
        : null,
    };
  }

  static fromSnapshot(snapshot: BulletSnapshot): Bullet {
    const bullet = new Bullet({
      id: snapshot.id,
      pos: snapshot.pos,
      vel: snapshot.vel,
      angle: snapshot.angle,
      ownerId: snapshot.ownerId,
      commandSeq: snapshot.commandSeq,
      damage: snapshot.damage,
      ttl: snapshot.ttl,
      homing: snapshot.homing ? createHomingBehavior(snapshot.homing) : null,
    });
    bullet.alive = snapshot.alive;
    return bullet;
  }
}
