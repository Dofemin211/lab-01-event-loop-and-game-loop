import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createConfig } from '../src/config.js';
import { createApplication } from '../src/index.js';

const quietLogger = { error() {}, info() {} };
const roomDefinition = {
  id: 'training',
  name: 'Training sector',
  maxPlayers: 2,
  arena: { asteroidCount: 4, seed: 2025 },
};

async function setup(t, { initialRooms = [roomDefinition], ...overrides } = {}) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'dogfight-server-test-'));
  const clientDistDir = path.join(temp, 'client');
  const logDir = path.join(temp, 'logs');
  await mkdir(clientDistDir, { recursive: true });
  await writeFile(path.join(clientDistDir, 'index.html'), '<h1>flight deck</h1>');
  await writeFile(path.join(temp, 'secret.txt'), 'not public');
  const defaults = createConfig({}, process.cwd());
  const config = {
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
    maxPlayers: Math.min(room.maxPlayers, config.maxPlayersPerRoom),
  }));
  const app = createApplication({ config, logger: quietLogger, initialRooms: rooms });
  const address = await app.start();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const wsUrl = `ws://127.0.0.1:${address.port}/ws`;
  t.after(async () => {
    await app.shutdown();
    await rm(temp, { recursive: true, force: true });
  });
  return { app, temp, clientDistDir, logDir, baseUrl, wsUrl };
}

function openSocket(url) {
  const socket = new WebSocket(url);
  socket.on('error', () => {});
  return once(socket, 'open').then(() => socket);
}

function nextMessage(socket, predicate = () => true, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for a WebSocket message.'));
    }, timeoutMs);
    const onMessage = (data) => {
      const message = JSON.parse(data.toString());
      if (predicate(message)) {
        cleanup();
        resolve(message);
      }
    };
    const onClose = (code) => {
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

function waitForClose(socket, timeoutMs = 1500) {
  if (socket.readyState === WebSocket.CLOSED) {
    return Promise.resolve(null);
  }
  return Promise.race([
    once(socket, 'close'),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timed out waiting for close.')), timeoutMs),
    ),
  ]);
}

function rawGet(port, requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: requestPath, method: 'GET' },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}

test('HTTP server serves health, validated rooms, static files and safe error statuses', async (t) => {
  const { baseUrl, clientDistDir, temp } = await setup(t);
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });

  const rooms = await fetch(`${baseUrl}/api/rooms`);
  assert.equal(rooms.status, 200);
  assert.equal((await rooms.json()).rooms[0].id, 'training');

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
  assert.equal((await created.json()).room.name, 'Fresh sector');

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
  assert.match(staticResponse.headers.get('content-type'), /text\/html/);
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
  assert.ok(clientDistDir);
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
  await nextMessage(first, (message) => message.type === 'joined');

  const firstRoster = nextMessage(
    first,
    (message) => message.type === 'roster' && message.players.length === 2,
  );
  const secondRoster = nextMessage(
    second,
    (message) => message.type === 'roster' && message.players.length === 2,
  );
  const secondJoined = nextMessage(second, (message) => message.type === 'joined');
  second.send(JSON.stringify({ version: 0, type: 'join', room: 'training', name: 'Nova' }));
  const rosters = await Promise.all([firstRoster, secondRoster]);
  assert.deepEqual(
    rosters[0].players.map((player) => player.name),
    ['Ace', 'Nova'],
  );
  await secondJoined;

  const firstChat = nextMessage(first, (message) => message.type === 'chat');
  const secondChat = nextMessage(second, (message) => message.type === 'chat');
  first.send(JSON.stringify({ version: 0, type: 'chat', text: 'Ready to fly' }));
  const messages = await Promise.all([firstChat, secondChat]);
  assert.equal(messages[0].message.name, 'Ace');
  assert.equal(messages[1].message.text, 'Ready to fly');

  const replayId = app.roomManager.getRoom('training').replayId;
  second.close();
  await waitForClose(second);
  await nextMessage(first, (message) => message.type === 'roster' && message.players.length === 1);
  const roomRemoved = once(app.roomManager, 'roomRemoved', {
    signal: AbortSignal.timeout(1500),
  });
  first.close();
  await waitForClose(first);
  await roomRemoved;
  await Promise.all([...app.logManager.pendingClose]);
  assert.equal(app.roomManager.getRoom('training'), undefined);
  assert.deepEqual((await (await fetch(`${baseUrl}/api/rooms`)).json()).rooms, []);
  const replay = await fetch(`${baseUrl}/api/replays/${replayId}`);
  assert.equal(replay.status, 200);
  assert.match(replay.headers.get('content-type'), /application\/x-ndjson/);
  const replayText = await replay.text();
  assert.match(replayText, /"type":"join"/);
  assert.match(replayText, /"type":"chat"/);
  assert.match(replayText, /"type":"leave"/);
});

test('WebSocket join timeout, invalid JSON, oversized messages and token bucket close connections safely', async (t) => {
  const { wsUrl } = await setup(t, {
    maxPayloadBytes: 1024,
    messageRatePerSecond: 1,
    joinTimeoutMs: 100,
  });
  const idle = await openSocket(wsUrl);
  const [idleCode] = await waitForClose(idle);
  assert.equal(idleCode, 1008);

  const malformed = await openSocket(wsUrl);
  malformed.send('{');
  const [malformedCode] = await waitForClose(malformed);
  assert.equal(malformedCode, 1007);

  const oversized = await openSocket(wsUrl);
  oversized.send('x'.repeat(2048));
  const [oversizedCode] = await waitForClose(oversized);
  assert.equal(oversizedCode, 1009);

  const rateLimited = await openSocket(wsUrl);
  rateLimited.send(JSON.stringify({ version: 0, type: 'join', room: 'training', name: 'Ace' }));
  await nextMessage(rateLimited, (message) => message.type === 'joined');
  rateLimited.send(JSON.stringify({ version: 0, type: 'chat', text: 'too soon' }));
  const [rateCode] = await waitForClose(rateLimited);
  assert.equal(rateCode, 1008);
});

test('room player cap rejects a second participant and graceful shutdown closes connected sockets', async (t) => {
  const { app, wsUrl } = await setup(t, {
    maxPlayersPerRoom: 1,
    initialRooms: [roomDefinition],
  });
  const first = await openSocket(wsUrl);
  first.send(JSON.stringify({ version: 0, type: 'join', room: 'training', name: 'Ace' }));
  await nextMessage(first, (message) => message.type === 'joined');
  const second = await openSocket(wsUrl);
  second.send(JSON.stringify({ version: 0, type: 'join', room: 'training', name: 'Nova' }));
  await nextMessage(second, (message) => message.type === 'error');
  const [secondCode] = await waitForClose(second);
  assert.equal(secondCode, 1008);

  await app.shutdown();
  const [firstCode] = await waitForClose(first);
  assert.equal(firstCode, 1001);
  assert.equal(app.server.listening, false);
});
