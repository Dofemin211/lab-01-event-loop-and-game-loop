import { Entity } from './entity.js';
import { createHomingBehavior } from './homing.js';
import { Vector2 } from './vector.js';

export class Bullet extends Entity {
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
  } = {}) {
    super({ id, pos, vel, angle, radius: 3, kind: 'bullet' });
    this.ownerId = ownerId;
    this.commandSeq = commandSeq;
    this.damage = damage;
    this.ttl = ttl;
    if (homing) {
      this.homing = homing;
    }
  }

  update(dt, _input, world) {
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

  toSnapshot() {
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

  static fromSnapshot(snapshot) {
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
