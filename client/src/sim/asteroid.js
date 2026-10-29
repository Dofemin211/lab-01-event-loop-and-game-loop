import { Entity } from './entity.js';
import { Vector2 } from './vector.js';

export class Asteroid extends Entity {
  #hp;

  constructor(x = 0, y = 0, { radius = 25, vel = new Vector2(), hp = 2, homing = null } = {}) {
    super({ pos: new Vector2(x, y), vel, radius, kind: 'asteroid' });
    this.#hp = hp;
    if (homing) {
      this.homing = homing;
    }
  }

  get hp() {
    return this.#hp;
  }

  takeDamage(amount = 1) {
    if (!this.alive) {
      return false;
    }
    this.#hp = Math.max(0, this.#hp - amount);
    if (this.#hp === 0) {
      this.alive = false;
      return true;
    }
    return false;
  }

  update(dt, _input, world) {
    this.homing?.update(this, world, dt);
    super.update(dt);
    if (this.pos.x < this.radius || this.pos.x > world.width - this.radius) {
      this.pos.x = Math.max(this.radius, Math.min(world.width - this.radius, this.pos.x));
      this.vel.x *= -1;
    }
    if (this.pos.y < this.radius || this.pos.y > world.height - this.radius) {
      this.pos.y = Math.max(this.radius, Math.min(world.height - this.radius, this.pos.y));
      this.vel.y *= -1;
    }
  }
}
