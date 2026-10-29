import { Entity } from './entity.js';
import { Vector2 } from './vector.js';

export class Pickup extends Entity {
  constructor(x = 0, y = 0, effect = 'shield', { id, duration = 8, ttl = 18 } = {}) {
    super({ id, pos: new Vector2(x, y), radius: 12, kind: 'pickup' });
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

  toSnapshot() {
    return { ...super.toSnapshot(), effect: this.effect, duration: this.duration, ttl: this.ttl };
  }

  static fromSnapshot(snapshot) {
    const pickup = new Pickup(snapshot.pos.x, snapshot.pos.y, snapshot.effect, {
      id: snapshot.id,
      duration: snapshot.duration,
      ttl: snapshot.ttl,
    });
    pickup.alive = snapshot.alive;
    return pickup;
  }
}
