import { Asteroid } from './asteroid.ts';
import { Bullet } from './bullet.ts';
import { collisionPairs, resolveCollisions } from './collision.ts';
import type { CollisionEvent, GameEntity } from './types.ts';
import type { CollisionSystem } from './collision.ts';
import { Explosion } from './explosion.ts';
import { Pickup } from './pickup.ts';
import { Ship } from './ship.ts';
import { Vector2 } from './vector.ts';
import { mulberry32 } from '../prng.ts';
import {
  entityId,
  type EntityId,
  type EntityKind,
  type EntitySnapshot,
  type PickupEffect,
  type WorldInput,
  type WorldSnapshot,
} from '../types.ts';

const NO_INPUT = Object.freeze({ isDown: (): boolean => false });

export interface WorldOptions {
  readonly width?: number;
  readonly height?: number;
  readonly seed?: number;
  readonly collisionSystem?: CollisionSystem;
  readonly emit?: (type: string, detail: unknown) => void;
}

export class World implements Iterable<GameEntity> {
  #entities = new Map<EntityId, GameEntity>();
  #pendingRemoval = new Set<EntityId>();
  #random: ReturnType<typeof mulberry32>;
  #seed: number;
  #nextEntityId = 1;
  #collisionSystem: CollisionSystem;
  readonly emit: (type: string, detail: unknown) => void;
  width: number;
  height: number;

  constructor({
    width = 800,
    height = 600,
    seed = 2025,
    collisionSystem = collisionPairs,
    emit = () => {},
  }: WorldOptions = {}) {
    if (width <= 0 || height <= 0) {
      throw new RangeError('World width and height must be positive.');
    }
    this.width = width;
    this.height = height;
    this.#seed = seed >>> 0;
    this.#random = mulberry32(seed);
    this.#collisionSystem = collisionSystem;
    this.emit = emit;
  }

  get size(): number {
    return this.#entities.size;
  }

  spawn<T extends GameEntity>(entity: T): T {
    if (!entity.idWasRestored) {
      entity.assignId(entityId(this.#nextEntityId));
    }
    if (this.#entities.has(entity.id)) {
      throw new Error(`Entity ${entity.id} is already in this world.`);
    }
    this.#nextEntityId = Math.max(this.#nextEntityId, entity.id + 1);
    entity.idWasRestored = false;
    entity.alive = true;
    this.#entities.set(entity.id, entity);
    return entity;
  }

  despawn(id: EntityId): boolean {
    const entity = this.#entities.get(id);
    if (!entity) {
      return false;
    }
    entity.alive = false;
    this.#pendingRemoval.add(id);
    return true;
  }

  get(id: EntityId): GameEntity | undefined {
    return this.#entities.get(id);
  }

  *[Symbol.iterator](): Generator<GameEntity> {
    yield* this.#entities.values();
  }

  *ofKind<Kind extends EntityKind>(
    kind: Kind,
  ): Generator<Extract<GameEntity, { readonly kind: Kind }>> {
    for (const entity of this.#entities.values()) {
      if (entity.alive && isEntityKind(entity, kind)) {
        yield entity;
      }

      function isEntityKind<Kind extends EntityKind>(
        entity: GameEntity,
        kind: Kind,
      ): entity is Extract<GameEntity, { readonly kind: Kind }> {
        return entity.kind === kind;
      }
    }
  }

  random(): number {
    return this.#random();
  }

  createExplosion(x: number, y: number): Explosion {
    return new Explosion(x, y, () => this.random());
  }

  createPickup(x: number, y: number, effect: PickupEffect): Pickup {
    return new Pickup(x, y, effect);
  }

  safePosition(radius: number, avoidKind: EntityKind = 'asteroid'): Vector2 {
    const candidates: Vector2[] = [];
    for (let attempt = 0; attempt < 48; attempt += 1) {
      const point = new Vector2(this.random() * this.width, this.random() * this.height);
      const safe = [...this.ofKind(avoidKind)].every((entity) => {
        const distance = entity.pos.sub(point).length();
        return distance >= entity.radius + radius + 48;
      });
      if (safe) {
        return point;
      }
      candidates.push(point);
    }

    let safest = new Vector2(this.width / 2, this.height / 2);
    let greatestClearance = -Infinity;
    for (const point of candidates) {
      const clearance = [...this.ofKind(avoidKind)].reduce(
        (minimum, entity) =>
          Math.min(minimum, entity.pos.sub(point).length() - entity.radius - radius),
        Infinity,
      );
      if (clearance > greatestClearance) {
        safest = point;
        greatestClearance = clearance;
      }
    }
    return safest;
  }

  resize(width: number, height: number): void {
    if (width <= 0 || height <= 0) {
      throw new RangeError('World width and height must be positive.');
    }
    this.width = width;
    this.height = height;
    for (const entity of this.#entities.values()) {
      if (entity.kind === 'ship' || entity.kind === 'bullet' || entity.kind === 'pickup') {
        entity.pos = new Vector2(
          ((entity.pos.x % width) + width) % width,
          ((entity.pos.y % height) + height) % height,
        );
      }
    }
  }

  step(dt: number, inputs: WorldInput = NO_INPUT): CollisionEvent[] {
    if (!Number.isFinite(dt) || dt < 0) {
      throw new RangeError('dt must be a non-negative finite number.');
    }

    const entitiesAtStepStart = [...this.#entities.values()];
    for (const entity of entitiesAtStepStart) {
      entity.previousX = entity.pos.x;
      entity.previousY = entity.pos.y;
      if (entity.alive) {
        entity.update(dt, inputs, this);
      }
    }

    const events = resolveCollisions(this, this.#collisionSystem(this));
    for (const entity of this.#entities.values()) {
      if (!entity.alive) {
        this.#pendingRemoval.add(entity.id);
      }
    }
    for (const id of this.#pendingRemoval) {
      this.#entities.delete(id);
    }
    this.#pendingRemoval.clear();
    return events;
  }

  addAsteroid(
    x: number,
    y: number,
    options: ConstructorParameters<typeof Asteroid>[2] = {},
  ): Asteroid {
    return this.spawn(new Asteroid(x, y, options));
  }

  toSnapshot(): WorldSnapshot {
    return {
      width: this.width,
      height: this.height,
      seed: this.#seed,
      randomState: this.#random.getState(),
      nextEntityId: this.#nextEntityId,
      entities: [...this.#entities.values()].map((entity) => entity.toSnapshot()),
    };
  }

  static fromSnapshot(snapshot: WorldSnapshot, options: WorldOptions = {}): World {
    const world = new World({
      width: snapshot.width,
      height: snapshot.height,
      seed: snapshot.seed,
      ...options,
    });
    world.#random.setState(snapshot.randomState);
    for (const data of snapshot.entities) {
      world.spawn(World.#restoreEntity(data));
    }
    world.#nextEntityId = Math.max(world.#nextEntityId, snapshot.nextEntityId);
    return world;
  }

  static #restoreEntity(data: EntitySnapshot): GameEntity {
    switch (data.kind) {
      case 'ship':
        return Ship.fromSnapshot(data);
      case 'asteroid':
        return Asteroid.fromSnapshot(data);
      case 'bullet':
        return Bullet.fromSnapshot(data);
      case 'pickup':
        return Pickup.fromSnapshot(data);
      case 'explosion':
        return Explosion.fromSnapshot(data);
      default:
        return World.#unreachable(data);
    }
  }

  static #unreachable(value: never): never {
    throw new TypeError(`World snapshot contains unsupported entity "${String(value)}".`);
  }
}
