import { Asteroid } from './asteroid.js';
import { Bullet } from './bullet.js';
import { collisionPairs, resolveCollisions } from './collision.js';
import { Explosion } from './explosion.js';
import { Pickup } from './pickup.js';
import { Ship } from './ship.js';
import { Vector2 } from './vector.js';
import { mulberry32 } from '../prng.js';

const NO_INPUT = Object.freeze({ isDown: () => false });

export class World {
  #entities = new Map();
  #pendingRemoval = new Set();
  #random;
  #seed;
  #nextEntityId = 1;
  #collisionSystem;

  constructor({
    width = 800,
    height = 600,
    seed = 2025,
    collisionSystem = collisionPairs,
    emit = () => {},
  } = {}) {
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

  get size() {
    return this.#entities.size;
  }

  spawn(entity) {
    if (!entity || typeof entity.assignId !== 'function') {
      throw new TypeError('World.spawn expects an Entity with an integer id.');
    }
    if (!entity.idWasRestored) {
      entity.assignId(this.#nextEntityId);
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

  despawn(id) {
    const entity = this.#entities.get(id);
    if (!entity) {
      return false;
    }
    entity.alive = false;
    this.#pendingRemoval.add(id);
    return true;
  }

  get(id) {
    return this.#entities.get(id);
  }

  *[Symbol.iterator]() {
    yield* this.#entities.values();
  }

  *ofKind(kind) {
    for (const entity of this.#entities.values()) {
      if (entity.alive && entity.kind === kind) {
        yield entity;
      }
    }
  }

  random() {
    return this.#random();
  }

  createExplosion(x, y) {
    return new Explosion(x, y, () => this.random());
  }

  createPickup(x, y, effect) {
    return new Pickup(x, y, effect);
  }

  safePosition(radius, avoidKind = 'asteroid') {
    const candidates = [];
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

  resize(width, height) {
    if (width <= 0 || height <= 0) {
      throw new RangeError('World width and height must be positive.');
    }
    this.width = width;
    this.height = height;
    for (const entity of this.#entities.values()) {
      if (entity.kind === 'ship' || entity.kind === 'bullet' || entity.kind === 'pickup') {
        entity.pos.x = ((entity.pos.x % width) + width) % width;
        entity.pos.y = ((entity.pos.y % height) + height) % height;
      }
    }
  }

  step(dt, inputs = NO_INPUT) {
    if (!Number.isFinite(dt) || dt < 0) {
      throw new RangeError('dt must be a non-negative finite number.');
    }

    // A snapshot keeps entities spawned during this step from updating until the next step.
    const entitiesAtStepStart = [...this.#entities.values()];
    for (const entity of entitiesAtStepStart) {
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

  addAsteroid(x, y, options = {}) {
    return this.spawn(new Asteroid(x, y, options));
  }

  toSnapshot() {
    return {
      width: this.width,
      height: this.height,
      seed: this.#seed,
      randomState: this.#random.getState(),
      nextEntityId: this.#nextEntityId,
      entities: [...this.#entities.values()].map((entity) => entity.toSnapshot()),
    };
  }

  static fromSnapshot(snapshot, options = {}) {
    if (
      !snapshot ||
      !Number.isInteger(snapshot.width) ||
      !Number.isInteger(snapshot.height) ||
      !Number.isInteger(snapshot.seed) ||
      !Number.isInteger(snapshot.randomState) ||
      !Array.isArray(snapshot.entities)
    ) {
      throw new TypeError('World snapshot is invalid.');
    }
    const world = new World({
      width: snapshot.width,
      height: snapshot.height,
      seed: snapshot.seed,
      ...options,
    });
    world.#random.setState(snapshot.randomState);
    for (const data of snapshot.entities) {
      const constructors = {
        ship: Ship,
        asteroid: Asteroid,
        bullet: Bullet,
        pickup: Pickup,
        explosion: Explosion,
      };
      const Constructor = constructors[data.kind];
      if (!Constructor || typeof Constructor.fromSnapshot !== 'function') {
        throw new TypeError(`World snapshot contains unsupported entity "${data.kind}".`);
      }
      world.spawn(Constructor.fromSnapshot(data));
    }
    world.#nextEntityId = Math.max(world.#nextEntityId, snapshot.nextEntityId ?? 1);
    return world;
  }
}
