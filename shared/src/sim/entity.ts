import { Vector2 } from './vector.ts';
import {
  entityId,
  type BaseEntitySnapshot,
  type EntityId,
  type EntityKind,
  type VectorLike,
} from '../types.ts';
import type { WorldInput } from '../types.ts';
import type { World } from './world.ts';

export interface EntityOptions<Kind extends EntityKind> {
  readonly id?: EntityId;
  readonly pos?: VectorLike;
  readonly vel?: VectorLike;
  readonly angle?: number;
  readonly radius?: number;
  readonly kind: Kind;
  readonly collidable?: boolean;
}

export class Entity<Kind extends EntityKind = EntityKind> {
  #id: EntityId;
  readonly kind: Kind;
  pos: Vector2;
  vel: Vector2;
  previousX: number;
  previousY: number;
  angle: number;
  radius: number;
  alive: boolean;
  collidable: boolean;
  idWasRestored: boolean;

  constructor(options: EntityOptions<Kind>) {
    const {
      id,
      pos = new Vector2(),
      vel = new Vector2(),
      angle = 0,
      radius = 0,
      kind,
      collidable = radius > 0,
    } = options;
    if (id !== undefined && (!Number.isInteger(id) || id < 1)) {
      throw new RangeError('Entity id must be a positive integer.');
    }
    this.#id = id ?? entityId(Entity.#nextId++);
    this.idWasRestored = id !== undefined;
    Entity.#nextId = Math.max(Entity.#nextId, this.#id + 1);
    this.pos = pos instanceof Vector2 ? pos.clone() : new Vector2(pos.x, pos.y);
    this.vel = vel instanceof Vector2 ? vel.clone() : new Vector2(vel.x, vel.y);
    this.previousX = this.pos.x;
    this.previousY = this.pos.y;
    this.angle = angle;
    this.radius = radius;
    this.alive = true;
    this.kind = kind;
    this.collidable = collidable;
  }

  static #nextId = 1;

  get id(): EntityId {
    return this.#id;
  }

  assignId(id: EntityId): void {
    if (!Number.isInteger(id) || id < 1) {
      throw new RangeError('Entity id must be a positive integer.');
    }
    this.#id = id;
    this.idWasRestored = true;
  }

  toSnapshot(): BaseEntitySnapshot & { readonly kind: Kind } {
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

  static fromSnapshot(snapshot: BaseEntitySnapshot & { readonly kind: EntityKind }): Entity {
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

  update(dt: number, _input?: WorldInput, _world?: World): void {
    this.pos = this.pos.add(this.vel.scale(dt));
  }
}
