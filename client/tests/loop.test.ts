import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoop, type LoopStats } from '../src/loop.ts';

function createFrameHarness() {
  let nextId = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  const cancelled: number[] = [];
  return {
    callbacks,
    cancelled,
    requestFrame(callback: FrameRequestCallback) {
      nextId += 1;
      callbacks.set(nextId, callback);
      return nextId;
    },
    cancelFrame(id: number) {
      cancelled.push(id);
      callbacks.delete(id);
    },
    runNext(timestamp: number) {
      const next = callbacks.entries().next().value;
      assert.ok(next);
      const [id, callback] = next;
      callbacks.delete(id);
      callback(timestamp);
    },
  };
}

test('fixed loop advances in fixed steps, renders alpha, and does not duplicate starts', () => {
  const harness = createFrameHarness();
  const steps: number[] = [];
  const alphas: number[] = [];
  const frameStats: LoopStats[] = [];
  const loop = createLoop({
    step: 0.01,
    simulate: (dt) => steps.push(dt),
    render: (alpha, stats) => {
      alphas.push(alpha);
      frameStats.push(stats);
    },
    requestFrame: harness.requestFrame,
    cancelFrame: harness.cancelFrame,
    clock: () => 0,
  });

  loop.start();
  loop.start();
  assert.equal(harness.callbacks.size, 1);
  harness.runNext(0);
  harness.runNext(25);
  assert.equal(steps.length, 2);
  assert.ok(steps.every((dt) => dt === 0.01));
  const lastAlpha = alphas.at(-1);
  const lastStats = frameStats.at(-1);
  assert.ok(lastAlpha !== undefined && lastAlpha >= 0 && lastAlpha < 1);
  assert.ok(lastStats);
  assert.equal(lastStats.totalFrames, 2);
  loop.stop();
  assert.equal(harness.callbacks.size, 0);
  assert.equal(harness.cancelled.length, 1);
});

test('fixed loop clamps a long frame before catching up', () => {
  const harness = createFrameHarness();
  let steps = 0;
  const loop = createLoop({
    simulate: () => {
      steps += 1;
    },
    render: () => {},
    requestFrame: harness.requestFrame,
    cancelFrame: harness.cancelFrame,
    clock: () => 0,
  });

  loop.start();
  harness.runNext(0);
  harness.runNext(1000);
  assert.equal(steps, 15);
  loop.stop();
});

test('interval scheduler stops its timer and variable mode simulates once per frame', () => {
  let callback: (() => void) | undefined;
  let cleared = false;
  let steps = 0;
  let delta = 0;
  let now = 40;
  const loop = createLoop({
    simulate: (dt) => {
      steps += 1;
      delta = dt;
    },
    render: () => {},
    scheduler: 'interval',
    variableTimestep: true,
    clock: () => now,
    setIntervalFn: (next) => {
      callback = () => {
        now += 16;
        next();
      };
      return setInterval(() => {}, 100_000);
    },
    clearIntervalFn: (id) => {
      clearInterval(id);
      cleared = true;
    },
  });

  loop.start();
  assert.ok(callback);
  const intervalCallback = callback;
  intervalCallback();
  assert.equal(steps, 0);
  intervalCallback();
  assert.equal(steps, 1);
  assert.equal(delta, 0.016);
  loop.stop();
  assert.equal(cleared, true);
});
