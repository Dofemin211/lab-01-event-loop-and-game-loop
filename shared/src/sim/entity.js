import { Vector2 } from './vector.js';

export class Entity {
  static #nextId = 1;
  #id;

  constructor({
    id,
    pos = new Vector2(),
    vel = new Vector2(),
    angle = 0,
    radius = 0,
    kind = 'entity',
    collidable = radius > 0,
  } = {}) {
    if (id !== undefined && (!Number.isInteger(id) || id < 1)) {
      throw new RangeError('Entity id must be a positive integer.');
    }
    this.#id = id ?? Entity.#nextId++;
    this.idWasRestored = id !== undefined;
    Entity.#nextId = Math.max(Entity.#nextId, this.#id + 1);
    this.pos = pos instanceof Vector2 ? pos.clone() : new Vector2(pos.x, pos.y);
    this.vel = vel instanceof Vector2 ? vel.clone() : new Vector2(vel.x, vel.y);
    this.angle = angle;
    this.radius = radius;
    this.alive = true;
    this.kind = kind;
    this.collidable = collidable;
  }

  get id() {
    return this.#id;
  }

  assignId(id) {
    if (!Number.isInteger(id) || id < 1) {
      throw new RangeError('Entity id must be a positive integer.');
    }
    this.#id = id;
    this.idWasRestored = true;
  }

  toSnapshot() {
    return {
      id: this.id,
      kind: this.kind,
      pos: { x: this.pos.x, y: this.pos.y },
      vel: { x: this.vel.x, y: this.vel.y },
      angle: this.angle,
      radius: this.radius,
      alive: this.alive,
      collidable: this.collidable,
    };
  }

  static fromSnapshot(snapshot) {
    const entity = new Entity({
      id: snapshot.id,
      pos: snapshot.pos,
      vel: snapshot.vel,
      angle: snapshot.angle,
      radius: snapshot.radius,
      kind: snapshot.kind,
      collidable: snapshot.collidable,
    });
    entity.alive = snapshot.alive;
    return entity;
  }

  update(dt) {
    this.pos.addInPlace(this.vel.scale(dt));
  }
}
