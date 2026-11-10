import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientNetcode, SnapshotBuffer } from '../src/netcode.ts';
import type { InputState } from '../src/input.ts';
import type { SnapshotEntity, SnapshotMessage } from '@dogfight/shared/protocol';

type InputCommand = {
  seq: number;
  tick: number;
  turn: -1 | 0 | 1;
  thrust: boolean;
  brake: boolean;
  fire: boolean;
};

const ship = (id: number, x: number, angle = 0): SnapshotEntity => ({
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
  ownerId: 0,
  commandSeq: 0,
  ttl: 0,
  score: 0,
});

function snapshot(
  tick: number,
  entities: SnapshotEntity[],
  acks: SnapshotMessage['acks'] = [],
): SnapshotMessage {
  return { version: 0, type: 'snapshot', tick, entities, acks };
}

function controls(isDown: (code: string) => boolean): InputState {
  return {
    isDown,
    justPressed: () => false,
    endFrame: () => {},
    clear: () => {},
  };
}

test('snapshot interpolation blends remote entities and handles entities appearing or disappearing', () => {
  const buffer = new SnapshotBuffer();
  buffer.add(snapshot(10, [ship(1, 10), ship(3, 30)]), 100);
  buffer.add(snapshot(12, [ship(1, 30, Math.PI - 0.1), ship(2, 20)]), 200);
  const midpoint = buffer.interpolate(11);
  assert.equal(midpoint.find((entity) => entity.id === 1)?.x, 20);
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
  assert.equal(buffer.add(snapshot(11, []), 300), false);
});

test('snapshot interpolation crosses arena edges along the shortest wrapped path', () => {
  const buffer = new SnapshotBuffer({ width: 960, height: 600 });
  buffer.add(snapshot(10, [ship(1, 950)]), 100);
  buffer.add(snapshot(12, [ship(1, 10)]), 200);

  const midpoint = buffer.interpolate(11)[0];
  assert.ok(midpoint);
  assert.equal(midpoint.x, 0);
  assert.equal(midpoint.y, 100);
});

test('prediction reacts immediately and reconciliation replays only unacknowledged input', () => {
  const commands: InputCommand[] = [];
  const netcode = new ClientNetcode({
    sendInput: (command?: InputCommand) => {
      if (command) {
        commands.push(command);
      }
      return false;
    },
  });
  netcode.setIdentity({ id: 'pilot-a', entityId: 7 });
  netcode.receiveSnapshot(
    snapshot(1, [ship(7, 100, -Math.PI / 2)], [{ entityId: 7, seq: 0 }]),
    100,
  );
  netcode.step(
    1 / 30,
    controls((code) => code === 'ArrowUp'),
  );
  const currentPrediction = netcode.predicted;
  assert.ok(currentPrediction);
  const predicted = { ...currentPrediction };
  assert.ok(predicted.y < 100);
  assert.equal(netcode.pendingCount, 1);
  const command = commands[0];
  assert.ok(command);
  assert.equal(command.seq, 1);
  netcode.receiveSnapshot(
    snapshot(2, [ship(7, 100, -Math.PI / 2)], [{ entityId: 7, seq: 0 }]),
    150,
  );
  assert.ok(Math.abs((netcode.predicted?.y ?? Infinity) - predicted.y) < 0.001);
  assert.equal(netcode.pendingCount, 1);
  netcode.receiveSnapshot(
    snapshot(3, [ship(7, predicted.x, predicted.angle)], [{ entityId: 7, seq: 1 }]),
    200,
  );
  assert.equal(netcode.pendingCount, 0);
});

test('developer determinism experiment injects prediction-only drift that reconciliation corrects', () => {
  const netcode = new ClientNetcode();
  netcode.setIdentity({ id: 'pilot-a', entityId: 7 });
  netcode.receiveSnapshot(snapshot(1, [ship(7, 100)], [{ entityId: 7, seq: 0 }]), 100);
  netcode.setDeterminismBreak(true);
  netcode.step(
    1 / 30,
    controls(() => false),
  );
  assert.equal(netcode.predicted?.x, 101);

  netcode.receiveSnapshot(snapshot(2, [ship(7, 100)], [{ entityId: 7, seq: 1 }]), 150);
  assert.equal(netcode.predicted?.x, 100);
  assert.equal(netcode.correction, 1);
  assert.equal(netcode.pendingCount, 0);
});

test('local bullets appear immediately and reconcile when an authoritative commandSeq arrives', () => {
  const netcode = new ClientNetcode();
  netcode.setIdentity({ id: 'pilot-a', entityId: 7 });
  netcode.receiveSnapshot(snapshot(1, [ship(7, 100)], [{ entityId: 7, seq: 0 }]), 100);
  netcode.step(
    1 / 30,
    controls((code) => code === 'KeyF'),
  );
  const bullets = netcode.predictedBullets;
  assert.equal(bullets.length, 1);
  const bullet = bullets[0];
  assert.ok(bullet);
  const commandSeq = bullet.commandSeq;
  netcode.receiveSnapshot(
    snapshot(
      2,
      [
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
      [{ entityId: 7, seq: commandSeq }],
    ),
    150,
  );
  assert.equal(netcode.predictedBullets.length, 0);
  assert.equal(netcode.pendingCount, 0);
});
