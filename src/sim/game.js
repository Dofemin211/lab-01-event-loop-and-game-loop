import { Asteroid } from './asteroid.js';
import { createHomingBehavior } from './homing.js';
import { Ship } from './ship.js';
import { Vector2 } from './vector.js';
import { World } from './world.js';

export class GameSession {
  constructor({ width = 800, height = 600, seed = 2025, asteroidCount = 6 } = {}) {
    this.world = new World({ width, height, seed });
    this.score = 0;
    this.respawnRemaining = 0;
    this.player = this.world.spawn(new Ship(width / 2, height / 2));
    this.#populateAsteroids(asteroidCount);
    this.world.spawn(this.world.createPickup(width * 0.2, height * 0.25, 'shield'));
    this.world.spawn(this.world.createPickup(width * 0.8, height * 0.75, 'rapid-fire'));
  }

  #populateAsteroids(count) {
    for (let index = 0; index < count; index += 1) {
      const pos = this.world.safePosition(32, 'ship');
      const angle = this.world.random() * Math.PI * 2;
      const speed = 18 + this.world.random() * 35;
      const homing =
        index === 0
          ? createHomingBehavior({ targetKind: 'ship', turnRate: 0.35, maxSpeed: 45 })
          : null;
      this.world.spawn(
        new Asteroid(pos.x, pos.y, {
          radius: 20 + this.world.random() * 16,
          hp: 2,
          vel: Vector2.fromAngle(angle, speed),
          homing,
        }),
      );
    }
  }

  step(dt, input) {
    const playerWasAbsent = this.player === null;
    if (this.player?.alive && input.isDown('KeyF')) {
      this.player.fire(this.world);
    }

    const events = this.world.step(dt, input);
    for (const event of events) {
      if (event.type === 'asteroid-destroyed') {
        this.score += 100;
      } else if (event.type === 'pickup-collected') {
        this.score += 25;
      } else if (event.type === 'ship-destroyed' && event.entity.id === this.player?.id) {
        this.player = null;
        this.respawnRemaining = 2;
      }
    }

    if (!this.player) {
      if (playerWasAbsent) {
        this.respawnRemaining = Math.max(0, this.respawnRemaining - dt);
      }
      if (this.respawnRemaining === 0) {
        const spawnPoint = this.world.safePosition(13);
        this.player = this.world.spawn(
          new Ship(spawnPoint.x, spawnPoint.y, { invulnerableTime: 1.5 }),
        );
      }
    }

    return events;
  }

  resize(width, height) {
    this.world.resize(width, height);
  }
}

export function createGame(options) {
  return new GameSession(options);
}
