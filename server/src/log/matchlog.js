import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class EventToNdjson extends Transform {
  constructor() {
    super({ writableObjectMode: true });
  }

  _transform(event, _encoding, callback) {
    try {
      callback(null, `${JSON.stringify(event)}\n`);
    } catch (error) {
      callback(error);
    }
  }
}

export class MatchLog {
  constructor({ logDir, roomId, maxPending = 1024, onError = () => {} }) {
    this.logDir = logDir;
    this.roomId = roomId;
    this.maxPending = maxPending;
    this.onError = onError;
    this.pending = 0;
    this.queue = Promise.resolve();
    this.closed = false;
    this.failure = null;
    this.fileId = `${roomId}-${Date.now()}-${randomBytes(4).toString('hex')}.ndjson`;
    this.filePath = path.join(logDir, this.fileId);
    this.source = new PassThrough({ objectMode: true, highWaterMark: 16 });
    this.source.on('error', (error) => this.#fail(error));
    this.completion = this.#start();
  }

  async #start() {
    try {
      await mkdir(this.logDir, { recursive: true });
      await pipeline(
        this.source,
        new EventToNdjson(),
        createWriteStream(this.filePath, { flags: 'wx' }),
      );
    } catch (error) {
      this.#fail(error);
    }
  }

  #fail(error) {
    if (this.failure) {
      return;
    }
    this.failure = error;
    if (!this.source.destroyed) {
      this.source.destroy(error);
    }
    this.onError(error);
  }

  append(event) {
    if (this.closed) {
      return Promise.reject(new Error('Match log is already closed.'));
    }
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    if (this.pending >= this.maxPending) {
      const error = new Error('Match log queue reached its safety limit.');
      this.#fail(error);
      return Promise.reject(error);
    }
    this.pending += 1;
    const operation = this.queue
      .then(async () => {
        if (this.failure) {
          throw this.failure;
        }
        if (!this.source.write(event)) {
          await once(this.source, 'drain');
        }
      })
      .finally(() => {
        this.pending -= 1;
      });
    this.queue = operation.catch((error) => {
      this.#fail(error);
    });
    return operation;
  }

  async close() {
    if (!this.closed) {
      this.closed = true;
      await this.queue;
      if (!this.source.destroyed && !this.failure) {
        this.source.end();
      }
    }
    await this.completion;
    if (this.failure) {
      throw this.failure;
    }
  }
}

export class MatchLogManager {
  constructor({ logDir, logger = console }) {
    this.logDir = logDir;
    this.logger = logger;
    this.logs = new Map();
    this.pendingClose = new Set();
  }

  attach(room) {
    const log = new MatchLog({
      logDir: this.logDir,
      roomId: room.id,
      onError: (error) => this.logger.error(`Match log ${room.id} failed:`, error.message),
    });
    this.logs.set(room.id, log);
    const onEvent = (event) => {
      void log.append(event).catch((error) => {
        this.logger.error(`Could not record room ${room.id} event:`, error.message);
      });
    };
    room.on('event', onEvent);
    room.once('empty', () => {
      room.off('event', onEvent);
      this.logs.delete(room.id);
      const closing = log
        .close()
        .catch((error) => {
          this.logger.error(`Could not finish room ${room.id} log:`, error.message);
        })
        .finally(() => this.pendingClose.delete(closing));
      this.pendingClose.add(closing);
    });
    return log;
  }

  async close() {
    const results = await Promise.allSettled([
      ...[...this.logs.values()].map((log) => log.close()),
      ...this.pendingClose,
    ]);
    this.logs.clear();
    this.pendingClose.clear();
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.error('Could not flush a match log:', result.reason.message);
      }
    }
  }
}
