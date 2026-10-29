import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { Asteroid, Ship, Vector2, World, createHomingBehavior } from '@dogfight/shared/sim';
import { inputToKeyboard, validateInputCommand } from '@dogfight/shared/protocol';

const TICK_RATE = 30;
const STEP = 1 / TICK_RATE;
const INTERVAL_MS = 1000 / TICK_RATE;
const WIDTH = 960;
const HEIGHT = 600;
const EMPTY_COMMAND = Object.freeze({
  seq: 0,
  tick: 0,
  turn: 0,
  thrust: false,
  brake: false,
  fire: false,
});

export class Match extends EventEmitter {
  constructor(
    room,
    { now = () => performance.now(), schedule = setTimeout, cancel = clearTimeout } = {},
  ) {
    super();
    this.room = room;
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;
    this.tick = 0;
    this.running = false;
    this.timer = null;
    this.nextTickAt = 0;
    this.lastTickDurationMs = 0;
    this.lastJitterMs = 0;
    this.durations = [];
    this.jitters = [];
    this.players = new Map();
    this.world = new World({ width: WIDTH, height: HEIGHT, seed: room.arena.seed });
    this.#populateArena(room.arena.asteroidCount);
    this.world.spawn(this.world.createPickup(WIDTH * 0.2, HEIGHT * 0.25, 'shield'));
    this.world.spawn(this.world.createPickup(WIDTH * 0.8, HEIGHT * 0.75, 'rapid-fire'));

    this.onPlayerJoin = (player) => this.#addPlayer(player);
    this.onPlayerLeave = (player) => this.#removePlayer(player);
    this.onRoomEmpty = () => this.stop();
    room.on('join', this.onPlayerJoin);
    room.on('leave', this.onPlayerLeave);
    room.once('empty', this.onRoomEmpty);
  }

  #populateArena(count) {
    for (let index = 0; index < count; index += 1) {
      const position = this.world.safePosition(32, 'ship');
      const angle = this.world.random() * Math.PI * 2;
      const speed = 18 + this.world.random() * 35;
      const homing =
        index === 0
          ? createHomingBehavior({ targetKind: 'ship', turnRate: 0.35, maxSpeed: 45 })
          : null;
      this.world.spawn(
        new Asteroid(position.x, position.y, {
          radius: 20 + this.world.random() * 16,
          hp: 2,
          vel: Vector2.fromAngle(angle, speed),
          homing,
        }),
      );
    }
  }

  #addPlayer(player) {
    const position = this.world.safePosition(13);
    const ship = this.world.spawn(
      new Ship(position.x, position.y, { playerId: player.id, invulnerableTime: 1.5 }),
    );
    player.entityId = ship.id;
    this.players.set(player.id, {
      player,
      ship,
      command: EMPTY_COMMAND,
      queued: [],
      lastQueuedSeq: 0,
      lastProcessedSeq: 0,
      respawnTicks: 0,
      entityId: ship.id,
    });
    this.start();
  }

  #removePlayer(player) {
    const state = this.players.get(player.id);
    if (state?.ship) {
      this.world.despawn(state.ship.id);
      this.world.step(0);
    }
    this.players.delete(player.id);
    this.#publishSnapshot();
  }

  enqueueInput(playerId, rawCommand) {
    const player = this.players.get(playerId);
    if (!player) {
      throw new Error('Player is not part of this match.');
    }
    const command = validateInputCommand({
      seq: rawCommand.seq,
      tick: rawCommand.tick,
      turn: rawCommand.turn,
      thrust: rawCommand.thrust,
      brake: rawCommand.brake,
      fire: rawCommand.fire,
    });
    if (command.seq <= player.lastQueuedSeq || command.seq - player.lastQueuedSeq > 256) {
      throw new RangeError('Input sequence must increase by no more than 256.');
    }
    if (player.queued.length >= 120) {
      throw new RangeError('Input queue is full.');
    }
    player.lastQueuedSeq = command.seq;
    player.queued.push(command);
    return true;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.nextTickAt = this.now() + INTERVAL_MS;
    this.#scheduleTick();
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.timer !== null) {
      this.cancel(this.timer);
      this.timer = null;
    }
    this.room.off('join', this.onPlayerJoin);
    this.room.off('leave', this.onPlayerLeave);
    this.room.off('empty', this.onRoomEmpty);
  }

  #scheduleTick() {
    if (!this.running) return;
    const delay = Math.max(0, this.nextTickAt - this.now());
    this.timer = this.schedule(() => this.#runTick(), delay);
    this.timer?.unref?.();
  }

  #runTick() {
    if (!this.running) return;
    const startedAt = this.now();
    this.lastJitterMs = startedAt - this.nextTickAt;
    const inputs = new Map();
    for (const [playerId, state] of this.players) {
      if (state.queued.length > 0) {
        for (const command of state.queued) {
          state.command = command;
          state.lastProcessedSeq = command.seq;
          if (command.fire && state.ship?.alive) {
            state.ship.fire(this.world, command.seq);
          }
        }
        state.queued.length = 0;
      }
      if (state.ship?.alive) {
        inputs.set(playerId, inputToKeyboard(state.command));
        if (state.command.fire) {
          state.ship.fire(this.world, state.command.seq);
        }
      }
    }

    const events = this.world.step(STEP, inputs);
    for (const event of events) {
      if (event.type === 'ship-destroyed') {
        const state = [...this.players.values()].find(
          (entry) => entry.ship?.id === event.entity.id,
        );
        if (state) {
          state.ship = null;
          state.respawnTicks = TICK_RATE * 2;
        }
      }
    }
    for (const [playerId, state] of this.players) {
      if (!state.ship) {
        state.respawnTicks -= 1;
        if (state.respawnTicks <= 0) {
          const position = this.world.safePosition(13);
          state.ship = this.world.spawn(
            new Ship(position.x, position.y, {
              playerId,
              id: state.entityId,
              invulnerableTime: 1.5,
            }),
          );
          state.player.entityId = state.entityId;
          state.command = EMPTY_COMMAND;
        }
      }
    }
    this.tick += 1;
    this.#publishSnapshot();
    const finishedAt = this.now();
    this.lastTickDurationMs = Math.max(0, finishedAt - startedAt);
    this.#record(this.durations, this.lastTickDurationMs);
    this.#record(this.jitters, Math.abs(this.lastJitterMs));

    this.nextTickAt += INTERVAL_MS;
    while (this.nextTickAt <= finishedAt) {
      this.nextTickAt += INTERVAL_MS;
    }
    this.#scheduleTick();
  }

  #publishSnapshot() {
    const entities = [...this.world].map((entity) => ({
      id: entity.id,
      kind: entity.kind,
      x: entity.pos.x,
      y: entity.pos.y,
      vx: entity.vel.x,
      vy: entity.vel.y,
      angle: entity.angle,
      radius:
        entity.kind === 'explosion'
          ? Math.max(
              0,
              ...entity.particles.map((particle) => entity.pos.sub(particle.pos).length()),
            )
          : entity.radius,
      thrust: entity.thrust ?? 0,
      hp: entity.kind === 'ship' ? entity.hp : 0,
      shield: entity.kind === 'ship' && entity.effects.has('shield'),
      ...(entity.kind === 'pickup' ? { effect: entity.effect } : {}),
      invulnerableTime: entity.invulnerableTime ?? 0,
      ownerId: entity.kind === 'bullet' ? entity.ownerId : 0,
      commandSeq: entity.kind === 'bullet' ? entity.commandSeq : 0,
      ttl:
        entity.kind === 'explosion'
          ? Math.max(0, ...entity.particles.map((particle) => particle.remaining))
          : (entity.ttl ?? 0),
      score: entity.score ?? 0,
    }));
    const snapshot = {
      type: 'snapshot',
      tick: this.tick,
      entities,
      acks: [...this.players.values()].map(({ ship, lastProcessedSeq }) => ({
        entityId: ship?.id ?? 0,
        seq: lastProcessedSeq,
      })),
    };
    this.room.emit('snapshot', snapshot);
    this.emit('snapshot', snapshot);
  }

  #record(samples, value) {
    samples.push(value);
    if (samples.length > 120) samples.shift();
  }

  stats() {
    const average = (values) =>
      values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
    return {
      roomId: this.room.id,
      tickRate: TICK_RATE,
      tick: this.tick,
      players: this.players.size,
      lastTickDurationMs: this.lastTickDurationMs,
      averageTickDurationMs: average(this.durations),
      lastJitterMs: this.lastJitterMs,
      averageJitterMs: average(this.jitters),
      worldEntities: this.world.size,
    };
  }
}

export class MatchManager {
  constructor(roomManager, options = {}) {
    this.matches = new Map();
    this.options = options;
    this.onRoomCreated = (room) => {
      this.matches.set(room.id, new Match(room, this.options));
      room.match = this.matches.get(room.id);
    };
    this.onRoomRemoved = (room) => {
      this.matches.get(room.id)?.stop();
      this.matches.delete(room.id);
    };
    roomManager.on('roomCreated', this.onRoomCreated);
    roomManager.on('roomRemoved', this.onRoomRemoved);
    this.roomManager = roomManager;
  }

  stats() {
    const matches = [...this.matches.values()].map((match) => match.stats());
    const tickDurations = matches.map(({ averageTickDurationMs }) => averageTickDurationMs);
    return {
      tickRate: TICK_RATE,
      activeMatches: matches.filter(({ players }) => players > 0).length,
      activePlayers: matches.reduce((sum, match) => sum + match.players, 0),
      averageTickDurationMs: tickDurations.length
        ? tickDurations.reduce((sum, value) => sum + value, 0) / tickDurations.length
        : 0,
      matches,
    };
  }

  close() {
    this.roomManager.off('roomCreated', this.onRoomCreated);
    this.roomManager.off('roomRemoved', this.onRoomRemoved);
    for (const match of this.matches.values()) match.stop();
    this.matches.clear();
  }
}
