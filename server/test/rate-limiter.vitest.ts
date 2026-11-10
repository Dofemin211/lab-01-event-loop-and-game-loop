import { expect, test } from 'vitest';
import { TokenBucket } from '../src/token-bucket.ts';

test('rate limiter: consumes capacity, refills fractionally, and caps at capacity', () => {
  let now = 0;
  const bucket = new TokenBucket(3, 2, () => now);
  expect(bucket.consume()).toBe(true);
  expect(bucket.consume()).toBe(true);
  expect(bucket.consume()).toBe(true);
  expect(bucket.consume()).toBe(false);
  now = 750;
  expect(bucket.consume()).toBe(true);
  expect(bucket.consume()).toBe(false);
  now = 60_000;
  expect(bucket.consume()).toBe(true);
  expect(bucket.consume()).toBe(true);
  expect(bucket.consume()).toBe(true);
  expect(bucket.consume()).toBe(false);
});

test('token bucket does not refill when the injected clock moves backwards', () => {
  let now = 1000;
  const bucket = new TokenBucket(1, 1, () => now);
  expect(bucket.consume()).toBe(true);
  now = 0;
  expect(bucket.consume()).toBe(false);
  now = 2000;
  expect(bucket.consume()).toBe(true);
});
