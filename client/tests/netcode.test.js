import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientNetcode, SnapshotBuffer } from '../src/netcode.js';

const ship = (id, x, angle = 0) => ({
  id,
  kind: 'ship',
  x,
  y: 100,
  vx: 0,
  vy: 0,
  angle,
  radius: 13,
  hp: 3,
  thrust: 0,
  invulnerableTime: 0,
  shield: false,
});

test('snapshot interpolation blends remote entities and handles entities appearing or disappearing', () => {
  const buffer = new SnapshotBuffer();
  buffer.add({ tick: 10, entities: [ship(1, 10), ship(3, 30)] }, 100);
  buffer.add({ tick: 12, entities: [ship(1, 30, Math.PI - 0.1), ship(2, 20)] }, 200);
  const midpoint = buffer.interpolate(11);
  assert.equal(midpoint.find((entity) => entity.id === 1).x, 20);
  assert.equal(
    midpoint.some((entity) => entity.id === 2),
    true,
  );
  assert.equal(
    midpoint.some((entity) => entity.id === 3),
    false,
  );
  assert.equal(
    buffer.interpolate(11.6).some((entity) => entity.id === 2),
    true,
  );
  assert.equal(buffer.add({ tick: 11, entities: [] }, 300), false);
});

test('snapshot interpolation crosses arena edges along the shortest wrapped path', () => {
  const buffer = new SnapshotBuffer({ width: 960, height: 600 });
  buffer.add({ tick: 10, entities: [ship(1, 950)] }, 100);
  buffer.add({ tick: 12, entities: [ship(1, 10)] }, 200);

  const midpoint = buffer.interpolate(11)[0];
  assert.equal(midpoint.x, 0);
  assert.equal(midpoint.y, 100);
});

test('prediction reacts immediately and reconciliation replays only unacknowledged input', () => {
  const commands = [];
  const netcode = new ClientNetcode({ sendInput: (command) => commands.push(command) });
  netcode.setIdentity({ id: 'pilot-a', entityId: 7 });
  netcode.receiveSnapshot(
    { tick: 1, acks: [{ entityId: 7, seq: 0 }], entities: [ship(7, 100, -Math.PI / 2)] },
    100,
  );
  netcode.step(1 / 30, { isDown: (code) => code === 'ArrowUp' });
  const predicted = { ...netcode.predicted };
  assert.ok(predicted.y < 100);
  assert.equal(netcode.pendingCount, 1);
  assert.equal(commands[0].seq, 1);
  netcode.receiveSnapshot(
    { tick: 2, acks: [{ entityId: 7, seq: 0 }], entities: [ship(7, 100, -Math.PI / 2)] },
    150,
  );
  assert.ok(Math.abs(netcode.predicted.y - predicted.y) < 0.001);
  assert.equal(netcode.pendingCount, 1);
  netcode.receiveSnapshot(
    {
      tick: 3,
      acks: [{ entityId: 7, seq: 1 }],
      entities: [ship(7, predicted.x, predicted.angle)],
    },
    200,
  );
  assert.equal(netcode.pendingCount, 0);
});

test('developer determinism experiment injects prediction-only drift that reconciliation corrects', () => {
  const netcode = new ClientNetcode();
  netcode.setIdentity({ id: 'pilot-a', entityId: 7 });
  netcode.receiveSnapshot(
    { tick: 1, acks: [{ entityId: 7, seq: 0 }], entities: [ship(7, 100)] },
    100,
  );
  netcode.setDeterminismBreak(true);
  netcode.step(1 / 30, { isDown: () => false });
  assert.equal(netcode.predicted.x, 101);

  netcode.receiveSnapshot(
    { tick: 2, acks: [{ entityId: 7, seq: 1 }], entities: [ship(7, 100)] },
    150,
  );
  assert.equal(netcode.predicted.x, 100);
  assert.equal(netcode.correction, 1);
  assert.equal(netcode.pendingCount, 0);
});

test('local bullets appear immediately and reconcile when an authoritative commandSeq arrives', () => {
  const netcode = new ClientNetcode();
  netcode.setIdentity({ id: 'pilot-a', entityId: 7 });
  netcode.receiveSnapshot(
    { tick: 1, acks: [{ entityId: 7, seq: 0 }], entities: [ship(7, 100)] },
    100,
  );
  netcode.step(1 / 30, { isDown: (code) => code === 'KeyF' });
  assert.equal(netcode.predictedBullets.length, 1);
  const commandSeq = netcode.predictedBullets[0].commandSeq;
  netcode.receiveSnapshot(
    {
      tick: 2,
      acks: [{ entityId: 7, seq: commandSeq }],
      entities: [
        ship(7, 100),
        {
          ...ship(8, 118),
          kind: 'bullet',
          ownerId: 7,
          commandSeq,
          ttl: 1.7,
          radius: 3,
        },
      ],
    },
    150,
  );
  assert.equal(netcode.predictedBullets.length, 0);
  assert.equal(netcode.pendingCount, 0);
});
