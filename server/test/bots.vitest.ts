import { once } from 'node:events';
import { expect, test } from 'vitest';
import { createConfig } from '../src/config.ts';
import { createHttpServer } from '../src/http.ts';
import { Match, MatchManager } from '../src/match.ts';
import type { MatchSnapshot, TimerHandle } from '../src/match.ts';
import { Room, RoomManager } from '../src/rooms.ts';

function runBots(): { readonly world: unknown; readonly snapshots: readonly MatchSnapshot[] } {
  let now = 0;
  const timers: Array<() => void> = [];
  const room = new Room({
    id: 'bots-test',
    name: 'Bots test',
    maxPlayers: 4,
    arena: { asteroidCount: 0, seed: 725 },
  });
  const match = new Match(room, {
    now: () => now,
    schedule: (callback): TimerHandle => {
      timers.push(callback);
      return { unref() {}, cancel() {} };
    },
    cancel: () => {},
  });
  const snapshots: MatchSnapshot[] = [];
  match.on('snapshot', (snapshot) => snapshots.push(snapshot));
  match.addBots(2);
  for (let index = 0; index < 30; index += 1) {
    const tick = timers.shift();
    if (!tick) throw new Error('Expected the match to schedule its next bot tick.');
    now = match.nextTickAt;
    tick();
  }
  const result = { world: match.world.toSnapshot(), snapshots };
  match.stop();
  return result;
}

test('bots: server bots produce deterministic authoritative snapshots', () => {
  const result = runBots();
  expect(result).toEqual(runBots());
  expect(
    result.snapshots[0]?.entities.some(
      (entity) => entity.kind === 'ship' && (entity.vx !== 0 || entity.vy !== 0),
    ),
  ).toBe(true);
});

test('bot addition is capacity-checked atomically and bots can be removed', () => {
  const room = new Room({
    id: 'bot-capacity',
    name: 'Bot capacity',
    maxPlayers: 2,
    arena: { asteroidCount: 0, seed: 1 },
  });
  const match = new Match(room, { schedule: () => ({ unref() {} }), cancel: () => {} });
  expect(() => match.addBots(9)).toThrow(/between 1 and 8/);
  expect(room.players.size).toBe(0);
  const bots = match.addBots(2);
  expect(bots.map(({ id }) => id)).toEqual(['bot-1', 'bot-2']);
  expect(() => match.addBots(1)).toThrow(/available player slots/);
  expect(room.players.size).toBe(2);
  expect(match.removeBots()).toHaveLength(2);
  expect(room.players.size).toBe(0);
  match.stop();
});

test('bot HTTP endpoint adds bots, rejects malformed counts, and removes bots', async () => {
  const config = createConfig({ PORT: '0' }, process.cwd());
  const roomManager = new RoomManager({ maxPlayersPerRoom: 3 });
  const matchManager = new MatchManager(roomManager);
  roomManager.createRoom({
    id: 'http-bots',
    name: 'HTTP bots',
    maxPlayers: 3,
    arena: { asteroidCount: 0, seed: 4 },
  });
  const server = createHttpServer({ config, roomManager, matchManager, logger: { error() {} } });
  server.listen(config.port, config.host);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener address.');
  const baseUrl = `http://${address.address}:${address.port}`;
  try {
    const added = await fetch(`${baseUrl}/api/rooms/http-bots/bots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 2 }),
    });
    expect(added.status).toBe(201);
    const addedBody: unknown = await added.json();
    expect(addedBody).toMatchObject({
      bots: [
        { id: 'bot-1', name: 'AI Pilot 1' },
        { id: 'bot-2', name: 'AI Pilot 2' },
      ],
    });

    const invalid = await fetch(`${baseUrl}/api/rooms/http-bots/bots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 9 }),
    });
    expect(invalid.status).toBe(400);

    const performanceResponse = await fetch(`${baseUrl}/api/performance`);
    expect(performanceResponse.status).toBe(200);
    const performanceBody: unknown = await performanceResponse.json();
    expect(performanceBody).toMatchObject({
      cpuUserMs: expect.any(Number),
      cpuSystemMs: expect.any(Number),
      eventLoopUtilization: expect.any(Number),
      memoryBytes: { rss: expect.any(Number), heapUsed: expect.any(Number) },
    });

    const removed = await fetch(`${baseUrl}/api/rooms/http-bots/bots`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ removed: 2, room: { players: 0 } });
  } finally {
    matchManager.close();
    roomManager.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
