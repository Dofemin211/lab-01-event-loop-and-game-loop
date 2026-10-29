import test from 'node:test';
import assert from 'node:assert/strict';
import { NetworkEmulator } from '../src/network-emulator.js';

test('disabled network emulator delivers synchronously without changing the payload path', () => {
  let delivered = false;
  const emulator = new NetworkEmulator({ random: () => 0.5 });
  assert.deepEqual(
    emulator.transmit(() => (delivered = true)),
    { dropped: false, delayMs: 0 },
  );
  assert.equal(delivered, true);
  emulator.dispose();
});

test('network emulator applies bounded jitter, packet loss, and cancellable delayed delivery', () => {
  let now = 0;
  const timers = [];
  const emulator = new NetworkEmulator({
    delayMs: 100,
    jitterMs: 30,
    lossPercent: 0,
    random: (() => {
      const values = [1, 1, 1, 0];
      return () => values.shift() ?? 1;
    })(),
    now: () => now,
    setTimer: (callback, delay) => {
      const timer = { callback, delay, scheduledAt: now + delay };
      timers.push(timer);
      return timer;
    },
    clearTimer: () => {},
  });
  let delivered = false;
  const result = emulator.transmit(() => (delivered = true));
  assert.deepEqual(result, { dropped: false, delayMs: 130 });
  assert.equal(delivered, false);
  now = 130;
  timers[0].callback();
  assert.equal(delivered, true);

  emulator.configure({ delayMs: 0, jitterMs: 0, lossPercent: 100 });
  assert.deepEqual(
    emulator.transmit(() => assert.fail('dropped packet was delivered')),
    {
      dropped: true,
      delayMs: 0,
    },
  );
  assert.throws(() => emulator.configure({ delayMs: -1, jitterMs: 0, lossPercent: 0 }), /delay/i);
  emulator.dispose();
});

test('jitter does not reorder packets within a direction while keeping directions independent', () => {
  let now = 0;
  const timers = [];
  const delivered = [];
  const randomValues = [1, 1, 1, 0, 1, 1];
  const emulator = new NetworkEmulator({
    delayMs: 100,
    jitterMs: 30,
    random: () => randomValues.shift() ?? 1,
    now: () => now,
    setTimer: (callback, delay) => {
      const timer = { callback, at: now + delay };
      timers.push(timer);
      return timer;
    },
    clearTimer: () => {},
  });

  emulator.transmit(() => delivered.push('out-1'), 'outbound');
  now = 33;
  emulator.transmit(() => delivered.push('out-2'), 'outbound');
  emulator.transmit(() => delivered.push('in-1'), 'inbound');
  assert.deepEqual(
    timers.map(({ at }) => at),
    [130, 163],
  );

  while (timers.length > 0) {
    timers.sort((first, second) => first.at - second.at);
    const timer = timers.shift();
    now = timer.at;
    timer.callback();
  }
  assert.deepEqual(delivered, ['out-1', 'out-2', 'in-1']);
  emulator.dispose();
});

test('a late timer callback cannot let a later packet overtake an earlier packet', () => {
  let now = 0;
  const timers = [];
  const delivered = [];
  const emulator = new NetworkEmulator({
    delayMs: 100,
    jitterMs: 30,
    random: () => 1,
    now: () => now,
    setTimer: (callback, delay) => {
      const timer = { callback, at: now + delay };
      timers.push(timer);
      return timer;
    },
    clearTimer: () => {},
  });
  emulator.transmit(() => delivered.push('first'), 'outbound');
  emulator.transmit(() => delivered.push('second'), 'outbound');
  assert.equal(timers.length, 1);

  now = 200;
  timers.shift().callback();
  assert.deepEqual(delivered, ['first']);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].at, 200);
  timers.shift().callback();

  assert.deepEqual(delivered, ['first', 'second']);
  emulator.dispose();
});
