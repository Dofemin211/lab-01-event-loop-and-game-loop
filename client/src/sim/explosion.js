import { Entity } from './entity.js';
import { Vector2 } from './vector.js';

export class Explosion extends Entity {
  constructor(x = 0, y = 0, random = Math.random, particleCount = 14) {
    super({ pos: new Vector2(x, y), radius: 0, kind: 'explosion', collidable: false });
    this.particles = Array.from({ length: particleCount }, () => {
      const angle = random() * Math.PI * 2;
      const speed = 35 + random() * 150;
      const lifetime = 0.35 + random() * 0.6;
      return {
        pos: this.pos.clone(),
        vel: Vector2.fromAngle(angle, speed),
        lifetime,
        remaining: lifetime,
      };
    });
  }

  update(dt) {
    for (const particle of this.particles) {
      particle.remaining -= dt;
      particle.pos.addInPlace(particle.vel.scale(dt));
    }
    this.particles = this.particles.filter((particle) => particle.remaining > 0);
    if (this.particles.length === 0) {
      this.alive = false;
    }
  }
}
