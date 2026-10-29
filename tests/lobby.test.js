import test from 'node:test';
import assert from 'node:assert/strict';
import { Lobby, parseRooms } from '../src/lobby.js';

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
  let changed = null;
  let joined = null;
  lobby.addEventListener('roomsChanged', (event) => {
    changed = event.detail.rooms;
  });
  lobby.addEventListener('roomJoined', (event) => {
    joined = event.detail;
  });

  await lobby.refresh();
  lobby.setPlayerName('Ace');
  const result = lobby.join('one');

  assert.equal(changed[0].id, 'one');
  assert.equal(result.room.arena.seed, 27);
  assert.equal(joined.playerName, 'Ace');
  assert.equal(lobby.state, 'joined');
  assert.throws(() => lobby.join('missing'), /not available/);
});

test('A stale refresh cannot overwrite the newest response', async () => {
  let callCount = 0;
  let resolveFirst;
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

  assert.equal(lobby.rooms[0].name, 'New response');
});

test('Lobby polling stops cleanly and aborts an in-flight request', async () => {
  let requestSignal;
  let scheduled = 0;
  let cleared = 0;
  const lobby = new Lobby({
    fetchRooms: (_url, { signal }) => {
      requestSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
    setTimer: () => {
      scheduled += 1;
      return scheduled;
    },
    clearTimer: () => {
      cleared += 1;
    },
  });
  let failures = 0;
  lobby.addEventListener('lobbyError', () => {
    failures += 1;
  });

  lobby.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(requestSignal);
  lobby.stop();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requestSignal.aborted, true);
  assert.equal(scheduled, 0);
  assert.equal(failures, 0);
  assert.equal(cleared, 0);
});

test('A lobby request timeout becomes a visible lobbyError and retry can recover', async () => {
  let calls = 0;
  const lobby = new Lobby({
    timeoutMs: 5,
    fetchRooms: (_url, { signal }) => {
      calls += 1;
      if (calls === 1) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return Promise.resolve(validPayload);
    },
  });
  let reportedError = null;
  lobby.addEventListener('lobbyError', (event) => {
    reportedError = event.detail.error;
  });

  const keepAlive = setTimeout(() => {}, 20);
  await assert.rejects(lobby.refresh(), { name: 'TimeoutError' });
  clearTimeout(keepAlive);
  assert.equal(reportedError.name, 'TimeoutError');
  await lobby.refresh();
  assert.equal(lobby.rooms[0].id, 'one');
});
