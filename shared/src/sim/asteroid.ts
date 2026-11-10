import { Entity } from './entity.ts';
import { createHomingBehavior } from './homing.ts';
import { Vector2 } from './vector.ts';
import type { AsteroidSnapshot, EntityId, VectorLike, WorldInput } from '../types.ts';
import type { HomingBehavior } from './homing.ts';
import type { World } from './world.ts';

export interface AsteroidOptions {
  readonly id?: EntityId;
  readonly radius?: number;
  readonly vel?: VectorLike;
  readonly hp?: number;
  readonly homing?: HomingBehavior | null;
}

export class Asteroid extends Entity<'asteroid'> {
  #hp;
  homing?: HomingBehavior;

  constructor(
    x = 0,
    y = 0,
    { id, radius = 25, vel = new Vector2(), hp = 2, homing = null }: AsteroidOptions = {},
  ) {
    super({ id, pos: new Vector2(x, y), vel, radius, kind: 'asteroid' });
    this.#hp = hp;
    if (homing) {
      this.homing = homing;
    }
  }

  get hp(): number {
    return this.#hp;
  }

  takeDamage(amount = 1): boolean {
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

  override update(dt: number, _input: WorldInput, world: World): void {
    this.homing?.update(this, world, dt);
    super.update(dt);
    if (this.pos.x < this.radius || this.pos.x > world.width - this.radius) {
      this.pos = new Vector2(
        Math.max(this.radius, Math.min(world.width - this.radius, this.pos.x)),
        this.pos.y,
      );
      this.vel = new Vector2(-this.vel.x, this.vel.y);
    }
    if (this.pos.y < this.radius || this.pos.y > world.height - this.radius) {
      this.pos = new Vector2(
        this.pos.x,
        Math.max(this.radius, Math.min(world.height - this.radius, this.pos.y)),
      );
      this.vel = new Vector2(this.vel.x, -this.vel.y);
    }
  }

  override toSnapshot(): AsteroidSnapshot {
    return {
      ...super.toSnapshot(),
      hp: this.#hp,
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

  static fromSnapshot(snapshot: AsteroidSnapshot): Asteroid {
    const asteroid = new Asteroid(snapshot.pos.x, snapshot.pos.y, {
      id: snapshot.id,
      radius: snapshot.radius,
      vel: snapshot.vel,
      hp: snapshot.hp,
      homing: snapshot.homing ? createHomingBehavior(snapshot.homing) : null,
    });
    asteroid.angle = snapshot.angle;
    asteroid.alive = snapshot.alive;
    return asteroid;
  }
}
