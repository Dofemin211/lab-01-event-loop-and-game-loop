import { Entity } from './entity.ts';
import { Vector2 } from './vector.ts';
import { mulberry32 } from '../prng.ts';
import type { EntityId, ExplosionParticleSnapshot, ExplosionSnapshot } from '../types.ts';

export interface ExplosionParticle {
  pos: Vector2;
  vel: Vector2;
  lifetime: number;
  remaining: number;
}

export class Explosion extends Entity<'explosion'> {
  particles: ExplosionParticle[];

  constructor(
    x = 0,
    y = 0,
    random: () => number = mulberry32(0),
    particleCount = 14,
    id?: EntityId,
  ) {
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

  override update(dt: number): void {
    for (const particle of this.particles) {
      particle.remaining -= dt;
      particle.pos.addInPlace(particle.vel.scale(dt));
    }
    this.particles = this.particles.filter((particle) => particle.remaining > 0);
    if (this.particles.length === 0) {
      this.alive = false;
    }
  }

  override toSnapshot(): ExplosionSnapshot {
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

  static fromSnapshot(snapshot: ExplosionSnapshot): Explosion {
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
