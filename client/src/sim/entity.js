import { Vector2 } from './vector.js';

export class Entity {
  static #nextId = 1;
  #id = Entity.#nextId++;

  constructor({
    pos = new Vector2(),
    vel = new Vector2(),
    angle = 0,
    radius = 0,
    kind = 'entity',
    collidable = radius > 0,
  } = {}) {
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

  update(dt) {
    this.pos.addInPlace(this.vel.scale(dt));
  }
}
