import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { Asteroid, Ship, Vector2, World, createHomingBehavior } from '@dogfight/shared/sim';
import type { EntityId, GameEntity, InputReader } from '@dogfight/shared/sim';
import { inputToKeyboard, validateInputCommand } from '@dogfight/shared/protocol';
import type { SnapshotEntity, SnapshotMessage } from '@dogfight/shared/protocol';
import type { Room, RoomManager, RoomPlayer } from './rooms.ts';

const TICK_RATE = 30;
const STEP = 1 / TICK_RATE;
const INTERVAL_MS = 1000 / TICK_RATE;
const WIDTH = 960;
const HEIGHT = 600;

interface MatchCommand {
  readonly seq: number;
  readonly tick: number;
  readonly turn: -1 | 0 | 1;
  readonly thrust: boolean;
  readonly brake: boolean;
  readonly fire: boolean;
}

const EMPTY_COMMAND: MatchCommand = Object.freeze({
  seq: 0,
  tick: 0,
  turn: 0,
  thrust: false,
  brake: false,
  fire: false,
});

export type MatchSnapshot = Omit<SnapshotMessage, 'version'>;

interface MatchEvents {
  snapshot: [snapshot: MatchSnapshot];
  error: [error: Error];
}

export interface TimerHandle {
  readonly callback?: () => void;
  readonly delay?: number;
  cancelled?: boolean;
  unref?: () => void;
  cancel?: () => void;
}

export interface MatchOptions {
  readonly now?: () => number;
  readonly schedule?: (callback: () => void, delay: number) => TimerHandle;
  readonly cancel?: (timer: TimerHandle) => void;
}

interface MatchPlayerState {
  readonly player: RoomPlayer;
  ship: Ship | null;
  command: MatchCommand;
  readonly queued: MatchCommand[];
  lastQueuedSeq: number;
  lastProcessedSeq: number;
  respawnTicks: number;
  readonly entityId: EntityId;
}

export interface MatchStats {
  readonly roomId: string;
  readonly tickRate: number;
  readonly tick: number;
  readonly players: number;
  readonly lastTickDurationMs: number;
  readonly averageTickDurationMs: number;
  readonly lastJitterMs: number;
  readonly averageJitterMs: number;
  readonly worldEntities: number;
}

export class Match extends EventEmitter<MatchEvents> {
  readonly room: Room;
  readonly now: () => number;
  readonly schedule: (callback: () => void, delay: number) => TimerHandle;
  readonly cancel: (timer: TimerHandle) => void;
  readonly players = new Map<string, MatchPlayerState>();
  readonly world: World;
  readonly durations: number[] = [];
  readonly jitters: number[] = [];
  readonly onPlayerJoin: (player: RoomPlayer) => void;
  readonly onPlayerLeave: (player: RoomPlayer) => void;
  readonly onRoomEmpty: () => void;
  tick = 0;
  running = false;
  timer: TimerHandle | null = null;
  nextTickAt = 0;
  lastTickDurationMs = 0;
  lastJitterMs = 0;

  constructor(
    room: Room,
    {
      now = () => performance.now(),
      schedule = (callback, delay) => {
        const timer = setTimeout(callback, delay);
        return { unref: () => timer.unref(), cancel: () => clearTimeout(timer) };
      },
      cancel = (timer) => timer.cancel?.(),
    }: MatchOptions = {},
  ) {
    super();
    this.room = room;
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;
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

  #populateArena(count: number): void {
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

  #addPlayer(player: RoomPlayer): void {
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

  #removePlayer(player: RoomPlayer): void {
    const state = this.players.get(player.id);
    if (state?.ship) {
      this.world.despawn(state.ship.id);
      this.world.step(0);
    }
    this.players.delete(player.id);
    this.#publishSnapshot();
  }

  enqueueInput(playerId: string, rawCommand: unknown): boolean {
    const player = this.players.get(playerId);
    if (!player) {
      throw new Error('Player is not part of this match.');
    }
    const command = validateInputCommand(rawCommand);
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

  start(): void {
    if (this.running) return;
    this.running = true;
    this.nextTickAt = this.now() + INTERVAL_MS;
    this.#scheduleTick();
  }

  stop(): void {
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

  #scheduleTick(): void {
    if (!this.running) return;
    const delay = Math.max(0, this.nextTickAt - this.now());
    this.timer = this.schedule(() => this.#runTick(), delay);
    this.timer.unref?.();
  }

  #runTick(): void {
    if (!this.running) return;
    const startedAt = this.now();
    this.lastJitterMs = startedAt - this.nextTickAt;
    const inputs = new Map<string, InputReader>();
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

  #publishSnapshot(): void {
    const snapshot: MatchSnapshot = {
      type: 'snapshot',
      tick: this.tick,
      entities: [...this.world].map(createNetworkEntity),
      acks: [...this.players.values()].map(({ ship, lastProcessedSeq }) => ({
        entityId: ship?.id ?? 0,
        seq: lastProcessedSeq,
      })),
    };
    this.room.emit('snapshot', snapshot);
    this.emit('snapshot', snapshot);
  }

  #record(samples: number[], value: number): void {
    samples.push(value);
    if (samples.length > 120) samples.shift();
  }

  stats(): MatchStats {
    const average = (values: readonly number[]): number =>
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

function createNetworkEntity(entity: GameEntity): SnapshotEntity {
  const radius =
    entity.kind === 'explosion'
      ? Math.max(0, ...entity.particles.map((particle) => entity.pos.sub(particle.pos).length()))
      : entity.radius;
  const common = {
    id: entity.id,
    x: entity.pos.x,
    y: entity.pos.y,
    vx: entity.vel.x,
    vy: entity.vel.y,
    angle: entity.angle,
    radius,
    thrust: entity.kind === 'ship' ? entity.thrust : 0,
    hp: entity.kind === 'ship' ? entity.hp : 0,
    shield: entity.kind === 'ship' && entity.effects.has('shield'),
    invulnerableTime: entity.kind === 'ship' ? entity.invulnerableTime : 0,
    ownerId: entity.kind === 'bullet' ? (entity.ownerId ?? 0) : 0,
    commandSeq: entity.kind === 'bullet' ? entity.commandSeq : 0,
    ttl:
      entity.kind === 'explosion'
        ? Math.max(0, ...entity.particles.map((particle) => particle.remaining))
        : entity.kind === 'bullet' || entity.kind === 'pickup'
          ? entity.ttl
          : 0,
    score: entity.kind === 'ship' ? entity.score : 0,
  };
  switch (entity.kind) {
    case 'pickup':
      return { ...common, kind: entity.kind, effect: entity.effect };
    case 'ship':
    case 'asteroid':
    case 'bullet':
    case 'explosion':
      return { ...common, kind: entity.kind };
    default:
      return assertNever(entity);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled entity kind: ${String(value)}`);
}

export class MatchManager {
  readonly matches = new Map<string, Match>();
  readonly options: MatchOptions;
  readonly roomManager: RoomManager;
  readonly onRoomCreated: (room: Room) => void;
  readonly onRoomRemoved: (room: Room) => void;

  constructor(roomManager: RoomManager, options: MatchOptions = {}) {
    this.options = options;
    this.onRoomCreated = (room) => {
      const match = new Match(room, this.options);
      this.matches.set(room.id, match);
      room.match = match;
    };
    this.onRoomRemoved = (room) => {
      this.matches.get(room.id)?.stop();
      this.matches.delete(room.id);
    };
    roomManager.on('roomCreated', this.onRoomCreated);
    roomManager.on('roomRemoved', this.onRoomRemoved);
    this.roomManager = roomManager;
  }

  stats(): MatchStats[] {
    return [...this.matches.values()].map((match) => match.stats());
  }

  close(): void {
    for (const match of this.matches.values()) {
      match.stop();
    }
    this.matches.clear();
    this.roomManager.off('roomCreated', this.onRoomCreated);
    this.roomManager.off('roomRemoved', this.onRoomRemoved);
  }
}
