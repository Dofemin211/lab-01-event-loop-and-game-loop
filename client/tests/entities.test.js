import test from 'node:test';
import assert from 'node:assert/strict';
import { Asteroid } from '../src/sim/asteroid.js';
import { Bullet } from '../src/sim/bullet.js';
import { collisionPairs, circlesOverlap } from '../src/sim/collision.js';
import { Entity } from '../src/sim/entity.js';
import { Explosion } from '../src/sim/explosion.js';
import { createHomingBehavior, attachHoming } from '../src/sim/homing.js';
import { Pickup } from '../src/sim/pickup.js';
import { Ship } from '../src/sim/ship.js';
import { Vector2 } from '../src/sim/vector.js';
import { World } from '../src/sim/world.js';

function idleInput() {
  return { isDown: () => false };
}

test('Vector2 pure methods return new vectors and in-place variants mutate explicitly', () => {
  const first = new Vector2(3, 4);
  const second = new Vector2(1, -2);
  const sum = first.add(second);

  assert.deepEqual(sum, new Vector2(4, 2));
  assert.deepEqual(first, new Vector2(3, 4));
  assert.equal(first.length(), 5);
  assert.ok(Math.abs(first.normalize().x - 0.6) < 1e-12);
  assert.ok(Math.abs(first.normalize().y - 0.8) < 1e-12);
  const rotated = new Vector2(1, 0).rotate(Math.PI / 2);
  assert.ok(Math.abs(rotated.x) < 1e-12);
  assert.ok(Math.abs(rotated.y - 1) < 1e-12);
  assert.equal(first.dot(second), -5);
  assert.deepEqual(Vector2.fromAngle(0, 2), new Vector2(2, 0));
  assert.strictEqual(first.addInPlace(second), first);
  assert.deepEqual(first, new Vector2(4, 2));
});

test('Entity assigns private unique ids and Ship inherits shared Entity methods once', () => {
  const first = new Entity();
  const second = new Ship();

  assert.notEqual(first.id, second.id);
  assert.equal(second instanceof Entity, true);
  assert.equal(Object.hasOwn(Entity.prototype, 'update'), true);
  assert.equal(Object.hasOwn(Ship.prototype, 'update'), true);
  assert.equal(Object.hasOwn(second, 'id'), false);
  assert.equal(second.hp, 3);
  assert.equal(Object.hasOwn(second, '#hp'), false);
});

test('World uses Map-backed insertion order, iterators, generators, and deferred despawn', () => {
  const world = new World();
  const ship = world.spawn(new Ship());
  const asteroid = world.spawn(new Asteroid(100, 100));

  assert.deepEqual([...world], [ship, asteroid]);
  assert.deepEqual([...world.ofKind('asteroid')], [asteroid]);
  assert.equal(world.despawn(ship.id), true);
  assert.equal(ship.alive, false);
  assert.equal(world.get(ship.id), ship);
  world.step(0, idleInput());
  assert.equal(world.get(ship.id), undefined);
  assert.equal(world.size, 1);
});

test('World snapshots its update iteration when an entity spawns another entity', () => {
  const world = new World();
  class Spawner extends Entity {
    update(dt, input, activeWorld) {
      if (!this.spawned) {
        this.spawned = true;
        this.child = activeWorld.spawn(new Entity({ vel: new Vector2(10, 0) }));
      }
      super.update(dt, input, activeWorld);
    }
  }
  const spawner = world.spawn(new Spawner());

  world.step(1, idleInput());
  assert.equal(spawner.child.pos.x, 0);
  world.step(1, idleInput());
  assert.equal(spawner.child.pos.x, 10);
});

test('Ship fires from its nose with inherited velocity and class method needs receiver binding', () => {
  const world = new World();
  const ship = world.spawn(new Ship(100, 80, { angle: 0, invulnerableTime: 0 }));
  ship.vel = new Vector2(10, 15);
  const bullet = ship.fire(world);

  assert.ok(bullet instanceof Bullet);
  assert.equal(bullet.ownerId, ship.id);
  assert.equal(bullet.pos.x, 118);
  assert.equal(bullet.pos.y, 80);
  assert.equal(bullet.vel.x, 470);
  assert.equal(bullet.vel.y, 15);
  assert.equal(ship.fire(world), null);
  const detachedFire = ship.fire;
  assert.throws(() => detachedFire(world), TypeError);
  assert.doesNotThrow(() => ship.fire.bind(ship)(world));
});

test('Ship applies fixed-step thrust and wraps around the same arena boundary as Lab 01', () => {
  const world = new World({ width: 100, height: 100 });
  const ship = world.spawn(new Ship(99, 50, { angle: 0, invulnerableTime: 0 }));

  ship.update(0.1, { isDown: (code) => code === 'KeyW' }, world);

  assert.ok(ship.pos.x < 10);
  assert.equal(ship.pos.y, 50);
  assert.ok(ship.vel.x > 0);
  assert.equal(ship.thrust, 1);
});

test('Bullets expire and asteroids bounce off world bounds', () => {
  const world = new World({ width: 100, height: 100 });
  const bullet = world.spawn(new Bullet({ pos: new Vector2(30, 30), ttl: 0.01 }));
  const asteroid = world.spawn(
    new Asteroid(94, 50, { radius: 10, vel: new Vector2(20, 0), hp: 2 }),
  );

  world.step(0.1, idleInput());
  assert.equal(world.get(bullet.id), undefined);
  assert.equal(asteroid.pos.x, 90);
  assert.equal(asteroid.vel.x, -20);
});

test('circle collision system emits only overlapping live collidable pairs', () => {
  const world = new World();
  const first = world.spawn(new Ship(10, 10));
  const second = world.spawn(new Asteroid(30, 10, { radius: 8 }));
  world.spawn(new Pickup(100, 100));

  assert.equal(circlesOverlap(first, second), true);
  assert.deepEqual([...collisionPairs(world)], [[first, second]]);
});

test('Ship health is private, shield pickup is composed, and repair restores hull', () => {
  const ship = new Ship(0, 0, { invulnerableTime: 0 });
  const shield = new Pickup(0, 0, 'shield', { duration: 2 });
  shield.applyTo(ship);

  assert.equal(ship.takeDamage(), false);
  assert.equal(ship.hp, 3);
  ship.effects.clear();
  assert.equal(ship.takeDamage(), false);
  assert.equal(ship.hp, 2);
  new Pickup(0, 0, 'repair').applyTo(ship);
  assert.equal(ship.hp, 3);
});

test('Destroyed collision targets are swept, emit events, spawn explosions, and award score', () => {
  const world = new World({ width: 200, height: 200, seed: 7 });
  const asteroid = world.spawn(new Asteroid(50, 50, { radius: 16, hp: 1 }));
  const bullet = world.spawn(
    new Bullet({ pos: new Vector2(50, 50), ownerId: -1, vel: new Vector2() }),
  );

  const events = world.step(0, idleInput());
  assert.equal(
    events.some((event) => event.type === 'asteroid-destroyed'),
    true,
  );
  assert.equal(world.get(asteroid.id), undefined);
  assert.equal(world.get(bullet.id), undefined);
  assert.equal([...world.ofKind('explosion')].length, 1);
  assert.ok([...world.ofKind('explosion')][0] instanceof Explosion);
});

test('Enemy bullets damage ships through the circle collision system', () => {
  const world = new World({ width: 200, height: 200 });
  const ship = world.spawn(new Ship(50, 50, { invulnerableTime: 0 }));
  const bullet = world.spawn(
    new Bullet({ pos: ship.pos.clone(), ownerId: -1, vel: new Vector2() }),
  );

  const events = world.step(0);

  assert.equal(ship.hp, 2);
  assert.equal(world.get(bullet.id), undefined);
  assert.equal(
    events.some((event) => event.type === 'ship-hit'),
    true,
  );
});

test('homing composition steers both bullets and asteroids toward their target kinds', () => {
  const world = new World({ width: 400, height: 400 });
  const target = world.spawn(new Ship(100, 180, { invulnerableTime: 0 }));
  const bullet = world.spawn(
    new Bullet({
      pos: new Vector2(100, 100),
      vel: new Vector2(40, 0),
      homing: createHomingBehavior({ targetKind: 'ship', turnRate: 4, maxSpeed: 80 }),
    }),
  );
  const asteroid = world.spawn(
    attachHoming(
      new Asteroid(250, 250, { vel: new Vector2(20, 0) }),
      createHomingBehavior({ targetKind: 'ship', turnRate: 2, maxSpeed: 60 }),
    ),
  );
  const asteroidAngleBefore = asteroid.angle;

  world.step(0.1, idleInput());

  assert.ok(bullet.angle > 0);
  assert.notEqual(asteroid.angle, asteroidAngleBefore);
  assert.equal(target.alive, true);
});

test('World collision system is replaceable', () => {
  let receivedWorld;
  const world = new World({
    collisionSystem: (activeWorld) => {
      receivedWorld = activeWorld;
      return [];
    },
  });
  world.spawn(new Ship());
  world.step(1 / 60, idleInput());

  assert.equal(receivedWorld, world);
});
