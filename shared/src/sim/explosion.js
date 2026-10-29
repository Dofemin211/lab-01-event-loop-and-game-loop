import { Entity } from './entity.js';
import { Vector2 } from './vector.js';
import { mulberry32 } from '../prng.js';

export class Explosion extends Entity {
  constructor(x = 0, y = 0, random = mulberry32(0), particleCount = 14, id) {
    super({ id, pos: new Vector2(x, y), radius: 0, kind: 'explosion', collidable: false });
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

  toSnapshot() {
    return {
      ...super.toSnapshot(),
      particles: this.particles.map((particle) => ({
        pos: { x: particle.pos.x, y: particle.pos.y },
        vel: { x: particle.vel.x, y: particle.vel.y },
        lifetime: particle.lifetime,
        remaining: particle.remaining,
      })),
    };
  }

  static fromSnapshot(snapshot) {
    const explosion = new Explosion(snapshot.pos.x, snapshot.pos.y, () => 0.5, 0, snapshot.id);
    explosion.particles = snapshot.particles.map((particle) => ({
      pos: new Vector2(particle.pos.x, particle.pos.y),
      vel: new Vector2(particle.vel.x, particle.vel.y),
      lifetime: particle.lifetime,
      remaining: particle.remaining,
    }));
    explosion.alive = snapshot.alive;
    return explosion;
  }
}
