import test from 'node:test';
import assert from 'node:assert/strict';
import { Lobby, parseRooms } from '../src/lobby.ts';

const validPayload = {
  rooms: [
    {
      id: 'one',
      name: 'Training',
      players: 1,
      maxPlayers: 4,
      arena: { asteroidCount: 3, seed: 27 },
    },
  ],
};

test('parseRooms validates HTTP room data and rejects duplicate or malformed rooms', () => {
  assert.deepEqual(parseRooms(validPayload), validPayload.rooms);
  assert.throws(() => parseRooms({ rooms: [{ id: 'bad' }] }), /invalid fields/);
  assert.throws(
    () => parseRooms({ rooms: [validPayload.rooms[0], validPayload.rooms[0]] }),
    /duplicate id/,
  );
});

test('Lobby refresh dispatches roomsChanged and join emits selected room configuration', async () => {
  const lobby = new Lobby({ fetchRooms: async () => validPayload });
  let changed: ReturnType<typeof parseRooms> | undefined;
  let joined: ReturnType<Lobby['join']> | undefined;
  let state = '';
  lobby.addEventListener('roomsChanged', (event) => {
    if (event instanceof CustomEvent) {
      changed = event.detail.rooms;
    }
  });
  lobby.addEventListener('roomJoined', (event) => {
    if (event instanceof CustomEvent) {
      joined = event.detail;
    }
  });
  lobby.addEventListener('stateChanged', (event) => {
    if (event instanceof CustomEvent) {
      state = event.detail.state;
    }
  });

  await lobby.refresh();
  lobby.setPlayerName('Ace');
  const result = lobby.join('one');

  assert.equal(changed?.[0]?.id, 'one');
  assert.equal(result.room.arena.seed, 27);
  assert.equal(joined?.playerName, 'Ace');
  assert.equal(state, 'joined');
  assert.throws(() => lobby.join('missing'), /not available/);
});

test('A stale refresh cannot overwrite the newest response', async () => {
  let callCount = 0;
  let resolveFirst: (value: unknown) => void = () => {};
  const lobby = new Lobby({
    fetchRooms: () => {
      callCount += 1;
      if (callCount === 1) {
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve({
        rooms: [{ ...validPayload.rooms[0], name: 'New response' }],
      });
    },
  });

  const oldRefresh = lobby.refresh();
  const newRefresh = lobby.refresh();
  await newRefresh;
  resolveFirst({ rooms: [{ ...validPayload.rooms[0], name: 'Stale response' }] });
  await oldRefresh;

  const room = lobby.rooms[0];
  assert.ok(room);
  assert.equal(room.name, 'New response');
});

test('Lobby polling stops cleanly and aborts an in-flight request', async () => {
  let requestSignal: AbortSignal | undefined;
  let scheduled = 0;
  let cleared = 0;
  const lobby = new Lobby({
    fetchRooms: (_url, options: { signal: AbortSignal }) => {
      const signal = options.signal;
      requestSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
    setTimer: () => {
      scheduled += 1;
      return setTimeout(() => {}, 0);
    },
    clearTimer: (timer) => {
      cleared += 1;
      clearTimeout(timer);
    },
  });
  let failures = 0;
  lobby.addEventListener('lobbyError', () => {
    failures += 1;
  });

  lobby.start();
  await new Promise((resolve) => setImmediate(resolve));
  const signal = requestSignal;
  assert.ok(signal);
  lobby.stop();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(signal.aborted, true);
  assert.equal(scheduled, 0);
  assert.equal(failures, 0);
  assert.equal(cleared, 0);
});

test('A lobby request timeout becomes a visible lobbyError and retry can recover', async () => {
  let calls = 0;
  const lobby = new Lobby({
    timeoutMs: 5,
    fetchRooms: (_url, options: { signal: AbortSignal }) => {
      const signal = options.signal;
      calls += 1;
      if (calls === 1) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return Promise.resolve(validPayload);
    },
  });
  let reportedError: Error | undefined;
  lobby.addEventListener('lobbyError', (event) => {
    if (event instanceof CustomEvent) {
      reportedError = event.detail.error;
    }
  });

  const keepAlive = setTimeout(() => {}, 20);
  await assert.rejects(lobby.refresh(), { name: 'TimeoutError' });
  clearTimeout(keepAlive);
  assert.equal(reportedError?.name, 'TimeoutError');
  await lobby.refresh();
  const room = lobby.rooms[0];
  assert.ok(room);
  assert.equal(room.id, 'one');
});
