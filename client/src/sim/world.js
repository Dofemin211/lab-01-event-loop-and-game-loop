import { Asteroid } from './asteroid.js';
import { collisionPairs, resolveCollisions } from './collision.js';
import { Explosion } from './explosion.js';
import { Pickup } from './pickup.js';
import { Vector2 } from './vector.js';

const NO_INPUT = Object.freeze({ isDown: () => false });

export class World {
  #entities = new Map();
  #pendingRemoval = new Set();
  #randomState;
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
    this.#randomState = seed >>> 0;
    this.#collisionSystem = collisionSystem;
    this.emit = emit;
  }

  get size() {
    return this.#entities.size;
  }

  spawn(entity) {
    if (!entity || !Number.isInteger(entity.id)) {
      throw new TypeError('World.spawn expects an Entity with an integer id.');
    }
    if (this.#entities.has(entity.id)) {
      throw new Error(`Entity ${entity.id} is already in this world.`);
    }
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
    this.#randomState = (1664525 * this.#randomState + 1013904223) >>> 0;
    return this.#randomState / 4294967296;
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
}
