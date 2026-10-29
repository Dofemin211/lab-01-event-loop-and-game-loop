import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createConfig } from '../config.js';
import { createApplication } from '../index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MAX_EXPERIMENT_BYTES = 200 * 1024 * 1024;

export async function createSyntheticReplay(logDir, sizeMb = 200) {
  if (!Number.isFinite(sizeMb) || sizeMb <= 0 || sizeMb > 200) {
    throw new RangeError('Synthetic replay size must be greater than 0 and no more than 200 MB.');
  }
  const targetBytes = Math.floor(sizeMb * 1024 * 1024);
  if (targetBytes > MAX_EXPERIMENT_BYTES) {
    throw new RangeError('Synthetic replay exceeds the hard 200 MB safety limit.');
  }
  await mkdir(logDir, { recursive: true });
  const id = `backpressure-${Date.now()}-${randomBytes(4).toString('hex')}.ndjson`;
  const filePath = path.join(logDir, id);

  async function* records() {
    let written = 0;
    let sequence = 0;
    while (written < targetBytes) {
      const base = { t: Date.now(), type: 'synthetic', sequence, payload: '' };
      const remaining = targetBytes - written;
      const overhead = Buffer.byteLength(JSON.stringify(base)) + 1;
      const payloadLength = Math.min(4096, remaining - overhead);
      if (payloadLength < 0) {
        return;
      }
      const record = Buffer.from(
        `${JSON.stringify({ ...base, payload: 'x'.repeat(payloadLength) })}\n`,
      );
      if (record.length > remaining) {
        return;
      }
      yield record;
      written += record.length;
      sequence += 1;
    }
  }

  await pipeline(
    Readable.from(records(), { objectMode: false }),
    createWriteStream(filePath, { flags: 'wx' }),
  );
  const info = await stat(filePath);
  return { id, filePath, sizeBytes: info.size, targetBytes };
}

function readOptions(args) {
  const options = { sizeMb: 200, delayMs: 4 };
  for (const arg of args) {
    const [key, raw] = arg.replace(/^--/, '').split('=');
    if (key === 'size-mb') {
      options.sizeMb = Number(raw);
    } else if (key === 'delay-ms') {
      options.delayMs = Number(raw);
    } else {
      throw new TypeError(`Unknown experiment option "${arg}". Use --size-mb and --delay-ms.`);
    }
  }
  if (!Number.isFinite(options.delayMs) || options.delayMs < 0 || options.delayMs > 100) {
    throw new RangeError('Download delay must be between 0 and 100 ms per chunk.');
  }
  return options;
}

class SlowWritable extends Writable {
  constructor(delayMs) {
    super({ highWaterMark: 64 * 1024 });
    this.delayMs = delayMs;
    this.bytes = 0;
  }

  _write(chunk, _encoding, callback) {
    this.bytes += chunk.length;
    setTimeout(callback, this.delayMs);
  }
}

export async function runBackpressureExperiment(args = process.argv.slice(2)) {
  const { sizeMb, delayMs } = readOptions(args);
  const baseConfig = createConfig(process.env, ROOT);
  const synthetic = await createSyntheticReplay(baseConfig.logDir, sizeMb);
  const application = createApplication({
    config: { ...baseConfig, port: 0, host: '127.0.0.1', enableDevRoutes: true },
    initialRooms: [],
  });
  try {
    const address = await application.start();
    const url = `http://127.0.0.1:${address.port}/api/replays/${synthetic.id}?rss=1`;
    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw new Error(`Replay download failed with HTTP ${response.status}.`);
    }
    const sink = new SlowWritable(delayMs);
    await pipeline(Readable.fromWeb(response.body), sink);
    const csvName = response.headers.get('x-rss-file');
    const csvPath = csvName ? path.join(baseConfig.logDir, csvName) : null;
    console.log(
      JSON.stringify(
        {
          replay: synthetic.id,
          bytes: sink.bytes,
          expectedBytes: synthetic.sizeBytes,
          rssCsv: csvPath,
          note: 'RSS samples are actual process.memoryUsage().rss readings during this local throttled stream.',
        },
        null,
        2,
      ),
    );
    return { synthetic, bytes: sink.bytes, csvPath };
  } finally {
    await application.shutdown();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runBackpressureExperiment();
  } catch (error) {
    console.error('Backpressure experiment failed:', error.message);
    process.exitCode = 1;
  }
}
