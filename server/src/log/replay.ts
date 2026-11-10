import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import type { Readable } from 'node:stream';

const REPLAY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}-\d{13}-[a-f0-9]{8}\.ndjson$/;

export function isReplayId(id: unknown): id is string {
  return typeof id === 'string' && REPLAY_ID_PATTERN.test(id);
}

export function resolveReplayPath(logDir: string, id: string): string {
  if (!isReplayId(id)) {
    throw new TypeError('Replay id is invalid.');
  }
  const resolved = path.resolve(logDir, id);
  if (path.dirname(resolved) !== path.resolve(logDir)) {
    throw new TypeError('Replay id is invalid.');
  }
  return resolved;
}

export async function* parseNdjson(
  readable: AsyncIterable<Buffer | string | Uint8Array>,
): AsyncGenerator<unknown> {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  for await (const chunk of readable) {
    pending += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.trim()) {
        const event: unknown = JSON.parse(line);
        yield event;
      }
    }
  }
  pending += decoder.end();
  if (pending.trim()) {
    const event: unknown = JSON.parse(pending);
    yield event;
  }
}

export function createReplayStream(logDir: string, id: string): Readable {
  return createReadStream(resolveReplayPath(logDir, id));
}
