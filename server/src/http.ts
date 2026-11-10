import { createReadStream, createWriteStream } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { performance } from 'node:perf_hooks';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import type { ServerConfig } from './config.ts';
import { resolveReplayPath } from './log/replay.ts';
import type { MatchManager } from './match.ts';
import type { RoomConfig, RoomManager } from './rooms.ts';

type Logger = Pick<Console, 'error'>;

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mp3', 'audio/mpeg'],
  ['.svg', 'image/svg+xml'],
  ['.wav', 'audio/wav'],
  ['.webp', 'image/webp'],
]);

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    ...headers,
  });
  response.end(body);
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      request.resume();
      throw new HttpError(413, 'Request body is too large.');
    }
    chunks.push(chunk);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return body;
  } catch (error: unknown) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Request body must be a valid JSON object.');
  }
}

const roomRequestSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .refine(
      (value) =>
        ![...value].some((character) => {
          const code = character.codePointAt(0);
          return code !== undefined && (code < 0x20 || code === 0x7f);
        }),
    ),
  maxPlayers: z.number().int().min(1).max(64).optional(),
  arena: z.strictObject({
    asteroidCount: z.number().int().min(0).max(100).default(6),
    seed: z
      .number()
      .int()
      .default(() => Math.floor(Math.random() * 1_000_000)),
  }),
});

const botRequestSchema = z.strictObject({
  count: z.number().int().min(1).max(8).default(1),
});

function validateCreateRoom(body: unknown): RoomConfig {
  const parsed = roomRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Room request is invalid.');
  }
  return parsed.data;
}

async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  config: ServerConfig,
): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw new HttpError(405, 'Method not allowed.');
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw new HttpError(400, 'Request path is malformed.');
  }

  const root = await realpath(config.clientDistDir).catch((error: unknown) => {
    if (isMissingPathError(error)) return config.clientDistDir;
    throw error;
  });
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^[/\\]+/, '');
  const filePath = path.resolve(root, relativePath);
  const relative = path.relative(root, filePath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new HttpError(404, 'File not found.');
  }

  try {
    await access(filePath);
    const realFilePath = await realpath(filePath);
    const realRelative = path.relative(root, realFilePath);
    if (
      realRelative === '..' ||
      realRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(realRelative)
    ) {
      throw new HttpError(404, 'File not found.');
    }
    const fileInfo = await stat(realFilePath);
    if (!fileInfo.isFile()) {
      throw new HttpError(404, 'File not found.');
    }
    const extension = path.extname(realFilePath).toLowerCase();
    response.writeHead(200, {
      'Content-Type': MIME_TYPES.get(extension) ?? 'application/octet-stream',
      'Content-Length': fileInfo.size,
      'Cache-Control': /[.-][a-f0-9]{8,}[.-]/i.test(path.basename(realFilePath))
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    });
    if (request.method === 'HEAD') {
      response.end();
    } else {
      await pipeline(createReadStream(realFilePath), response);
    }
  } catch (error: unknown) {
    if (error instanceof HttpError) {
      throw error;
    }
    if (isMissingPathError(error)) {
      throw new HttpError(404, 'File not found.');
    }
    throw error;
  }
}

async function handleDevelopmentRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  config: ServerConfig,
): Promise<boolean> {
  if (!config.enableDevRoutes || request.method !== 'GET') {
    return false;
  }
  if (url.pathname === '/api/dev/missing-sprites.svg') {
    sendJson(response, 404, { error: 'Test sprite asset intentionally missing.' });
    return true;
  }
  if (url.pathname === '/api/dev/corrupt.json') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{"arena":');
    return true;
  }
  if (url.pathname === '/api/dev/slow.json') {
    const timer = setTimeout(() => {
      if (!response.destroyed) {
        sendJson(response, 200, { width: 960, height: 600, asteroidCount: 6 });
      }
    }, 1500);
    timer.unref?.();
    response.once('close', () => clearTimeout(timer));
    return true;
  }
  if (url.pathname === '/api/slow') {
    const started = performance.now();
    const deadline = started + 300;
    while (performance.now() < deadline) {
      // Deliberately blocks only in development to demonstrate main-thread event-loop stalls.
    }
    sendJson(response, 200, { elapsedMs: Math.round(performance.now() - started) });
    return true;
  }
  return false;
}

export interface HttpServerOptions {
  readonly config: ServerConfig;
  readonly roomManager: RoomManager;
  readonly matchManager: MatchManager;
  readonly logger?: Logger;
}

export function createHttpServer({
  config,
  roomManager,
  matchManager,
  logger = console,
}: HttpServerOptions): Server {
  const processStartedAt = performance.now();
  const cpuStartedAt = process.cpuUsage();
  const eventLoopStartedAt = performance.eventLoopUtilization();
  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');

    try {
      if (typeof request.url !== 'string' || request.url.length > 8192) {
        throw new HttpError(400, 'Request URL is invalid.');
      }
      let url;
      try {
        url = new URL(request.url, 'http://localhost');
      } catch {
        throw new HttpError(400, 'Request URL is malformed.');
      }

      if (await handleDevelopmentRoute(request, response, url, config)) {
        return;
      }
      if (url.pathname === '/health') {
        if (request.method !== 'GET') {
          response.setHeader('Allow', 'GET');
          throw new HttpError(405, 'Method not allowed.');
        }
        sendJson(response, 200, { status: 'ok' });
        return;
      }
      if (url.pathname === '/api/stats') {
        if (request.method !== 'GET') {
          response.setHeader('Allow', 'GET');
          throw new HttpError(405, 'Method not allowed.');
        }
        sendJson(response, 200, matchManager.stats());
        return;
      }
      if (url.pathname === '/api/performance') {
        if (request.method !== 'GET') {
          response.setHeader('Allow', 'GET');
          throw new HttpError(405, 'Method not allowed.');
        }
        const elapsedMs = Math.max(0, performance.now() - processStartedAt);
        const cpu = process.cpuUsage(cpuStartedAt);
        const eventLoop = performance.eventLoopUtilization(eventLoopStartedAt);
        const memory = process.memoryUsage();
        sendJson(response, 200, {
          elapsedMs,
          cpuUserMs: cpu.user / 1000,
          cpuSystemMs: cpu.system / 1000,
          cpuPercentOfOneCore: ((cpu.user + cpu.system) / (elapsedMs * 1000)) * 100,
          eventLoopActiveMs: eventLoop.active,
          eventLoopIdleMs: eventLoop.idle,
          eventLoopUtilization: eventLoop.utilization,
          memoryBytes: {
            rss: memory.rss,
            heapUsed: memory.heapUsed,
            heapTotal: memory.heapTotal,
            external: memory.external,
          },
        });
        return;
      }
      if (url.pathname === '/api/rooms') {
        if (request.method === 'GET') {
          sendJson(response, 200, { rooms: roomManager.listRooms() });
          return;
        }
        if (request.method !== 'POST') {
          response.setHeader('Allow', 'GET, POST');
          throw new HttpError(405, 'Method not allowed.');
        }
        const contentType = request.headers['content-type']?.split(';')[0]?.trim();
        if (contentType !== 'application/json') {
          throw new HttpError(415, 'Content-Type must be application/json.');
        }
        const body = validateCreateRoom(await readJsonBody(request, config.maxHttpBodyBytes));
        try {
          const room = roomManager.createRoom(body);
          sendJson(response, 201, { room: room.toJSON() });
        } catch (error: unknown) {
          if (error instanceof RangeError && /room limit/.test(error.message)) {
            throw new HttpError(409, 'The server has reached its room limit.');
          }
          if (error instanceof RangeError) {
            throw new HttpError(400, error.message);
          }
          throw error;
        }
        return;
      }

      const botsMatch = /^\/api\/rooms\/([^/]+)\/bots$/.exec(url.pathname);
      if (botsMatch) {
        const roomId = botsMatch[1];
        if (!roomId) throw new HttpError(404, 'Room not found.');
        const room = roomManager.getRoom(roomId);
        if (!room) throw new HttpError(404, 'Room not found.');
        if (request.method === 'POST') {
          const contentType = request.headers['content-type']?.split(';')[0]?.trim();
          if (contentType !== 'application/json') {
            throw new HttpError(415, 'Content-Type must be application/json.');
          }
          const parsed = botRequestSchema.safeParse(
            await readJsonBody(request, config.maxHttpBodyBytes),
          );
          if (!parsed.success) {
            throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Bot request is invalid.');
          }
          try {
            const bots = room.match?.addBots(parsed.data.count);
            if (!bots) throw new HttpError(503, 'The room match is not ready.');
            sendJson(response, 201, { bots, room: room.toJSON() });
          } catch (error: unknown) {
            if (error instanceof RangeError) throw new HttpError(409, error.message);
            throw error;
          }
          return;
        }
        if (request.method === 'DELETE') {
          const bots = room.match?.removeBots();
          if (!bots) throw new HttpError(503, 'The room match is not ready.');
          sendJson(response, 200, { removed: bots.length, room: room.toJSON() });
          return;
        }
        response.setHeader('Allow', 'POST, DELETE');
        throw new HttpError(405, 'Method not allowed.');
      }

      const replayMatch = /^\/api\/replays\/([^/]+)$/.exec(url.pathname);
      if (replayMatch && request.method === 'GET') {
        const replayId = replayMatch[1];
        if (!replayId) throw new HttpError(404, 'Replay not found.');
        await serveReplay(
          response,
          config.logDir,
          replayId,
          config.enableDevRoutes && url.searchParams.get('rss') === '1',
        );
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        throw new HttpError(404, 'API route not found.');
      }
      await serveStatic(request, response, url, config);
    } catch (error: unknown) {
      if (response.destroyed || response.writableEnded) {
        return;
      }
      if (error instanceof HttpError) {
        if (error.status === 405 && !response.hasHeader('Allow')) {
          response.setHeader('Allow', 'GET, HEAD');
        }
        sendJson(response, error.status, { error: error.message });
        return;
      }
      if (error instanceof TypeError && /room/.test(error.message)) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      logger.error('HTTP request failed:', error instanceof Error ? error.message : String(error));
      sendJson(response, 500, { error: 'The request could not be completed.' });
    }
  };

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void handler(request, response);
  });
  server.on('error', (error) => logger.error('HTTP server error:', error.message));
  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  return server;
}

async function serveReplay(
  response: ServerResponse,
  logDir: string,
  id: string,
  measureRss: boolean,
): Promise<void> {
  let filePath: string;
  try {
    filePath = resolveReplayPath(logDir, id);
    await stat(filePath);
  } catch (error: unknown) {
    if (isMissingPathError(error) || error instanceof TypeError) {
      throw new HttpError(404, 'Replay not found.');
    }
    throw error;
  }
  const sampler = measureRss ? createRssSampler(logDir, id) : null;
  response.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(sampler ? { 'X-RSS-File': path.basename(sampler.filename) } : {}),
  });
  try {
    await pipeline(createReadStream(filePath), response);
  } catch (error: unknown) {
    if (!response.destroyed) {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  } finally {
    await sampler?.stop();
  }
}

interface RssSampler {
  readonly filename: string;
  stop(): Promise<void>;
}

function createRssSampler(logDir: string, replayId: string): RssSampler {
  const filename = path.join(logDir, `replay-rss-${Date.now()}-${replayId.slice(0, 24)}.csv`);
  const output = createWriteStream(filename, { flags: 'wx' });
  output.on('error', (error) => console.error('RSS sampler failed:', error.message));
  output.write('elapsed_ms,rss_bytes\n');
  const started = performance.now();
  const sample = () => {
    output.write(`${Math.round(performance.now() - started)},${process.memoryUsage().rss}\n`);
  };
  sample();
  const timer = setInterval(() => {
    sample();
  }, 250);
  timer.unref?.();
  return {
    async stop() {
      clearInterval(timer);
      sample();
      output.end();
      await new Promise<void>((resolve) => output.once('finish', resolve));
    },
    filename,
  };
}

export function attachWebSocketUpgrade(
  server: Server,
  wss: WebSocketServer,
  logger: Logger = console,
): void {
  server.on('upgrade', (request, socket, head) => {
    socket.on('error', (error) => logger.error('WebSocket handshake socket error:', error.message));
    let pathname;
    try {
      pathname = new URL(request.url ?? '', 'http://localhost').pathname;
    } catch {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    if (pathname !== '/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, (webSocket: WebSocket) => {
      wss.emit('connection', webSocket, request);
    });
  });
  wss.on('error', (error) => logger.error('WebSocket server error:', error.message));
}

export function createWebSocketServer(config: ServerConfig): WebSocketServer {
  return new WebSocketServer({ noServer: true, maxPayload: config.maxPayloadBytes });
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}
