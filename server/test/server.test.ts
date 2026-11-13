import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { TestContext } from 'node:test';
import type { OutgoingHttpHeaders } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { decodeBinary, encodeBinary } from '@dogfight/shared/codec';
import type { BinaryMessage } from '@dogfight/shared/codec';
import { parseServerMessage } from '@dogfight/shared/protocol';
import type { ServerMessage } from '@dogfight/shared/protocol';
import { createConfig } from '../src/config.ts';
import type { ServerConfig } from '../src/config.ts';
import { createApplication } from '../src/index.ts';
import type { RoomConfig } from '../src/rooms.ts';
import { ActiveConnectionLimiter, normalizeIpAddress } from '../src/ws-security.ts';
import { z } from 'zod';

const quietLogger = { error() {}, info() {} };
const roomDefinition = {
  id: 'training',
  name: 'Training sector',
  maxPlayers: 2,
  arena: { asteroidCount: 4, seed: 2025 },
};

const roomListSchema = z.object({ rooms: z.array(z.object({ id: z.string() })) });
const createdRoomSchema = z.object({ room: z.object({ name: z.string() }) });
const healthSchema = z.object({
  status: z.string(),
  version: z.string(),
  gitSha: z.string(),
});
const statsSchema = z.array(z.object({ tickRate: z.number() }));

interface SetupOptions extends Partial<ServerConfig> {
  readonly initialRooms?: readonly RoomConfig[];
}

type FrameMessage = BinaryMessage | ServerMessage;
type FrameType = FrameMessage['type'];
type FrameOf<Type extends FrameType> = Extract<FrameMessage, { type: Type }>;
type ServerMessageType = ServerMessage['type'];
type ServerMessageOf<Type extends ServerMessageType> = Extract<ServerMessage, { type: Type }>;

async function readJson<Value>(response: Response, schema: z.ZodType<Value>): Promise<Value> {
  const data: unknown = await response.json();
  return schema.parse(data);
}

async function setup(t: TestContext, options: SetupOptions = {}) {
  const { initialRooms = [roomDefinition], ...overrides } = options;
  const temp = await mkdtemp(path.join(os.tmpdir(), 'dogfight-server-test-'));
  const clientDistDir = path.join(temp, 'client');
  const logDir = path.join(temp, 'logs');
  await mkdir(clientDistDir, { recursive: true });
  await writeFile(path.join(clientDistDir, 'index.html'), '<h1>flight deck</h1>');
  await writeFile(path.join(temp, 'secret.txt'), 'not public');
  const defaults = createConfig({}, process.cwd());
  const config: ServerConfig = {
    ...defaults,
    host: '127.0.0.1',
    port: 0,
    clientDistDir,
    logDir,
    enableDevRoutes: false,
    maxHttpBodyBytes: 256,
    maxRooms: 2,
    maxPlayersPerRoom: 2,
    joinTimeoutMs: 300,
    heartbeatIntervalMs: 10_000,
    ...overrides,
  };
  const rooms = initialRooms.map((room) => ({
    ...room,
    maxPlayers: Math.min(room.maxPlayers ?? config.maxPlayersPerRoom, config.maxPlayersPerRoom),
  }));
  const app = createApplication({
    config,
    logger: quietLogger,
    initialRooms: rooms,
    buildInfo: { version: 'test-version', gitSha: 'test-sha' },
  });
  const address = await app.start();
  if (!address || typeof address === 'string') {
    throw new Error('The test server did not bind to a network address.');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const wsUrl = `ws://127.0.0.1:${address.port}/ws`;
  t.after(async () => {
    await app.shutdown();
    await rm(temp, { recursive: true, force: true });
  });
  return { app, temp, clientDistDir, logDir, baseUrl, wsUrl };
}

function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  socket.on('error', () => {});
  return once(socket, 'open').then(() => socket);
}

function openSocketWithHeaders(url: string, headers: Record<string, string>): Promise<WebSocket> {
  const socket = new WebSocket(url, { headers });
  socket.on('error', () => {});
  return once(socket, 'open').then(() => socket);
}

function expectHandshakeRejection(
  url: string,
  headers: OutgoingHttpHeaders,
  expectedStatus: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.on('error', () => {});
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      socket.terminate();
      try {
        assert.equal(response.statusCode, expectedStatus);
        resolve();
      } catch (error: unknown) {
        reject(error);
      }
    });
    socket.once('open', () => {
      socket.close();
      reject(new Error(`Expected the WebSocket handshake to return HTTP ${expectedStatus}.`));
    });
  });
}

function nextMessage<Type extends ServerMessageType>(
  socket: WebSocket,
  type: Type,
  predicate?: (message: ServerMessageOf<Type>) => boolean,
  timeoutMs?: number,
): Promise<ServerMessageOf<Type>>;
function nextMessage(
  socket: WebSocket,
  type: ServerMessageType,
  predicate: (message: ServerMessage) => boolean = () => true,
  timeoutMs = 1500,
): Promise<ServerMessage> {
  return new Promise<ServerMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for a WebSocket message.'));
    }, timeoutMs);
    const onMessage = (data: WebSocket.RawData) => {
      const parsed = parseServerMessage(data.toString());
      if (parsed.success && parsed.data.type === type && predicate(parsed.data)) {
        cleanup();
        resolve(parsed.data);
      } else if (!parsed.success) {
        cleanup();
        reject(new Error(parsed.error.message));
      }
    };
    const onClose = (code: number) => {
      cleanup();
      reject(new Error(`WebSocket closed before the expected message (${code}).`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('close', onClose);
    };
    socket.on('message', onMessage);
    socket.once('close', onClose);
  });
}

function nextFrame<Type extends FrameType>(
  socket: WebSocket,
  type: Type,
  predicate?: (message: FrameOf<Type>) => boolean,
  timeoutMs?: number,
): Promise<FrameOf<Type>>;
function nextFrame(
  socket: WebSocket,
  type: FrameType,
  predicate: (message: FrameMessage) => boolean = () => true,
  timeoutMs = 1500,
): Promise<FrameMessage> {
  return new Promise<FrameMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for a WebSocket frame.'));
    }, timeoutMs);
    const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        const message = decodeBinary(data);
        if (message.type === type && predicate(message)) {
          cleanup();
          resolve(message);
        }
        return;
      }
      const parsed = parseServerMessage(data.toString());
      if (parsed.success && parsed.data.type === type && predicate(parsed.data)) {
        cleanup();
        resolve(parsed.data);
      } else if (!parsed.success) {
        cleanup();
        reject(new Error(parsed.error.message));
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('message', onMessage);
    };
    socket.on('message', onMessage);
  });
}

function waitForClose(socket: WebSocket, timeoutMs = 1500): Promise<number | null> {
  if (socket.readyState === WebSocket.CLOSED) {
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('close', onClose);
      reject(new Error('Timed out waiting for close.'));
    }, timeoutMs);
    const onClose = (code: number): void => {
      clearTimeout(timer);
      resolve(code);
    };
    socket.once('close', onClose);
  });
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Timed out waiting for the condition.');
}

function rawGet(
  port: string,
  requestPath: string,
): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: requestPath, method: 'GET' },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}

function parseJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  return value;
}

test('HTTP server serves health, validated rooms, static files and safe error statuses', async (t) => {
  const { app, baseUrl, clientDistDir, temp } = await setup(t);
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await readJson(health, healthSchema), {
    status: 'ok',
    version: 'test-version',
    gitSha: 'test-sha',
  });
  const ready = await fetch(`${baseUrl}/ready`);
  assert.equal(ready.status, 200);
  assert.equal((await readJson(ready, healthSchema)).status, 'ready');
  app.readiness.ready = false;
  app.readiness.draining = true;
  assert.equal((await fetch(`${baseUrl}/ready`)).status, 503);
  app.readiness.ready = true;
  app.readiness.draining = false;

  const rooms = await fetch(`${baseUrl}/api/rooms`);
  assert.equal(rooms.status, 200);
  assert.equal((await readJson(rooms, roomListSchema)).rooms[0]?.id, 'training');

  const created = await fetch(`${baseUrl}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Fresh sector',
      maxPlayers: 2,
      arena: { asteroidCount: 5, seed: 99 },
    }),
  });
  assert.equal(created.status, 201);
  assert.equal((await readJson(created, createdRoomSchema)).room.name, 'Fresh sector');

  const malformed = await fetch(`${baseUrl}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  assert.equal(malformed.status, 400);
  const wrongType = await fetch(`${baseUrl}/api/rooms`, { method: 'POST', body: '{}' });
  assert.equal(wrongType.status, 415);
  const oversized = await fetch(`${baseUrl}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'x'.repeat(300), arena: { asteroidCount: 1, seed: 1 } }),
  });
  assert.equal(oversized.status, 413);
  const invalidRoom = await fetch(`${baseUrl}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Invalid arena', arena: [] }),
  });
  assert.equal(invalidRoom.status, 400);
  const atCapacity = await fetch(`${baseUrl}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Last room', arena: { asteroidCount: 1, seed: 1 } }),
  });
  assert.equal(atCapacity.status, 409);

  const staticResponse = await fetch(`${baseUrl}/`);
  assert.equal(staticResponse.status, 200);
  assert.match(staticResponse.headers.get('content-type') ?? '', /text\/html/);
  assert.equal(staticResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await staticResponse.text(), '<h1>flight deck</h1>');
  assert.equal((await fetch(`${baseUrl}/missing.js`)).status, 404);
  const traversal = await rawGet(new URL(baseUrl).port, '/..%2fsecret.txt');
  assert.equal(traversal.status, 404);
  assert.equal(
    await (await import('node:fs/promises')).readFile(path.join(temp, 'secret.txt'), 'utf8'),
    'not public',
  );
  assert.equal((await fetch(`${baseUrl}/api/rooms`, { method: 'DELETE' })).status, 405);
  assert.equal((await fetch(`${baseUrl}/health`, { method: 'POST' })).status, 405);
  const securityStats = await fetch(`${baseUrl}/api/security-stats`);
  assert.equal(securityStats.status, 200);
  assert.deepEqual(await securityStats.json(), {
    activeConnections: 0,
    trackedIps: 0,
    rejections: {
      origin_rejected: 0,
      ip_limit_exceeded: 0,
      invalid_handshake: 0,
      rate_limited: 0,
      payload_rejected: 0,
    },
  });
  const metricsResponse = await fetch(`${baseUrl}/metrics`);
  assert.equal(metricsResponse.status, 200);
  assert.match(metricsResponse.headers.get('content-type') ?? '', /text\/plain/);
  const metrics = await metricsResponse.text();
  for (const metric of [
    'game_players ',
    'game_rooms ',
    'game_websocket_messages_received_per_second ',
    'game_websocket_bytes_sent_per_second ',
    'game_tick_duration_p99_ms ',
    'game_event_loop_utilization ',
    'game_process_resident_memory_bytes ',
    'game_websocket_rejections_total{reason="origin_rejected"} ',
  ]) {
    assert.ok(metrics.includes(metric), `Metrics endpoint is missing ${metric}.`);
  }
  assert.match(metrics, /game_players 0/);
  assert.ok(clientDistDir);
});

test('WebSocket Origin policy allows exact configured origins and rejects invalid, missing, and unlisted origins', async (t) => {
  const { wsUrl, app } = await setup(t, {
    nodeEnv: 'production',
    allowedOrigins: ['https://game.example', 'https://admin.example'],
  });
  for (const origin of ['https://game.example', 'https://admin.example']) {
    const socket = await new Promise<WebSocket>((resolve, reject) => {
      const client = new WebSocket(wsUrl, { headers: { Origin: origin } });
      client.on('error', () => {});
      client.once('open', () => resolve(client));
      client.once('unexpected-response', (_request, response) => {
        response.resume();
        reject(new Error(`Allowed origin was rejected with HTTP ${response.statusCode}.`));
      });
    });
    socket.close();
    await waitForClose(socket);
  }
  await expectHandshakeRejection(wsUrl, { Origin: 'https://attacker.example' }, 403);
  await expectHandshakeRejection(wsUrl, {}, 403);
  await expectHandshakeRejection(wsUrl, { Origin: 'null' }, 403);
  await expectHandshakeRejection(wsUrl, { Origin: 'not an origin' }, 403);
  await expectHandshakeRejection(
    wsUrl,
    { Origin: ['https://game.example', 'https://game.example'] },
    403,
  );
  assert.equal(app.securityMetrics.snapshot(0, 0).rejections.origin_rejected, 5);
});

test('production WebSocket listener rejects clients when its Origin allowlist is empty', async (t) => {
  const { wsUrl, app } = await setup(t, { nodeEnv: 'production', allowedOrigins: [] });
  await expectHandshakeRejection(wsUrl, { Origin: 'https://game.example' }, 403);
  await expectHandshakeRejection(wsUrl, {}, 403);
  assert.equal(app.securityMetrics.snapshot(0, 0).rejections.origin_rejected, 2);
});

test('development WebSocket listener permits missing and same-host loopback Origins only', async (t) => {
  const { wsUrl } = await setup(t);
  const localOrigin = new URL(wsUrl).origin.replace(/^ws:/, 'http:');
  const socket = await new Promise<WebSocket>((resolve, reject) => {
    const client = new WebSocket(wsUrl, { headers: { Origin: localOrigin } });
    client.on('error', () => {});
    client.once('open', () => resolve(client));
    client.once('unexpected-response', (_request, response) => {
      response.resume();
      reject(new Error(`Local development origin was rejected with HTTP ${response.statusCode}.`));
    });
  });
  socket.close();
  await waitForClose(socket);

  const noOrigin = await openSocket(wsUrl);
  noOrigin.close();
  await waitForClose(noOrigin);
  await expectHandshakeRejection(wsUrl, { Origin: 'http://attacker.example' }, 403);
});

test('per-IP limits ignore untrusted forwarded headers and release connections exactly once', async (t) => {
  const { app, wsUrl } = await setup(t, { maxConnectionsPerIp: 1 });
  const first = await openSocket(wsUrl);
  assert.equal(app.connectionLimiter.activeConnections, 1);
  await expectHandshakeRejection(wsUrl, { 'X-Forwarded-For': '203.0.113.99' }, 429);
  assert.equal(app.securityMetrics.snapshot(1, 1).rejections.ip_limit_exceeded, 1);

  first.close();
  await waitForClose(first);
  await waitForCondition(() => app.connectionLimiter.activeConnections === 0);
  assert.equal(app.connectionLimiter.trackedIps, 0);
  const afterDisconnect = await openSocket(wsUrl);
  afterDisconnect.close();
  await waitForClose(afterDisconnect);

  const limiter = new ActiveConnectionLimiter(1, 1);
  const release = limiter.reserve('192.0.2.1');
  assert.ok(release);
  assert.equal(limiter.reserve('192.0.2.2'), null);
  release();
  release();
  assert.equal(limiter.activeConnections, 0);
  assert.equal(limiter.trackedIps, 0);
  const nextIp = limiter.reserve('192.0.2.2');
  assert.ok(nextIp);
  nextIp();
  assert.equal(normalizeIpAddress('::ffff:192.0.2.1'), normalizeIpAddress('::ffff:c000:201'));
});

test('trusted proxy forwarding is honored only for configured proxy socket addresses', async (t) => {
  const { app, wsUrl } = await setup(t, {
    maxConnectionsPerIp: 1,
    trustedProxyIps: ['127.0.0.1', '127.0.0.2'],
  });
  const first = await openSocketWithHeaders(wsUrl, {
    'X-Forwarded-For': '198.51.100.1, 127.0.0.2',
  });
  const second = await openSocketWithHeaders(wsUrl, {
    'X-Forwarded-For': '198.51.100.2, 127.0.0.2',
  });
  assert.equal(app.connectionLimiter.activeConnections, 2);
  await expectHandshakeRejection(wsUrl, { 'X-Forwarded-For': '198.51.100.1, 127.0.0.2' }, 429);
  first.terminate();
  second.terminate();
  await Promise.all([waitForClose(first), waitForClose(second)]);
  assert.equal(app.connectionLimiter.activeConnections, 0);
});

test('two WebSocket clients join, receive rosters and chat, then disconnect cleanup removes the room', async (t) => {
  const { app, wsUrl, baseUrl } = await setup(t);
  const first = await openSocket(wsUrl);
  const second = await openSocket(wsUrl);
  t.after(() => {
    first.close();
    second.close();
  });

  first.send(JSON.stringify({ version: 0, type: 'join', room: 'training', name: 'Ace' }));
  await nextMessage(first, 'joined');
  const firstRoster = nextMessage(first, 'roster', (message) => message.players.length === 2);
  const secondRoster = nextMessage(second, 'roster', (message) => message.players.length === 2);
  const secondJoined = nextMessage(second, 'joined');
  second.send(JSON.stringify({ version: 0, type: 'join', room: 'training', name: 'Nova' }));
  const rosters = await Promise.all([firstRoster, secondRoster]);
  assert.deepEqual(
    rosters[0].players.map((player) => player.name),
    ['Ace', 'Nova'],
  );
  await secondJoined;

  const firstChat = nextMessage(first, 'chat');
  const secondChat = nextMessage(second, 'chat');
  first.send(JSON.stringify({ version: 0, type: 'chat', text: 'Ready to fly' }));
  const messages = await Promise.all([firstChat, secondChat]);
  assert.equal(messages[0].message.name, 'Ace');
  assert.equal(messages[1].message.text, 'Ready to fly');

  const replayId = app.roomManager.getRoom('training')?.replayId;
  assert.ok(replayId);
  second.close();
  await waitForClose(second);
  await nextMessage(first, 'roster', (message) => message.players.length === 1);
  const roomRemoved = once(app.roomManager, 'roomRemoved', {
    signal: AbortSignal.timeout(1500),
  });
  first.close();
  await waitForClose(first);
  await roomRemoved;
  await Promise.all([...app.logManager.pendingClose]);
  assert.equal(app.roomManager.getRoom('training'), undefined);
  const emptyRoomList = await readJson(await fetch(`${baseUrl}/api/rooms`), roomListSchema);
  assert.deepEqual(emptyRoomList.rooms, []);
  const replay = await fetch(`${baseUrl}/api/replays/${replayId}`);
  assert.equal(replay.status, 200);
  assert.match(replay.headers.get('content-type') ?? '', /application\/x-ndjson/);
  const replayText = await replay.text();
  assert.match(replayText, /"type":"join"/);
  assert.match(replayText, /"type":"chat"/);
  assert.match(replayText, /"type":"leave"/);
});

test('binary clients receive authoritative snapshots and can control only through sequenced input', async (t) => {
  const { wsUrl, baseUrl } = await setup(t);
  const socket = await openSocket(wsUrl);
  const joinedPromise = nextFrame(socket, 'joined');
  const firstSnapshotPromise = nextFrame(socket, 'snapshot');
  socket.send(
    JSON.stringify({
      version: 0,
      type: 'join',
      room: 'training',
      name: 'Binary pilot',
      codec: 'binary',
    }),
  );
  const joined = await joinedPromise;
  assert.ok(Number.isInteger(joined.player.entityId));
  const initialSnapshot = await firstSnapshotPromise;
  const ownEntity = initialSnapshot.entities.find((entity) => entity.id === joined.player.entityId);
  assert.ok(ownEntity);
  assert.equal(ownEntity.kind, 'ship');

  const acknowledgedSnapshotPromise = nextFrame(socket, 'snapshot', (message) =>
    message.acks.some(({ entityId, seq }) => entityId === joined.player.entityId && seq >= 1),
  );
  socket.send(
    Buffer.from(
      encodeBinary({
        type: 'input',
        seq: 1,
        tick: 1,
        turn: 1,
        thrust: true,
        brake: false,
        fire: false,
      }),
    ),
  );
  const acknowledged = await acknowledgedSnapshotPromise;
  const movedEntity = acknowledged.entities.find((entity) => entity.id === joined.player.entityId);
  assert.ok(movedEntity);
  assert.ok(Math.hypot(movedEntity.x - ownEntity.x, movedEntity.y - ownEntity.y) > 0);

  const statsResponse = await rawGet(new URL(baseUrl).port, '/api/stats');
  assert.equal(statsResponse.status, 200);
  assert.equal(statsSchema.parse(parseJson(statsResponse.body))[0]?.tickRate, 30);
  socket.close();
});

test('WebSocket join timeout, invalid JSON, oversized messages and token bucket close connections safely', async (t) => {
  const { app, wsUrl } = await setup(t, {
    maxPayloadBytes: 1024,
    messageRatePerSecond: 1,
    joinTimeoutMs: 100,
  });
  const idle = await openSocket(wsUrl);
  const idleCode = await waitForClose(idle);
  assert.equal(idleCode, 1008);

  const malformed = await openSocket(wsUrl);
  malformed.send('{');
  const malformedCode = await waitForClose(malformed);
  assert.equal(malformedCode, 1007);

  const oversized = await openSocket(wsUrl);
  oversized.send('x'.repeat(2048));
  const oversizedCode = await waitForClose(oversized);
  assert.equal(oversizedCode, 1009);

  const rateLimited = await openSocket(wsUrl);
  rateLimited.send(JSON.stringify({ version: 0, type: 'join', room: 'training', name: 'Ace' }));
  await nextMessage(rateLimited, 'joined');
  rateLimited.send(JSON.stringify({ version: 0, type: 'chat', text: 'too soon' }));
  const rateCode = await waitForClose(rateLimited);
  assert.equal(rateCode, 1008);
  const securityStats = await app.securityMetrics.snapshot(
    app.connectionLimiter.activeConnections,
    app.connectionLimiter.trackedIps,
  );
  assert.equal(securityStats.rejections.payload_rejected, 2);
  assert.equal(securityStats.rejections.rate_limited, 1);
});

test('room player cap rejects a second participant and graceful shutdown closes connected sockets', async (t) => {
  const { app, wsUrl } = await setup(t, {
    maxPlayersPerRoom: 1,
    initialRooms: [roomDefinition],
  });
  const first = await openSocket(wsUrl);
  first.send(JSON.stringify({ version: 0, type: 'join', room: 'training', name: 'Ace' }));
  await nextMessage(first, 'joined');
  const second = await openSocket(wsUrl);
  second.send(JSON.stringify({ version: 0, type: 'join', room: 'training', name: 'Nova' }));
  await nextMessage(second, 'error');
  const secondCode = await waitForClose(second);
  assert.equal(secondCode, 1008);

  const firstClose = waitForClose(first);
  const shutdownNotice = nextMessage(first, 'shutdown');
  const shutdown = app.shutdown();
  assert.equal(app.readiness.ready, false);
  assert.equal(app.readiness.draining, true);
  const notice = await shutdownNotice;
  assert.match(notice.message, /reconnecting/i);
  await shutdown;
  const firstCode = await firstClose;
  assert.equal(firstCode, 1001);
  assert.equal(app.server.listening, false);
  await assert.rejects(openSocket(wsUrl));
});
