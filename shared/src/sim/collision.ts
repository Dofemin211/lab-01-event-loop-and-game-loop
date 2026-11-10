import type { GameEntity, CollisionEvent } from './types.ts';
import type { World } from './world.ts';

export type CollisionPair = readonly [GameEntity, GameEntity];
export type CollisionSystem = (world: World) => Iterable<CollisionPair>;

export function circlesOverlap(a: GameEntity, b: GameEntity): boolean {
  if (!a.alive || !b.alive || !a.collidable || !b.collidable) {
    return false;
  }
  const dx = a.pos.x - b.pos.x;
  const dy = a.pos.y - b.pos.y;
  const combinedRadius = a.radius + b.radius;
  return dx * dx + dy * dy <= combinedRadius * combinedRadius;
}

export function* collisionPairs(world: World): Generator<CollisionPair> {
  const entities = [...world];
  for (let first = 0; first < entities.length; first += 1) {
    const a = entities[first];
    if (!a || !a.alive || !a.collidable) {
      continue;
    }
    for (let second = first + 1; second < entities.length; second += 1) {
      const b = entities[second];
      if (b && circlesOverlap(a, b)) {
        yield [a, b];
      }
    }
  }
}

function addExplosion(world: World, entity: GameEntity): void {
  const explosion = world.spawn(world.createExplosion(entity.pos.x, entity.pos.y));
  world.emit('exploded', { entity, explosion });
}

function damageShip(
  world: World,
  ship: Extract<GameEntity, { kind: 'ship' }>,
  damage: number,
  events: CollisionEvent[],
): void {
  const destroyed = ship.takeDamage(damage);
  world.emit('hit', { entity: ship, damage, destroyed });
  if (destroyed || !ship.alive) {
    events.push({ type: 'ship-destroyed', entity: ship });
    addExplosion(world, ship);
  } else {
    events.push({ type: 'ship-hit', entity: ship });
  }
}

function handleBulletCollision(
  world: World,
  bullet: Extract<GameEntity, { kind: 'bullet' }>,
  target: GameEntity,
  events: CollisionEvent[],
): void {
  if (bullet.ownerId === target.id || !target.alive) {
    return;
  }
  bullet.alive = false;

  switch (target.kind) {
    case 'asteroid': {
      const destroyed = target.takeDamage(bullet.damage);
      world.emit('hit', { entity: target, damage: bullet.damage, destroyed });
      events.push({ type: destroyed ? 'asteroid-destroyed' : 'asteroid-hit', entity: target });
      if (destroyed) {
        addExplosion(world, target);
        if (world.random() < 0.28) {
          const effect = world.random() < 0.5 ? 'shield' : 'rapid-fire';
          world.spawn(world.createPickup(target.pos.x, target.pos.y, effect));
        }
      }
      break;
    }
    case 'ship':
      damageShip(world, target, bullet.damage, events);
      break;
    case 'bullet':
    case 'pickup':
    case 'explosion':
      break;
    default:
      assertNever(target);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled entity kind: ${String(value)}`);
}

function handlePair(world: World, a: GameEntity, b: GameEntity, events: CollisionEvent[]): void {
  if (!a.alive || !b.alive) return;

  switch (a.kind) {
    case 'bullet':
      handleBulletCollision(world, a, b, events);
      return;
    case 'ship':
      switch (b.kind) {
        case 'bullet':
          handleBulletCollision(world, b, a, events);
          return;
        case 'asteroid':
          damageShip(world, a, 1, events);
          if (b.takeDamage() || !b.alive) {
            events.push({ type: 'asteroid-destroyed', entity: b });
            addExplosion(world, b);
          }
          return;
        case 'pickup':
          b.applyTo(a);
          b.alive = false;
          events.push({ type: 'pickup-collected', entity: b, ship: a });
          return;
        case 'ship':
        case 'explosion':
          return;
        default:
          assertNever(b);
      }
      return;
    case 'asteroid':
      if (b.kind === 'bullet') {
        handleBulletCollision(world, b, a, events);
      } else if (b.kind === 'ship') {
        damageShip(world, b, 1, events);
        if (a.takeDamage() || !a.alive) {
          events.push({ type: 'asteroid-destroyed', entity: a });
          addExplosion(world, a);
        }
      }
      return;
    case 'pickup':
      if (b.kind === 'ship') {
        a.applyTo(b);
        a.alive = false;
        events.push({ type: 'pickup-collected', entity: a, ship: b });
      } else if (b.kind === 'bullet') {
        handleBulletCollision(world, b, a, events);
      }
      return;
    case 'explosion':
      return;
    default:
      assertNever(a);
  }
}

export function resolveCollisions(world: World, pairs: Iterable<CollisionPair>): CollisionEvent[] {
  const events: CollisionEvent[] = [];
  for (const [a, b] of pairs) {
    handlePair(world, a, b, events);
  }
  return events;
}
