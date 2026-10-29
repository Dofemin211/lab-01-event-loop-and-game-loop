import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';

const REPLAY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}-\d{13}-[a-f0-9]{8}\.ndjson$/;

export function isReplayId(id) {
  return typeof id === 'string' && REPLAY_ID_PATTERN.test(id);
}

export function resolveReplayPath(logDir, id) {
  if (!isReplayId(id)) {
    throw new TypeError('Replay id is invalid.');
  }
  const resolved = path.resolve(logDir, id);
  if (path.dirname(resolved) !== path.resolve(logDir)) {
    throw new TypeError('Replay id is invalid.');
  }
  return resolved;
}

export async function* parseNdjson(readable) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  for await (const chunk of readable) {
    pending += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.trim()) {
        yield JSON.parse(line);
      }
    }
  }
  pending += decoder.end();
  if (pending.trim()) {
    yield JSON.parse(pending);
  }
}

export function createReplayStream(logDir, id) {
  return createReadStream(resolveReplayPath(logDir, id));
}
