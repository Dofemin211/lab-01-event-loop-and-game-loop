import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager } from '../src/rooms.js';

test('Room emits join, chat, leave, and empty events and RoomManager removes empty rooms', () => {
  const manager = new RoomManager({ maxRooms: 2, maxPlayersPerRoom: 2 });
  const room = manager.createRoom({
    id: 'training',
    name: 'Training',
    maxPlayers: 2,
    arena: { asteroidCount: 3, seed: 27 },
  });
  const events = [];
  for (const type of ['join', 'chat', 'leave', 'event', 'empty']) {
    room.on(type, (detail) => events.push({ type, detail }));
  }

  room.join({ id: 'pilot-a', name: 'Ace' });
  const chat = room.chat('pilot-a', 'Ready');
  assert.equal(chat.name, 'Ace');
  assert.deepEqual(room.roster(), [{ id: 'pilot-a', name: 'Ace' }]);
  assert.equal(room.leave('pilot-a'), true);
  assert.equal(room.leave('pilot-a'), false);

  assert.deepEqual(
    events
      .filter(({ type }) => ['join', 'chat', 'leave', 'empty'].includes(type))
      .map(({ type }) => type),
    ['join', 'chat', 'leave', 'empty'],
  );
  assert.equal(manager.getRoom('training'), undefined);
  assert.throws(() => room.join({ id: 'pilot-b', name: 'B' }), /no longer available/);
});

test('Room and manager enforce player, room, and data limits', () => {
  const manager = new RoomManager({ maxRooms: 2, maxPlayersPerRoom: 1 });
  const room = manager.createRoom({
    id: 'one',
    name: 'One',
    maxPlayers: 1,
    arena: { asteroidCount: 1, seed: 1 },
  });
  assert.throws(
    () =>
      manager.createRoom({
        name: 'Too many seats',
        maxPlayers: 2,
        arena: { asteroidCount: 1, seed: 2 },
      }),
    /cannot exceed/,
  );
  room.join({ id: 'a', name: 'Ace' });
  assert.throws(() => room.join({ id: 'b', name: 'Bee' }), /full/);
  manager.createRoom({ name: 'Two', arena: { asteroidCount: 1, seed: 2 } });
  assert.throws(
    () => manager.createRoom({ name: 'Three', arena: { asteroidCount: 1, seed: 3 } }),
    /room limit/,
  );
  assert.throws(
    () =>
      new RoomManager({
        initialRooms: [
          { id: 'bad/path', name: 'Bad', maxPlayers: 1, arena: { asteroidCount: 0, seed: 1 } },
        ],
      }),
    /Room id/,
  );
});
