import { Vector2 } from './vector.ts';
import type { HomingSnapshot } from '../types.ts';
import type { GameEntity } from './types.ts';
import type { World } from './world.ts';

function shortestAngleDifference(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

export interface HomingBehavior extends HomingSnapshot {
  update(entity: GameEntity, world: World, dt: number): void;
}

export function createHomingBehavior({
  targetKind,
  turnRate = 2.5,
  acceleration = 0,
  maxSpeed = 300,
}: Partial<HomingSnapshot> & Pick<HomingSnapshot, 'targetKind'>): HomingBehavior {
  if (!targetKind) {
    throw new TypeError('A homing behavior needs a target kind.');
  }

  return {
    targetKind,
    turnRate,
    acceleration,
    maxSpeed,
    update(entity: GameEntity, world: World, dt: number): void {
      let target = null;
      let nearestDistanceSquared = Infinity;

      for (const candidate of world.ofKind(targetKind)) {
        if (candidate.id === entity.id) {
          continue;
        }
        const distanceSquared = candidate.pos.sub(entity.pos).lengthSquared();
        if (distanceSquared < nearestDistanceSquared) {
          nearestDistanceSquared = distanceSquared;
          target = candidate;
        }
      }

      if (!target) {
        return;
      }

      const direction = target.pos.sub(entity.pos);
      if (direction.lengthSquared() === 0) {
        return;
      }
      const desiredAngle = Math.atan2(direction.y, direction.x);
      const angleChange = shortestAngleDifference(entity.angle, desiredAngle);
      entity.angle += Math.max(-turnRate * dt, Math.min(turnRate * dt, angleChange));

      const speed = Math.min(maxSpeed, entity.vel.length() + acceleration * dt);
      entity.vel = Vector2.fromAngle(entity.angle, speed);
    },
  };
}

export function attachHoming<T extends GameEntity & { homing?: HomingBehavior }>(
  entity: T,
  behavior: HomingBehavior,
): T {
  if (!behavior || typeof behavior.update !== 'function') {
    throw new TypeError('A homing component must provide an update function.');
  }
  entity.homing = behavior;
  return entity;
}
