import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapShip } from '../src/sim/arena.js';
import { createShip, integrate, interpolateShip, SHIP_TUNING } from '../src/sim/ship.js';

function controls(...codes) {
  const down = new Set(codes);
  return { isDown: (code) => down.has(code) };
}

test('integrate returns a new ship and applies heading-based thrust', () => {
  const ship = createShip(10, 20);
  const next = integrate(ship, controls('KeyW'), 1 / 60);

  assert.notStrictEqual(next, ship);
  assert.equal(ship.x, 10);
  assert.equal(ship.y, 20);
  assert.ok(next.vy < 0);
  assert.equal(next.thrust, 1);
});

test('integrate is deterministic and clamps speed', () => {
  const initial = { ...createShip(), vx: 1000 };
  const first = integrate(initial, controls(), 1 / 60);
  const second = integrate(initial, controls(), 1 / 60);

  assert.deepEqual(first, second);
  assert.ok(Math.hypot(first.vx, first.vy) <= SHIP_TUNING.maxSpeed);
});

test('integrate rejects negative elapsed time', () => {
  assert.throws(() => integrate(createShip(), controls(), -1), RangeError);
});

test('wrapShip wraps both edges and preserves the other state', () => {
  const ship = { ...createShip(), x: -1, y: 121, vx: 4 };
  const wrapped = wrapShip(ship, 100, 120);

  assert.equal(wrapped.x, 99);
  assert.equal(wrapped.y, 1);
  assert.equal(wrapped.vx, 4);
  assert.equal(ship.x, -1);
});

test('interpolateShip takes the short route across the angle boundary', () => {
  const previous = { ...createShip(), angle: Math.PI - 0.1 };
  const current = { ...previous, angle: -Math.PI + 0.1 };
  const middle = interpolateShip(previous, current, 0.5);

  assert.ok(Math.abs(Math.abs(middle.angle) - Math.PI) < 0.001);
});

test('interpolateShip takes the short route across arena edges', () => {
  const previous = { ...createShip(), x: 99, y: 1 };
  const current = { ...previous, x: 1, y: 99 };
  const middle = interpolateShip(previous, current, 0.5, 100, 100);

  assert.equal(middle.x, 0);
  assert.equal(middle.y, 0);
});
