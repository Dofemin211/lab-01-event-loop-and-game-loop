import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Asteroid,
  Bullet,
  Explosion,
  Pickup,
  Ship,
  Vector2,
  World,
  createSnapshot,
  restoreSnapshot,
} from '../src/sim/index.js';
import { mulberry32 } from '../src/prng.js';

function command(thrust) {
  return { isDown: (code) => (code === 'ArrowUp' ? thrust : false) };
}

function createWorld(seed) {
  const world = new World({ width: 960, height: 600, seed });
  world.spawn(new Ship(480, 300, { playerId: 'pilot-a' }));
  for (let index = 0; index < 3; index += 1) {
    world.spawn(
      new Asteroid(100 + index * 80, 120, {
        radius: 24,
        hp: 2,
        vel: { x: index + 1, y: -index },
      }),
    );
  }
  return world;
}

test('shared simulation imports in Node and seeded runs produce identical snapshots', () => {
  assert.equal(typeof document, 'undefined');
  const first = createWorld(1234);
  const second = createWorld(1234);
  for (let tick = 0; tick < 180; tick += 1) {
    const thrust = tick % 5 !== 0;
    first.step(1 / 60, new Map([['pilot-a', command(thrust)]]));
    second.step(1 / 60, new Map([['pilot-a', command(thrust)]]));
  }
  assert.deepEqual(createSnapshot(first), createSnapshot(second));
});

test('world snapshot restoration recreates entity classes and deterministic continuation', () => {
  const original = createWorld(99);
  for (let tick = 0; tick < 30; tick += 1) {
    original.step(1 / 60, new Map([['pilot-a', command(true)]]));
  }
  const restored = restoreSnapshot(createSnapshot(original));
  assert.ok([...restored].some((entity) => entity instanceof Ship));
  assert.ok([...restored].some((entity) => entity instanceof Asteroid));
  for (let tick = 0; tick < 60; tick += 1) {
    const inputs = new Map([['pilot-a', command(tick < 20)]]);
    original.step(1 / 60, inputs);
    restored.step(1 / 60, inputs);
  }
  assert.deepEqual(createSnapshot(original), createSnapshot(restored));
});

test('world snapshots restore bullets, pickups, explosions, and their serializable state', () => {
  const world = new World({ width: 960, height: 600, seed: 2026 });
  world.spawn(new Bullet({ pos: new Vector2(30, 40), vel: new Vector2(10, -5), ownerId: 7 }));
  world.spawn(world.createPickup(60, 70, 'shield'));
  world.spawn(world.createExplosion(90, 100));

  const restored = restoreSnapshot(createSnapshot(world));
  const entities = [...restored];
  assert.ok(entities.some((entity) => entity instanceof Bullet));
  assert.ok(entities.some((entity) => entity instanceof Pickup && entity.effect === 'shield'));
  assert.ok(
    entities.some((entity) => entity instanceof Explosion && entity.particles.length === 14),
  );
  assert.deepEqual(createSnapshot(restored), createSnapshot(world));
});

test('Mulberry32 repeats a sequence for the same seed and restores its state', () => {
  const first = mulberry32(2025);
  const second = mulberry32(2025);
  assert.deepEqual(
    Array.from({ length: 5 }, () => first()),
    Array.from({ length: 5 }, () => second()),
  );
  const state = first.getState();
  const expected = first();
  first.setState(state);
  assert.equal(first(), expected);
});
