import { Entity } from './entity.ts';
import { Bullet } from './bullet.ts';
import { Vector2 } from './vector.ts';
import type { EntityId, PickupEffect, ShipSnapshot, VectorLike } from '../types.ts';
import type { InputReader } from '../types.ts';
import type { World } from './world.ts';

export const SHIP_TUNING = Object.freeze({
  rotationSpeed: 4.2,
  thrustAcceleration: 280,
  drag: 0.18,
  maxSpeed: 320,
  brakeStrength: 3.5,
});

export function createShip(x = 0, y = 0): ShipState {
  return { x, y, vx: 0, vy: 0, angle: -Math.PI / 2, thrust: 0 };
}

export interface ShipOptions {
  readonly id?: EntityId;
  readonly angle?: number;
  readonly hp?: number;
  readonly invulnerableTime?: number;
  readonly playerId?: string | null;
  readonly vel?: VectorLike;
}

export interface ShipState {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly angle: number;
  readonly thrust: number;
}

export interface WeaponState {
  cooldown: number;
  baseInterval: number;
}

export class Ship extends Entity<'ship'> {
  #hp;
  #maxHp;
  playerId: string | null;
  invulnerableTime: number;
  thrust: number;
  effects: Map<PickupEffect, number>;
  weapon: WeaponState;
  score: number;

  constructor(
    x = 0,
    y = 0,
    {
      id,
      angle = -Math.PI / 2,
      hp = 3,
      invulnerableTime = 1.5,
      playerId = null,
      vel = new Vector2(),
    }: ShipOptions = {},
  ) {
    super({ id, pos: new Vector2(x, y), vel, angle, radius: 13, kind: 'ship' });
    this.#hp = hp;
    this.#maxHp = hp;
    this.playerId = playerId;
    this.invulnerableTime = invulnerableTime;
    this.thrust = 0;
    this.effects = new Map();
    this.weapon = { cooldown: 0, baseInterval: 0.22 };
    this.score = 0;
  }

  get hp(): number {
    return this.#hp;
  }

  get maxHp(): number {
    return this.#maxHp;
  }

  override update(
    dt: number,
    input: InputReader | ReadonlyMap<string, InputReader>,
    world: World,
  ): void {
    const shipInput = input instanceof Map ? input.get(this.playerId) : input;
    this.weapon.cooldown = Math.max(0, this.weapon.cooldown - dt);
    this.invulnerableTime = Math.max(0, this.invulnerableTime - dt);
    for (const [effect, remaining] of this.effects) {
      const nextRemaining = remaining - dt;
      if (nextRemaining <= 0) {
        this.effects.delete(effect);
      } else {
        this.effects.set(effect, nextRemaining);
      }
    }

    const state = integrateState(
      {
        x: this.pos.x,
        y: this.pos.y,
        vx: this.vel.x,
        vy: this.vel.y,
        angle: this.angle,
        thrust: this.thrust,
      },
      shipInput ?? { isDown: () => false },
      dt,
    );
    this.angle = state.angle;
    this.thrust = state.thrust;
    this.vel = new Vector2(state.vx, state.vy);
    this.pos = new Vector2(
      ((state.x % world.width) + world.width) % world.width,
      ((state.y % world.height) + world.height) % world.height,
    );
  }

  fire(world: World, commandSeq = 0): Bullet | null {
    if (!this.alive || this.weapon.cooldown > 0) {
      return null;
    }

    const direction = Vector2.fromAngle(this.angle);
    const rapidFire = this.effects.has('rapid-fire');
    this.weapon.cooldown = this.weapon.baseInterval * (rapidFire ? 0.42 : 1);
    const bullet = new Bullet({
      pos: this.pos.add(direction.scale(this.radius + 5)),
      vel: this.vel.add(direction.scale(460)),
      angle: this.angle,
      ownerId: this.id,
      commandSeq,
    });
    world.spawn(bullet);
    world.emit('fired', { ship: this, bullet });
    return bullet;
  }

  takeDamage(amount = 1): boolean {
    if (!this.alive || this.invulnerableTime > 0 || this.effects.has('shield')) {
      return false;
    }

    this.#hp = Math.max(0, this.#hp - amount);
    if (this.#hp === 0) {
      this.alive = false;
      return true;
    }
    return false;
  }

  applyPickup(effect: PickupEffect, duration: number): void {
    this.effects.set(effect, duration);
  }

  repair(amount = 1): void {
    this.#hp = Math.min(this.#maxHp, this.#hp + amount);
  }

  override toSnapshot(): ShipSnapshot {
    return {
      ...super.toSnapshot(),
      hp: this.#hp,
      maxHp: this.#maxHp,
      playerId: this.playerId,
      invulnerableTime: this.invulnerableTime,
      thrust: this.thrust,
      effects: [...this.effects],
      weapon: { ...this.weapon },
      score: this.score,
    };
  }

  static fromSnapshot(snapshot: ShipSnapshot): Ship {
    const ship = new Ship(snapshot.pos.x, snapshot.pos.y, {
      id: snapshot.id,
      angle: snapshot.angle,
      hp: snapshot.hp,
      invulnerableTime: snapshot.invulnerableTime,
      playerId: snapshot.playerId,
      vel: snapshot.vel,
    });
    ship.thrust = snapshot.thrust;
    ship.effects = new Map(snapshot.effects ?? []);
    ship.weapon = { ...ship.weapon, ...snapshot.weapon };
    ship.score = snapshot.score ?? 0;
    ship.alive = snapshot.alive;
    return ship;
  }
}

function integrateState(ship: ShipState, input: InputReader, dt: number): ShipState {
  if (!Number.isFinite(dt) || dt < 0) {
    throw new RangeError('dt must be a non-negative finite number.');
  }

  const turn =
    Number(input.isDown('ArrowRight') || input.isDown('KeyD')) -
    Number(input.isDown('ArrowLeft') || input.isDown('KeyA'));
  const isThrusting = input.isDown('ArrowUp') || input.isDown('KeyW');
  const isBraking = input.isDown('Space');
  const angle = ship.angle + turn * SHIP_TUNING.rotationSpeed * dt;
  const drag = Math.exp(-(SHIP_TUNING.drag + (isBraking ? SHIP_TUNING.brakeStrength : 0)) * dt);
  let vx =
    (ship.vx + Math.cos(angle) * SHIP_TUNING.thrustAcceleration * Number(isThrusting) * dt) * drag;
  let vy =
    (ship.vy + Math.sin(angle) * SHIP_TUNING.thrustAcceleration * Number(isThrusting) * dt) * drag;
  const speed = Math.hypot(vx, vy);

  if (speed > SHIP_TUNING.maxSpeed) {
    const speedScale = SHIP_TUNING.maxSpeed / speed;
    vx *= speedScale;
    vy *= speedScale;
  }

  return {
    x: ship.x + vx * dt,
    y: ship.y + vy * dt,
    vx,
    vy,
    angle,
    thrust: Number(isThrusting),
  };
}

// Lab 01 compatibility adapter; the class and adapter share exactly the same physics tuning.
export function integrate(ship: ShipState, input: InputReader, dt: number): ShipState {
  return integrateState(ship, input, dt);
}

function interpolateCoordinate(
  previous: number,
  current: number,
  alpha: number,
  size: number,
): number {
  if (!size) {
    return previous + (current - previous) * alpha;
  }

  let difference = current - previous;
  if (difference > size / 2) {
    difference -= size;
  } else if (difference < -size / 2) {
    difference += size;
  }
  return (((previous + difference * alpha) % size) + size) % size;
}

export function interpolateShip(
  previous: ShipState,
  current: ShipState,
  alpha: number,
  width: number,
  height: number,
): ShipState {
  const angleDifference = Math.atan2(
    Math.sin(current.angle - previous.angle),
    Math.cos(current.angle - previous.angle),
  );
  return {
    x: interpolateCoordinate(previous.x, current.x, alpha, width),
    y: interpolateCoordinate(previous.y, current.y, alpha, height),
    vx: previous.vx + (current.vx - previous.vx) * alpha,
    vy: previous.vy + (current.vy - previous.vy) * alpha,
    angle: previous.angle + angleDifference * alpha,
    thrust: alpha < 0.5 ? previous.thrust : current.thrust,
  };
}
