import { expect, test, vi } from 'vitest';
import { createLoop } from '../src/loop.ts';

test('loop: fixed accumulator advances predictably with fake interval timers', async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(0);
    const deltas: number[] = [];
    const loop = createLoop({
      step: 0.01,
      scheduler: 'interval',
      simulate: (delta) => deltas.push(delta),
      render: () => {},
      clock: () => Date.now(),
    });
    loop.start();
    await vi.advanceTimersByTimeAsync(128);
    loop.stop();
    expect(deltas.length).toBeGreaterThanOrEqual(10);
    expect(deltas.every((delta) => delta === 0.01)).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
