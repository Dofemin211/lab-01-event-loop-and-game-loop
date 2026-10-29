import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { EventToNdjson, MatchLog } from '../src/log/matchlog.js';
import { parseNdjson, resolveReplayPath } from '../src/log/replay.js';
import { createSyntheticReplay } from '../src/log/backpressure-experiment.js';
import { validateUnsafeDemoSize } from '../src/log/unsafe-backpressure-demo.js';

test('object-mode match events become NDJSON and parse across chunks with a final partial line', async () => {
  const transform = new EventToNdjson();
  const chunks = [];
  transform.on('data', (chunk) => chunks.push(chunk));
  transform.end({ type: 'join', name: 'Ace' });
  await once(transform, 'end');
  assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')), {
    type: 'join',
    name: 'Ace',
  });

  const records = [];
  for await (const record of parseNdjson(
    Readable.from([Buffer.from('{"id":'), Buffer.from('1}\n{"id":2}')]),
  )) {
    records.push(record);
  }
  assert.deepEqual(records, [{ id: 1 }, { id: 2 }]);
  await assert.rejects(async () => {
    const invalidRecords = [];
    for await (const record of parseNdjson(Readable.from(['not json']))) {
      invalidRecords.push(record);
    }
  }, SyntaxError);
});

test('MatchLog uses a bounded pipeline, records events, and flushes before close resolves', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'dogfight-match-log-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const failures = [];
  const log = new MatchLog({
    logDir: temp,
    roomId: 'room-one',
    onError: (error) => failures.push(error),
  });
  await log.append({ t: 1, type: 'join', name: 'Ace' });
  await log.append({ t: 2, type: 'chat', text: 'ready' });
  await log.close();
  const contents = await readFile(log.filePath, 'utf8');
  assert.deepEqual(
    contents
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).type),
    ['join', 'chat'],
  );
  assert.deepEqual(failures, []);
  await assert.rejects(log.append({ type: 'late' }), /already closed/);
  assert.throws(() => resolveReplayPath(temp, '..\\secret.ndjson'), /invalid/);
});

test('pipeline respects a slow writable and propagates stream errors', async () => {
  let writeCalls = 0;
  const slow = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      writeCalls += 1;
      setTimeout(callback, 1);
    },
  });
  await pipeline(Readable.from(Array.from({ length: 20 }, () => Buffer.alloc(32))), slow);
  assert.equal(writeCalls, 20);

  const failure = new Error('test disk failure');
  const broken = new Writable({
    write(_chunk, _encoding, callback) {
      callback(failure);
    },
  });
  await assert.rejects(pipeline(Readable.from(['record']), broken), failure);
});

test('synthetic replay generation is bounded and the unsafe demo has a strict cap', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'dogfight-generated-replay-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const replay = await createSyntheticReplay(temp, 0.02);
  assert.ok(replay.sizeBytes <= replay.targetBytes);
  assert.match(replay.id, /^backpressure-\d{13}-[a-f0-9]{8}\.ndjson$/);
  assert.throws(() => validateUnsafeDemoSize(8.1), /capped at 8 MB/);
  assert.equal(validateUnsafeDemoSize(1), 1024 * 1024);
});

test('match log reports bounded queue overflow rather than growing without limit', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'dogfight-match-limit-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const log = new MatchLog({ logDir: temp, roomId: 'bounded', maxPending: 1 });
  const pending = log.append({ t: 1, type: 'one' });
  await assert.rejects(log.append({ t: 2, type: 'two' }), /safety limit/);
  await pending.catch(() => {});
  await assert.rejects(log.close());
});
