import test from 'node:test';
import assert from 'node:assert/strict';
import { Bullet } from '@dogfight/shared/sim/bullet';
import { Entity } from '@dogfight/shared/sim/entity';
import { GameSession } from '@dogfight/shared/sim/game';
import { Ship } from '@dogfight/shared/sim/ship';
import { Vector2 } from '@dogfight/shared/sim/vector';

function idleInput() {
  return { isDown: () => false };
}

function getPlayer(game: GameSession): Ship {
  const player = game.player;
  assert.ok(player);
  return player;
}

function isBulletDetail(detail: unknown): detail is { bullet: { kind: string } } {
  return (
    typeof detail === 'object' &&
    detail !== null &&
    'bullet' in detail &&
    typeof detail.bullet === 'object' &&
    detail.bullet !== null &&
    'kind' in detail.bullet &&
    typeof detail.bullet.kind === 'string'
  );
}

function isScoreDetail(detail: unknown): detail is { score: number } {
  return (
    typeof detail === 'object' &&
    detail !== null &&
    'score' in detail &&
    typeof detail.score === 'number'
  );
}

test('GameSession fires from held input, damages asteroids, and tracks score', () => {
  const game = new GameSession({ width: 640, height: 480, asteroidCount: 0 });
  const target = game.world.addAsteroid(80, 80, { radius: 16, hp: 1 });
  const player = getPlayer(game);
  game.world.spawn(
    new Bullet({
      pos: target.pos.clone(),
      ownerId: player.id,
      vel: new Vector2(),
    }),
  );
  const firedInput = { isDown: (code: string) => code === 'KeyF' };

  const events = game.step(0, firedInput);

  assert.equal(
    events.some((event) => event.type === 'asteroid-destroyed'),
    true,
  );
  assert.equal(game.score, 100);
  assert.equal(game.world.get(target.id), undefined);
  assert.ok([...game.world.ofKind('bullet')].length >= 1);
});

test('GameSession publishes gameplay events through an injected event boundary', () => {
  const published: Array<{ type: string; detail: unknown }> = [];
  const game = new GameSession({
    width: 640,
    height: 480,
    asteroidCount: 0,
    emit: (type, detail) => published.push({ type, detail }),
  });
  getPlayer(game).fire(game.world);
  const fired = published[0];
  assert.ok(fired);
  assert.equal(fired.type, 'fired');
  assert.ok(isBulletDetail(fired.detail));
  assert.equal(fired.detail.bullet.kind, 'bullet');
});

test('Combat events report hit, explosion, and score changes without a DOM dependency', () => {
  const published: Array<{ type: string; detail: unknown }> = [];
  const game = new GameSession({
    width: 640,
    height: 480,
    asteroidCount: 0,
    emit: (type, detail) => published.push({ type, detail }),
  });
  const asteroid = game.world.addAsteroid(80, 80, { hp: 1 });
  const player = getPlayer(game);
  game.world.spawn(
    new Bullet({
      pos: asteroid.pos.clone(),
      ownerId: player.id,
      vel: new Vector2(),
    }),
  );
  game.step(0, idleInput());

  assert.ok(published.some(({ type }) => type === 'hit'));
  assert.ok(published.some(({ type }) => type === 'exploded'));
  assert.ok(
    published.some(
      ({ type, detail }) =>
        type === 'scoreChanged' && isScoreDetail(detail) && detail.score === 100,
    ),
  );
});

test('Pickup collision applies its composed effect and increases score', () => {
  const game = new GameSession({ width: 640, height: 480, asteroidCount: 0 });
  const player = getPlayer(game);
  player.invulnerableTime = 0;
  const pickup = game.world.createPickup(player.pos.x, player.pos.y, 'shield');
  game.world.spawn(pickup);

  const events = game.step(1, idleInput());

  assert.equal(
    events.some((event) => event.type === 'pickup-collected'),
    true,
  );
  assert.equal(getPlayer(game).effects.has('shield'), true);
  assert.equal(game.score, 25);
  assert.equal(game.world.get(pickup.id), undefined);
});

test('Destroyed player respawns after two simulation seconds at a safe position', () => {
  const game = new GameSession({ width: 640, height: 480, asteroidCount: 4 });
  const destroyedShip = getPlayer(game);
  destroyedShip.invulnerableTime = 0;
  for (let index = 0; index < 3; index += 1) {
    game.world.spawn(
      new Bullet({
        pos: destroyedShip.pos.clone(),
        ownerId: new Entity({ kind: 'asteroid' }).id,
        vel: new Vector2(),
      }),
    );
  }

  const events = game.step(0, idleInput());
  assert.equal(
    events.some((event) => event.type === 'ship-destroyed'),
    true,
  );
  assert.equal(game.player, null);
  assert.equal(game.respawnRemaining, 2);
  assert.ok([...game.world.ofKind('explosion')].length > 0);

  game.step(1, idleInput());
  assert.equal(game.player, null);
  assert.equal(game.respawnRemaining, 1);
  game.step(1, idleInput());
  const respawnedPlayer = getPlayer(game);
  assert.notEqual(respawnedPlayer.id, destroyedShip.id);
  assert.equal(respawnedPlayer.hp, respawnedPlayer.maxHp);
  assert.equal(respawnedPlayer.invulnerableTime, 1.5);
  assert.ok([...game.world.ofKind('explosion')].length === 0);
  for (const asteroid of game.world.ofKind('asteroid')) {
    const minimumSafeDistance = asteroid.radius + respawnedPlayer.radius + 48;
    assert.ok(asteroid.pos.sub(respawnedPlayer.pos).length() >= minimumSafeDistance);
  }
});

test('GameSession seeds asteroid placement and velocities reproducibly', () => {
  const first = new GameSession({ width: 640, height: 480, seed: 33, asteroidCount: 4 });
  const second = new GameSession({ width: 640, height: 480, seed: 33, asteroidCount: 4 });
  const snapshot = (game: GameSession) =>
    [...game.world.ofKind('asteroid')].map((asteroid) => [
      asteroid.pos.x,
      asteroid.pos.y,
      asteroid.vel.x,
      asteroid.vel.y,
      Boolean(asteroid.homing),
    ]);

  assert.deepEqual(snapshot(first), snapshot(second));
});
