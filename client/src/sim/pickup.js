import { Entity } from './entity.js';
import { Vector2 } from './vector.js';

export class Pickup extends Entity {
  constructor(x = 0, y = 0, effect = 'shield', { duration = 8, ttl = 18 } = {}) {
    super({ pos: new Vector2(x, y), radius: 12, kind: 'pickup' });
    this.effect = effect;
    this.duration = duration;
    this.ttl = ttl;
  }

  update(dt) {
    this.ttl -= dt;
    if (this.ttl <= 0) {
      this.alive = false;
    }
  }

  applyTo(ship) {
    if (this.effect === 'repair') {
      ship.repair();
    } else {
      ship.applyPickup(this.effect, this.duration);
    }
  }
}
