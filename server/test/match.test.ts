import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/rooms.ts';
import { Match } from '../src/match.ts';
import type { MatchSnapshot, TimerHandle } from '../src/match.ts';

interface FakeTimer extends TimerHandle {
  readonly callback: () => void;
  readonly delay: number;
  cancelled: boolean;
}

function createRoom() {
  return new Room({
    id: 'netcode-test',
    name: 'Netcode test',
    maxPlayers: 2,
    arena: { asteroidCount: 0, seed: 2025 },
  });
}

test('Match schedules authoritative 30 Hz ticks against an absolute deadline and acknowledges inputs', () => {
  let now = 100;
  const timers: FakeTimer[] = [];
  const match = new Match(createRoom(), {
    now: () => now,
    schedule: (callback, delay) => {
      const timer = { callback, delay, cancelled: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    cancel: (timer) => {
      timer.cancelled = true;
    },
  });
  const room = match.room;
  const pilot = room.join({ id: 'pilot-a', name: 'Ace' });
  const playerState = match.players.get(pilot.id);
  const ship = playerState?.ship;
  assert.ok(ship);
  const initialY = ship.pos.y;
  const snapshots: MatchSnapshot[] = [];
  match.on('snapshot', (snapshot) => snapshots.push(snapshot));

  const firstTimer = timers[0];
  assert.ok(firstTimer);
  assert.ok(Math.abs(firstTimer.delay - 1000 / 30) < 0.0001);
  match.enqueueInput(pilot.id, {
    seq: 1,
    tick: 1,
    turn: 0,
    thrust: true,
    brake: false,
    fire: false,
  });
  now += firstTimer.delay;
  firstTimer.callback();

  assert.equal(match.tick, 1);
  assert.ok(ship.pos.y < initialY);
  const snapshot = snapshots[0];
  assert.ok(snapshot);
  assert.equal(snapshot.tick, 1);
  assert.deepEqual(snapshot.acks, [{ entityId: pilot.entityId, seq: 1 }]);
  const secondTimer = timers[1];
  assert.ok(secondTimer);
  assert.ok(Math.abs(secondTimer.delay - 1000 / 30) < 0.0001);
  assert.equal(match.stats().tickRate, 30);
  match.stop();
  assert.equal(secondTimer.cancelled, true);
});

test('Match rejects invalid, duplicated, stale, and implausibly gapped command sequences', () => {
  const match = new Match(createRoom(), {
    now: () => 0,
    schedule: () => ({ unref() {} }),
    cancel: () => {},
  });
  const pilot = match.room.join({ id: 'pilot-b', name: 'Nova' });
  const command = {
    seq: 1,
    tick: 1,
    turn: 0,
    thrust: false,
    brake: false,
    fire: false,
  };
  assert.throws(() => match.enqueueInput(pilot.id, { ...command, turn: 1000 }), /turn/i);
  match.enqueueInput(pilot.id, command);
  assert.throws(() => match.enqueueInput(pilot.id, command), /sequence/i);
  assert.throws(() => match.enqueueInput(pilot.id, { ...command, seq: 300 }), /sequence/i);
  match.stop();
  match.room.leave(pilot.id);
});

test('leaving a room despawns that player and stops its timer when the room becomes empty', () => {
  const timers: FakeTimer[] = [];
  const room = createRoom();
  const match = new Match(room, {
    now: () => 0,
    schedule: (callback, delay) => {
      const timer = { callback, delay, cancelled: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    cancel: (timer) => {
      timer.cancelled = true;
    },
  });
  const pilot = room.join({ id: 'pilot-c', name: 'Comet' });
  const shipId = pilot.entityId;
  assert.ok(shipId);
  assert.ok(match.world.get(shipId));
  room.leave(pilot.id);
  assert.equal(match.world.get(shipId), undefined);
  assert.equal(match.running, false);
  assert.equal(timers[0]?.cancelled, true);
});

test('authoritative snapshots preserve pickup effects and a renderable explosion envelope', () => {
  let now = 0;
  const timers: FakeTimer[] = [];
  const room = createRoom();
  const match = new Match(room, {
    now: () => now,
    schedule: (callback, delay) => {
      const timer = { callback, delay, cancelled: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    cancel: () => {},
  });
  room.join({ id: 'pilot-effects', name: 'Nova' });
  match.world.spawn(match.world.createExplosion(200, 200));
  const snapshots: MatchSnapshot[] = [];
  match.on('snapshot', (snapshot) => snapshots.push(snapshot));

  const firstTimer = timers[0];
  assert.ok(firstTimer);
  now += firstTimer.delay;
  firstTimer.callback();

  const snapshot = snapshots[0];
  assert.ok(snapshot);
  assert.ok(
    snapshot.entities.some((entity) => entity.kind === 'pickup' && entity.effect === 'shield'),
  );
  const explosion = snapshot.entities.find((entity) => entity.kind === 'explosion');
  assert.ok(explosion);
  assert.ok(explosion.radius > 0);
  assert.ok(explosion.ttl > 0);
  match.stop();
});
