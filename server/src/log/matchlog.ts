import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Room } from '../rooms.ts';

type Logger = Pick<Console, 'error'>;

export class EventToNdjson extends Transform {
  constructor() {
    super({ writableObjectMode: true });
  }

  override _transform(
    event: unknown,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      const serialized = JSON.stringify(event);
      if (serialized === undefined) {
        callback(new TypeError('Match log events must be JSON serializable.'));
        return;
      }
      callback(null, `${serialized}\n`);
    } catch (error: unknown) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

export interface MatchLogOptions {
  readonly logDir: string;
  readonly roomId: string;
  readonly maxPending?: number;
  readonly onError?: (error: Error) => void;
}

export class MatchLog {
  readonly logDir: string;
  readonly roomId: string;
  readonly maxPending: number;
  readonly onError: (error: Error) => void;
  readonly fileId: string;
  readonly filePath: string;
  readonly source: PassThrough;
  readonly completion: Promise<void>;
  pending: number;
  queue: Promise<void>;
  closed: boolean;
  failure: Error | null;

  constructor({ logDir, roomId, maxPending = 1024, onError = () => {} }: MatchLogOptions) {
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

  async #start(): Promise<void> {
    try {
      await mkdir(this.logDir, { recursive: true });
      await pipeline(
        this.source,
        new EventToNdjson(),
        createWriteStream(this.filePath, { flags: 'wx' }),
      );
    } catch (error: unknown) {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #fail(error: Error): void {
    if (this.failure) {
      return;
    }
    this.failure = error;
    if (!this.source.destroyed) {
      this.source.destroy(error);
    }
    this.onError(error);
  }

  append(event: unknown): Promise<void> {
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
    this.queue = operation.catch((error: unknown) => {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
    });
    return operation;
  }

  async close(): Promise<void> {
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

export interface MatchLogManagerOptions {
  readonly logDir: string;
  readonly logger?: Logger;
}

export class MatchLogManager {
  readonly logDir: string;
  readonly logger: Logger;
  readonly logs = new Map<string, MatchLog>();
  readonly pendingClose = new Set<Promise<void>>();

  constructor({ logDir, logger = console }: MatchLogManagerOptions) {
    this.logDir = logDir;
    this.logger = logger;
  }

  attach(room: Room): MatchLog {
    const log = new MatchLog({
      logDir: this.logDir,
      roomId: room.id,
      onError: (error) => this.logger.error(`Match log ${room.id} failed:`, error.message),
    });
    this.logs.set(room.id, log);
    const onEvent = (event: unknown): void => {
      void log.append(event).catch((error: unknown) => {
        this.logger.error(
          `Could not record room ${room.id} event:`,
          error instanceof Error ? error.message : String(error),
        );
      });
    };
    room.on('event', onEvent);
    room.once('empty', () => {
      room.off('event', onEvent);
      this.logs.delete(room.id);
      const closing = log
        .close()
        .catch((error: unknown) => {
          this.logger.error(
            `Could not finish room ${room.id} log:`,
            error instanceof Error ? error.message : String(error),
          );
        })
        .finally(() => this.pendingClose.delete(closing));
      this.pendingClose.add(closing);
    });
    return log;
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled([
      ...[...this.logs.values()].map((log) => log.close()),
      ...this.pendingClose,
    ]);
    this.logs.clear();
    this.pendingClose.clear();
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.error(
          'Could not flush a match log:',
          result.reason instanceof Error ? result.reason.message : String(result.reason),
        );
      }
    }
  }
}
