import { expect, test } from 'vitest';
import fc from 'fast-check';
import { BINARY_PACKET_SPEC, decodeBinary, encodeBinary } from '../src/codec.ts';
import { CONTROL_PROTOCOL_VERSION, parseClientMessage } from '../src/protocol.ts';
import type { BinarySnapshotEntity, BinarySnapshotMessage } from '../src/codec.ts';
import type { ClientMessage } from '../src/protocol.ts';
import { Asteroid, Bullet, Ship, Vector2, World, integrate } from '../src/sim/index.ts';
import { circlesOverlap, collisionPairs } from '../src/sim/collision.ts';

const entityArbitrary: fc.Arbitrary<BinarySnapshotEntity> = fc.record({
  id: fc.integer({ min: 1, max: 0xffff }),
  kind: fc.constantFrom('ship', 'asteroid', 'bullet', 'explosion'),
  x: fc.double({ min: -10_000, max: 10_000, noNaN: true, noDefaultInfinity: true }),
  y: fc.double({ min: -10_000, max: 10_000, noNaN: true, noDefaultInfinity: true }),
  vx: fc.double({ min: -1_000, max: 1_000, noNaN: true, noDefaultInfinity: true }),
  vy: fc.double({ min: -1_000, max: 1_000, noNaN: true, noDefaultInfinity: true }),
  angle: fc.double({ min: -Math.PI, max: Math.PI, noNaN: true, noDefaultInfinity: true }),
  radius: fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }),
  hp: fc.integer({ min: 0, max: 255 }),
  thrust: fc.integer({ min: 0, max: 1 }),
  invulnerableTime: fc.double({ min: 0, max: 10, noNaN: true, noDefaultInfinity: true }),
  shield: fc.boolean(),
  ownerId: fc.integer({ min: 0, max: 0xffff }),
  ttl: fc.double({ min: 0, max: 10, noNaN: true, noDefaultInfinity: true }),
  commandSeq: fc.integer({ min: 0, max: 0xffff }),
  score: fc.integer({ min: 0, max: 0xffff }),
});

const snapshotArbitrary: fc.Arbitrary<BinarySnapshotMessage> = fc
  .record({
    tick: fc.integer({ min: 0, max: 0xffff_ffff }),
    entities: fc.array(entityArbitrary, { maxLength: 8 }),
    acks: fc.array(
      fc.record({
        entityId: fc.integer({ min: 0, max: 0xffff_ffff }),
        seq: fc.integer({ min: 0, max: 0xffff_ffff }),
      }),
      { maxLength: 8 },
    ),
  })
  .map(({ tick, entities, acks }) => ({ type: 'snapshot', tick, entities, acks }));

const validMessageArbitrary: fc.Arbitrary<ClientMessage> = fc.oneof(
  fc
    .record({
      name: fc.array(fc.constantFrom('P', 'i', 'l', 'o', 't', 'A', 'C', 'E', '0', '1', '2'), {
        minLength: 1,
        maxLength: 24,
      }),
      room: fc.constantFrom('training-sector', 'asteroid-belt'),
    })
    .map(({ name, room }): ClientMessage => ({
      version: CONTROL_PROTOCOL_VERSION,
      type: 'join',
      room,
      name: name.join(''),
    })),
  fc
    .record({
      text: fc.array(fc.constantFrom('M', 'e', 's', 'a', 'g', '0', '1', '2'), {
        minLength: 1,
        maxLength: 30,
      }),
    })
    .map(({ text }): ClientMessage => ({
      version: CONTROL_PROTOCOL_VERSION,
      type: 'chat',
      text: text.join(''),
    })),
  fc
    .record({
      seq: fc.integer({ min: 1, max: 0xffff_ffff }),
      tick: fc.integer({ min: 0, max: 0xffff_ffff }),
      turn: fc.constantFrom(-1, 0, 1),
      thrust: fc.boolean(),
      brake: fc.boolean(),
      fire: fc.boolean(),
    })
    .map((input): ClientMessage => ({
      version: CONTROL_PROTOCOL_VERSION,
      type: 'input',
      ...input,
    })),
);

test('engine: Vector2 operations preserve values and explicit mutation boundaries', () => {
  const first = new Vector2(3, 4);
  const second = first.add(new Vector2(1, -2));
  expect(second).toEqual(new Vector2(4, 2));
  expect(first).toEqual(new Vector2(3, 4));
  expect(first.length()).toBe(5);
  expect(first.clone().scaleInPlace(2)).toEqual(new Vector2(6, 8));
});

test('integrate produces finite deterministic movement for validated controls', () => {
  const initial = { x: 10, y: 20, vx: 0, vy: 0, angle: -Math.PI / 2, thrust: 0 };
  const input = { isDown: (code: string) => code === 'KeyW' };
  const first = integrate(initial, input, 1 / 60);
  expect(first).toEqual(integrate(initial, input, 1 / 60));
  expect(Number.isFinite(first.x) && Number.isFinite(first.y)).toBe(true);
  expect(first.y).toBeLessThan(initial.y);
});

test('circle collision includes touching edges and overlapping areas', () => {
  const first = new Asteroid(100, 100, { radius: 10 });
  const touching = new Asteroid(120, 100, { radius: 10 });
  const overlapping = new Asteroid(119, 100, { radius: 10 });
  expect(circlesOverlap(first, touching)).toBe(true);
  expect(circlesOverlap(first, overlapping)).toBe(true);
});

test('World.step detects a fast bullet crossing a stationary target', () => {
  const world = new World({ width: 400, height: 300, seed: 5 });
  const asteroid = world.spawn(new Asteroid(100, 100, { radius: 10, hp: 1 }));
  const bullet = world.spawn(
    new Bullet({ pos: new Vector2(10, 100), vel: new Vector2(12_000, 0) }),
  );
  expect([...collisionPairs(world)]).toHaveLength(0);
  const events = world.step(1 / 60);
  expect(events.some((event) => event.type === 'asteroid-destroyed')).toBe(true);
  expect(world.get(asteroid.id)).toBeUndefined();
  expect(world.get(bullet.id)).toBeUndefined();
});

test('World.step keeps identical seeded worlds deterministic', () => {
  const first = new World({ width: 960, height: 600, seed: 734 });
  const second = new World({ width: 960, height: 600, seed: 734 });
  for (const world of [first, second]) {
    world.spawn(new Ship(100, 100, { playerId: 'pilot', invulnerableTime: 0 }));
    world.addAsteroid(400, 300, { radius: 25 });
  }
  for (let index = 0; index < 120; index += 1) {
    const input = {
      isDown: (code: string) => code === 'KeyW' || (code === 'KeyD' && index % 2 === 0),
    };
    first.step(1 / 60, new Map([['pilot', input]]));
    second.step(1 / 60, new Map([['pilot', input]]));
  }
  expect(first.toSnapshot()).toEqual(second.toSnapshot());
});

test('binary snapshot round-trips arbitrary valid entities within codec quantization', () => {
  fc.assert(
    fc.property(snapshotArbitrary, (snapshot) => {
      const decoded = decodeBinary(encodeBinary(snapshot));
      expect(decoded).toEqual(
        expect.objectContaining({
          type: 'snapshot',
          tick: snapshot.tick,
          acks: snapshot.acks,
        }),
      );
      if (decoded.type !== 'snapshot') return false;
      expect(decoded.entities).toHaveLength(snapshot.entities.length);
      for (const [index, entity] of snapshot.entities.entries()) {
        const result = decoded.entities[index];
        expect(result).toBeDefined();
        if (!result) return false;
        expect(Math.abs(result.x - entity.x)).toBeLessThan(0.001);
        expect(Math.abs(result.y - entity.y)).toBeLessThan(0.001);
        expect(Math.abs(result.angle - entity.angle)).toBeLessThanOrEqual(0.00005);
      }
      return true;
    }),
    { numRuns: 100 },
  );
});

test('binary packet length follows the documented snapshot layout', () => {
  fc.assert(
    fc.property(snapshotArbitrary, (snapshot) => {
      expect(encodeBinary(snapshot).byteLength).toBe(
        BINARY_PACKET_SPEC.snapshotHeaderBytes +
          snapshot.acks.length * BINARY_PACKET_SPEC.ackBytes +
          snapshot.entities.length * BINARY_PACKET_SPEC.entityBytes,
      );
    }),
    { numRuns: 100 },
  );
});

test('arbitrary malformed binary buffers fail with controlled decoder errors', () => {
  const malformedBufferArbitrary = fc.uint8Array({ minLength: 0, maxLength: 64 }).map((bytes) => {
    if (bytes.length > 0) bytes[0] = 0xff;
    return bytes;
  });
  fc.assert(
    fc.property(malformedBufferArbitrary, (bytes) => {
      try {
        decodeBinary(bytes);
        return false;
      } catch (error: unknown) {
        return error instanceof TypeError || error instanceof RangeError;
      }
    }),
    { numRuns: 200 },
  );
});

test('ships remain wrapped inside arena bounds over 1000 randomized simulation steps', () => {
  const controlsArbitrary = fc.array(
    fc.record({
      turn: fc.integer({ min: -1, max: 1 }),
      thrust: fc.boolean(),
      brake: fc.boolean(),
    }),
    { minLength: 1000, maxLength: 1000 },
  );
  fc.assert(
    fc.property(controlsArbitrary, (controls) => {
      const width = 960;
      const height = 600;
      const world = new World({ width, height, seed: 99 });
      const ship = world.spawn(new Ship(480, 300, { playerId: 'pilot' }));
      for (const command of controls) {
        const input = {
          isDown: (code: string) =>
            ((code === 'ArrowLeft' || code === 'KeyA') && command.turn < 0) ||
            ((code === 'ArrowRight' || code === 'KeyD') && command.turn > 0) ||
            ((code === 'ArrowUp' || code === 'KeyW') && command.thrust) ||
            (code === 'Space' && command.brake),
        };
        world.step(1 / 60, new Map([['pilot', input]]));
        expect(ship.pos.x).toBeGreaterThanOrEqual(0);
        expect(ship.pos.x).toBeLessThan(width);
        expect(ship.pos.y).toBeGreaterThanOrEqual(0);
        expect(ship.pos.y).toBeLessThan(height);
      }
    }),
    { numRuns: 20 },
  );
});

test('parseClientMessage accepts generated valid messages', () => {
  fc.assert(
    fc.property(validMessageArbitrary, (message) => {
      expect(parseClientMessage(JSON.stringify(message)).success).toBe(true);
    }),
    { numRuns: 100 },
  );
});

test('parseClientMessage rejects generated invalid version mutations without throwing', () => {
  fc.assert(
    fc.property(validMessageArbitrary, (message) => {
      const invalid = { ...message, version: 99 };
      expect(() => parseClientMessage(JSON.stringify(invalid))).not.toThrow();
      expect(parseClientMessage(JSON.stringify(invalid)).success).toBe(false);
    }),
    { numRuns: 100 },
  );
});
