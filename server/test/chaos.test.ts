import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { parseServerMessage } from '@dogfight/shared/protocol';
import type { ServerMessage } from '@dogfight/shared/protocol';
import { createConfig } from '../src/config.ts';
import { createApplication } from '../src/index.ts';
import type { Application } from '../src/index.ts';
import type { RoomConfig } from '../src/rooms.ts';

const rooms: readonly RoomConfig[] = [
  {
    id: 'disconnect-room',
    name: 'Disconnect room',
    maxPlayers: 4,
    arena: { asteroidCount: 2, seed: 1 },
  },
  { id: 'flood-room', name: 'Flood room', maxPlayers: 4, arena: { asteroidCount: 2, seed: 2 } },
  { id: 'control-room', name: 'Control room', maxPlayers: 4, arena: { asteroidCount: 2, seed: 3 } },
];

async function setup(): Promise<{
  readonly app: Application;
  readonly baseUrl: string;
  readonly wsUrl: string;
  close(): Promise<void>;
}> {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'dogfight-chaos-'));
  const clientDistDir = path.join(temp, 'client');
  await mkdir(clientDistDir, { recursive: true });
  await writeFile(path.join(clientDistDir, 'index.html'), '<h1>chaos test</h1>');
  const config = {
    ...createConfig({}, process.cwd()),
    host: '127.0.0.1',
    port: 0,
    clientDistDir,
    logDir: path.join(temp, 'logs'),
    maxRooms: 4,
    maxPlayersPerRoom: 4,
    maxConnectionsPerIp: 8,
    messageRatePerSecond: 60,
    joinTimeoutMs: 2000,
    heartbeatIntervalMs: 10_000,
  };
  const app = createApplication({
    config,
    initialRooms: rooms,
    logger: { error() {}, info() {} },
  });
  const address = await app.start();
  if (!address || typeof address === 'string') {
    throw new Error('Chaos-test server did not bind to a network address.');
  }
  const port = address.port;
  return {
    app,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    async close() {
      await app.shutdown();
      await rm(temp, { recursive: true, force: true });
    },
  };
}

function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  socket.on('error', () => {});
  return once(socket, 'open').then(() => socket);
}

function waitForClose(socket: WebSocket): Promise<number> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve(1006);
  return new Promise((resolve) => {
    socket.once('close', (code) => resolve(code));
  });
}

function waitForMessage<Type extends ServerMessage['type']>(
  socket: WebSocket,
  type: Type,
): Promise<Extract<ServerMessage, { type: Type }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error(`Timed out waiting for ${type}.`));
    }, 3000);
    const onMessage = (data: WebSocket.RawData) => {
      const parsed = parseServerMessage(data.toString());
      if (parsed.success && parsed.data.type === type) {
        clearTimeout(timer);
        socket.off('message', onMessage);
        resolve(parsed.data as Extract<ServerMessage, { type: Type }>);
      }
    };
    socket.on('message', onMessage);
  });
}

async function join(socket: WebSocket, room: string, name: string) {
  const joined = waitForMessage(socket, 'joined');
  socket.send(JSON.stringify({ version: 0, type: 'join', room, name, codec: 'json' }));
  return joined;
}

async function waitUntil(
  predicate: () => boolean,
  description: string,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for ${description}.`);
}

async function readStats(baseUrl: string) {
  const response = await fetch(`${baseUrl}/api/stats`);
  assert.equal(response.status, 200);
  const value: unknown = await response.json();
  assert.ok(Array.isArray(value));
  return value as Array<{
    roomId: string;
    tick: number;
    tickDurationPercentilesMs: { p99: number };
  }>;
}

test('client disconnect releases its room slot and other pilots keep ticking; reconnect joins as a new session', async (t) => {
  const server = await setup();
  t.after(() => server.close());
  const departing = await openSocket(server.wsUrl);
  const survivor = await openSocket(server.wsUrl);
  const departingJoin = await join(departing, 'disconnect-room', 'Departing');
  await join(survivor, 'disconnect-room', 'Survivor');
  assert.notEqual(departingJoin.player.id, '');
  const before = (await readStats(server.baseUrl)).find(
    (match) => match.roomId === 'disconnect-room',
  );
  assert.ok(before);

  const disconnected = waitForClose(departing);
  departing.terminate();
  await disconnected;
  await waitUntil(
    () => server.app.roomManager.getRoom('disconnect-room')?.players.size === 1,
    'departed player cleanup',
  );
  await waitUntil(() => server.app.connectionLimiter.activeConnections === 1, 'IP slot release');
  await waitUntil(
    () =>
      (server.app.matchManager.stats().find((match) => match.roomId === 'disconnect-room')?.tick ??
        0) >
      before.tick + 2,
    'surviving match ticks',
  );

  const reconnected = await openSocket(server.wsUrl);
  const nextSession = await join(reconnected, 'disconnect-room', 'Departing');
  assert.notEqual(nextSession.player.id, departingJoin.player.id);
  assert.equal(server.app.roomManager.getRoom('disconnect-room')?.players.size, 2);
  survivor.terminate();
  reconnected.terminate();
  await Promise.all([waitForClose(survivor), waitForClose(reconnected)]);
});

test('paced garbage-frame flood is rejected while a separate control room keeps ticking', async (t) => {
  const server = await setup();
  t.after(() => server.close());
  const attacker = await openSocket(server.wsUrl);
  const attackObserver = await openSocket(server.wsUrl);
  const control = await openSocket(server.wsUrl);
  await join(attacker, 'flood-room', 'Attacker');
  await join(attackObserver, 'flood-room', 'Observer');
  await join(control, 'control-room', 'Control');
  await waitUntil(
    () =>
      server.app.matchManager
        .stats()
        .some((match) => match.roomId === 'flood-room' && match.tick > 2) &&
      server.app.matchManager
        .stats()
        .some((match) => match.roomId === 'control-room' && match.tick > 2),
    'both room simulations to start',
  );
  const initialStats = await readStats(server.baseUrl);
  const initialFloodP99 = initialStats.find((match) => match.roomId === 'flood-room')
    ?.tickDurationPercentilesMs.p99;
  const initialControlP99 = initialStats.find((match) => match.roomId === 'control-room')
    ?.tickDurationPercentilesMs.p99;
  assert.notEqual(initialFloodP99, undefined);
  assert.notEqual(initialControlP99, undefined);

  const targetFramesPerSecond = 1000;
  const frameIntervalMs = 1000 / targetFramesPerSecond;
  let attemptedFrames = 0;
  let firstAttemptAt: number | undefined;
  let lastAttemptAt: number | undefined;
  const floodClose = waitForClose(attacker);
  const startedAt = performance.now();
  for (let frame = 0; frame < targetFramesPerSecond; frame += 1) {
    const scheduledAt = startedAt + frame * frameIntervalMs;
    const waitMs = scheduledAt - performance.now();
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    if (attacker.readyState !== WebSocket.OPEN) break;
    const attemptedAt = performance.now();
    firstAttemptAt ??= attemptedAt;
    lastAttemptAt = attemptedAt;
    attacker.send('{');
    attemptedFrames += 1;
  }
  const elapsedMs = performance.now() - startedAt;
  const observedFramesPerSecond =
    attemptedFrames > 1 && firstAttemptAt !== undefined && lastAttemptAt !== undefined
      ? ((attemptedFrames - 1) / (lastAttemptAt - firstAttemptAt)) * 1000
      : null;
  const closeCode = await floodClose;
  assert.ok(attemptedFrames > 0, 'The paced flood did not send any frames.');
  assert.equal(closeCode, 1007);
  assert.equal(server.app.securityMetrics.snapshot(0, 0).rejections.payload_rejected, 1);

  const ticksBeforeRecovery = server.app.matchManager.stats();
  await waitUntil(
    () =>
      (server.app.matchManager.stats().find((match) => match.roomId === 'flood-room')?.tick ?? 0) >
        (ticksBeforeRecovery.find((match) => match.roomId === 'flood-room')?.tick ?? 0) + 2 &&
      (server.app.matchManager.stats().find((match) => match.roomId === 'control-room')?.tick ??
        0) >
        (ticksBeforeRecovery.find((match) => match.roomId === 'control-room')?.tick ?? 0) + 2,
    'both rooms to keep advancing after the flood',
  );
  const finalStats = await readStats(server.baseUrl);
  const floodP99 = finalStats.find((match) => match.roomId === 'flood-room')
    ?.tickDurationPercentilesMs.p99;
  const controlP99 = finalStats.find((match) => match.roomId === 'control-room')
    ?.tickDurationPercentilesMs.p99;
  assert.notEqual(floodP99, undefined);
  assert.notEqual(controlP99, undefined);
  console.log(
    JSON.stringify({
      scenario: 'garbage-frame-flood',
      attemptedFrames,
      targetFramesPerSecond,
      observedFramesPerSecond:
        observedFramesPerSecond === null ? null : Number(observedFramesPerSecond.toFixed(1)),
      frameIntervalMs,
      elapsedMs: Number(elapsedMs.toFixed(3)),
      note: 'The server closes the socket on the first malformed frame; remaining scheduled sends are cancelled.',
      closeCode,
      payloadRejected: server.app.securityMetrics.snapshot(0, 0).rejections.payload_rejected,
      tickP99Ms: {
        floodRoomBefore: initialFloodP99,
        floodRoomAfter: floodP99,
        controlRoomBefore: initialControlP99,
        controlRoomAfter: controlP99,
      },
    }),
  );

  attackObserver.terminate();
  control.terminate();
  await Promise.all([waitForClose(attackObserver), waitForClose(control)]);
});
