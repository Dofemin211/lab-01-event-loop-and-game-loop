import { Entity } from './entity.js';
import { Vector2 } from './vector.js';

export class Bullet extends Entity {
  constructor({
    pos = new Vector2(),
    vel = new Vector2(),
    angle = 0,
    ownerId = null,
    damage = 1,
    ttl = 1.8,
    homing = null,
  } = {}) {
    super({ pos, vel, angle, radius: 3, kind: 'bullet' });
    this.ownerId = ownerId;
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
}
