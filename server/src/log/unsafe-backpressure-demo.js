import { finished } from 'node:stream/promises';
import { Writable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateUnsafeDemoSize(sizeMb) {
  if (!Number.isFinite(sizeMb) || sizeMb <= 0 || sizeMb > 8) {
    throw new RangeError('The intentionally flawed demo is strictly capped at 8 MB.');
  }
  return Math.floor(sizeMb * 1024 * 1024);
}

export async function runUnsafeDemo(sizeMb = 8, delayMs = 10) {
  const byteLimit = validateUnsafeDemoSize(sizeMb);
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 100) {
    throw new RangeError('Demo delay must be between 0 and 100 ms.');
  }
  const before = process.memoryUsage().rss;
  let bytes = 0;
  const slowSink = new Writable({
    highWaterMark: 1024,
    write(chunk, _encoding, callback) {
      bytes += chunk.length;
      setTimeout(callback, delayMs);
    },
  });

  for (let remaining = byteLimit; remaining > 0; remaining -= 64 * 1024) {
    const chunk = Buffer.alloc(Math.min(64 * 1024, remaining), 0x78);
    slowSink.write(chunk);
  }
  slowSink.end();
  await finished(slowSink);
  const result = {
    intentionallyUnsafe: true,
    capBytes: byteLimit,
    writtenBytes: bytes,
    rssBeforeBytes: before,
    rssAfterBytes: process.memoryUsage().rss,
    note: 'The producer ignored write() returning false; memory increase is machine-dependent.',
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sizeArg = process.argv.slice(2).find((arg) => arg.startsWith('--size-mb='));
  const sizeMb = sizeArg ? Number(sizeArg.split('=')[1]) : 8;
  try {
    await runUnsafeDemo(sizeMb);
  } catch (error) {
    console.error('Unsafe backpressure demo refused:', error.message);
    process.exitCode = 1;
  }
}
