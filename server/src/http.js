import { createReadStream, createWriteStream } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { WebSocketServer } from 'ws';
import { resolveReplayPath } from './log/replay.js';

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
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

function sendJson(response, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    ...headers,
  });
  response.end(body);
}

async function readJsonBody(request, maxBytes) {
  const chunks = [];
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
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new SyntaxError('Expected a JSON object.');
    }
    return body;
  } catch {
    throw new HttpError(400, 'Request body must be a valid JSON object.');
  }
}

function validateCreateRoom(body) {
  const allowed = new Set(['name', 'maxPlayers', 'arena']);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new HttpError(400, 'Room request contains unsupported fields.');
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 48 || hasControlCharacters(name)) {
    throw new HttpError(400, 'Room name must contain 1–48 printable characters.');
  }

  function hasControlCharacters(value) {
    return [...value].some((character) => {
      const code = character.codePointAt(0);
      return code < 0x20 || code === 0x7f;
    });
  }
  const maxPlayers = body.maxPlayers;
  if (
    maxPlayers !== undefined &&
    (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > 64)
  ) {
    throw new HttpError(400, 'Room player limit must be an integer between 1 and 64.');
  }
  const arena = body.arena;
  const asteroidCount = arena?.asteroidCount ?? 6;
  const seed = arena?.seed ?? Math.floor(Math.random() * 1_000_000);
  if (
    !arena ||
    typeof arena !== 'object' ||
    Array.isArray(arena) ||
    Object.keys(arena).some((key) => !['asteroidCount', 'seed'].includes(key)) ||
    !Number.isInteger(asteroidCount) ||
    asteroidCount < 0 ||
    asteroidCount > 100 ||
    !Number.isInteger(seed)
  ) {
    throw new HttpError(400, 'Arena must include a valid asteroid count and integer seed.');
  }
  return { name, maxPlayers, arena: { asteroidCount, seed } };
}

async function serveStatic(request, response, url, config) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw new HttpError(405, 'Method not allowed.');
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw new HttpError(400, 'Request path is malformed.');
  }

  const root = await realpath(config.clientDistDir).catch(() => config.clientDistDir);
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
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      throw new HttpError(404, 'File not found.');
    }
    throw error;
  }
}

async function handleDevelopmentRoute(request, response, url, config) {
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

export function createHttpServer({ config, roomManager, logger = console }) {
  const handler = async (request, response) => {
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
      if (url.pathname === '/api/rooms') {
        if (request.method === 'GET') {
          sendJson(response, 200, { rooms: roomManager.listRooms() });
          return;
        }
        if (request.method !== 'POST') {
          response.setHeader('Allow', 'GET, POST');
          throw new HttpError(405, 'Method not allowed.');
        }
        const contentType = request.headers['content-type']?.split(';')[0].trim();
        if (contentType !== 'application/json') {
          throw new HttpError(415, 'Content-Type must be application/json.');
        }
        const body = validateCreateRoom(await readJsonBody(request, config.maxHttpBodyBytes));
        try {
          const room = roomManager.createRoom(body);
          sendJson(response, 201, { room: room.toJSON() });
        } catch (error) {
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

      const replayMatch = /^\/api\/replays\/([^/]+)$/.exec(url.pathname);
      if (replayMatch && request.method === 'GET') {
        await serveReplay(
          response,
          config.logDir,
          replayMatch[1],
          config.enableDevRoutes && url.searchParams.get('rss') === '1',
        );
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        throw new HttpError(404, 'API route not found.');
      }
      await serveStatic(request, response, url, config);
    } catch (error) {
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
      logger.error('HTTP request failed:', error.message);
      sendJson(response, 500, { error: 'The request could not be completed.' });
    }
  };

  const server = createServer((request, response) => {
    void handler(request, response);
  });
  server.on('error', (error) => logger.error('HTTP server error:', error.message));
  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  return server;
}

async function serveReplay(response, logDir, id, measureRss) {
  let filePath;
  try {
    filePath = resolveReplayPath(logDir, id);
    await stat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof TypeError) {
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
  } catch (error) {
    if (!response.destroyed) {
      response.destroy(error);
    }
  } finally {
    await sampler?.stop();
  }
}

function createRssSampler(logDir, replayId) {
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
      await new Promise((resolve) => output.once('finish', resolve));
    },
    filename,
  };
}

export function attachWebSocketUpgrade(server, wss, logger = console) {
  server.on('upgrade', (request, socket, head) => {
    socket.on('error', (error) => logger.error('WebSocket handshake socket error:', error.message));
    let pathname;
    try {
      pathname = new URL(request.url, 'http://localhost').pathname;
    } catch {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    if (pathname !== '/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, (webSocket) => {
      wss.emit('connection', webSocket, request);
    });
  });
  wss.on('error', (error) => logger.error('WebSocket server error:', error.message));
}

export function createWebSocketServer(config) {
  return new WebSocketServer({ noServer: true, maxPayload: config.maxPayloadBytes });
}
