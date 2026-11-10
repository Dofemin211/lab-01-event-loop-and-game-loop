import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { EntityId } from '@dogfight/shared/sim';
import type { Match } from './match.ts';
import type { MatchSnapshot } from './match.ts';
import type { MatchLog } from './log/matchlog.ts';

const ROOM_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface RoomPlayer {
  readonly id: string;
  readonly name: string;
  entityId?: EntityId;
}

export interface ArenaConfig {
  readonly asteroidCount: number;
  readonly seed: number;
}

export interface RoomConfig {
  readonly id?: string;
  readonly name: string;
  readonly maxPlayers?: number;
  readonly arena: ArenaConfig;
}

export interface RoomJson {
  readonly id: string;
  readonly name: string;
  readonly players: number;
  readonly maxPlayers: number;
  readonly arena: ArenaConfig;
}

export interface ChatRecord {
  readonly id: string;
  readonly playerId: string;
  readonly name: string;
  readonly text: string;
  readonly timestamp: number;
}

type RoomRecord =
  | {
      readonly t: number;
      readonly type: 'join' | 'leave';
      readonly room: string;
      readonly id: string;
      readonly name: string;
    }
  | {
      readonly t: number;
      readonly type: 'chat';
      readonly room: string;
      readonly message: ChatRecord;
    };

interface RoomEvents {
  join: [player: RoomPlayer];
  leave: [player: RoomPlayer];
  empty: [room: Room];
  chat: [message: ChatRecord];
  event: [event: RoomRecord];
  snapshot: [snapshot: MatchSnapshot];
  error: [error: Error];
}

interface RoomManagerEvents {
  roomCreated: [room: Room];
  roomRemoved: [room: Room];
  error: [error: Error];
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code < 0x20 || code === 0x7f);
  });
}

function validateRoom({ id, name, maxPlayers, arena }: RoomConfig): void {
  if (id !== undefined && !ROOM_ID_PATTERN.test(id)) {
    throw new TypeError('Room id must use lowercase letters, digits, or hyphens.');
  }
  if (
    typeof name !== 'string' ||
    name.trim().length < 1 ||
    name.trim().length > 48 ||
    hasControlCharacters(name)
  ) {
    throw new TypeError('Room name must contain 1–48 printable characters.');
  }
  if (
    maxPlayers !== undefined &&
    (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > 64)
  ) {
    throw new TypeError('Room player limit must be an integer between 1 and 64.');
  }
  if (
    !Number.isInteger(arena.asteroidCount) ||
    arena.asteroidCount < 0 ||
    arena.asteroidCount > 100 ||
    !Number.isInteger(arena.seed)
  ) {
    throw new TypeError('Room arena must include a valid asteroid count and seed.');
  }
}

export class Room extends EventEmitter<RoomEvents> {
  readonly id: string;
  readonly name: string;
  readonly maxPlayers: number;
  readonly arena: ArenaConfig;
  readonly players = new Map<string, RoomPlayer>();
  match: Match | undefined;
  matchLog?: MatchLog;
  replayId?: string;
  closed = false;

  constructor({ id = `room-${randomUUID()}`, name, maxPlayers = 8, arena }: RoomConfig) {
    super();
    validateRoom({ id, name, maxPlayers, arena });
    this.id = id;
    this.name = name.trim();
    this.maxPlayers = maxPlayers;
    this.arena = { asteroidCount: arena.asteroidCount, seed: arena.seed };
    this.on('error', (error) => {
      console.error(`Room ${this.id} error:`, error.message);
    });
  }

  join(player: RoomPlayer): RoomPlayer {
    if (this.closed) {
      throw new Error('This room is no longer available.');
    }
    if (this.players.size >= this.maxPlayers) {
      throw new RangeError('This room is full.');
    }
    if (
      typeof player.id !== 'string' ||
      typeof player.name !== 'string' ||
      player.name.trim().length < 1 ||
      player.name.trim().length > 24 ||
      hasControlCharacters(player.name)
    ) {
      throw new TypeError('Player data is invalid.');
    }
    if (this.players.has(player.id)) {
      throw new Error('This player already joined the room.');
    }
    const safePlayer: RoomPlayer = { id: player.id, name: player.name.trim() };
    this.players.set(safePlayer.id, safePlayer);
    this.emit('join', safePlayer);
    this.#record({
      t: Date.now(),
      type: 'join',
      room: this.id,
      id: safePlayer.id,
      name: safePlayer.name,
    });
    return safePlayer;
  }

  leave(playerId: string): boolean {
    const player = this.players.get(playerId);
    if (!player) {
      return false;
    }
    this.players.delete(playerId);
    this.emit('leave', player);
    this.#record({
      t: Date.now(),
      type: 'leave',
      room: this.id,
      id: player.id,
      name: player.name,
    });
    if (this.players.size === 0) {
      this.emit('empty', this);
    }
    return true;
  }

  chat(playerId: string, text: string): ChatRecord {
    const player = this.players.get(playerId);
    if (!player) {
      throw new Error('Join the room before sending chat.');
    }
    if (
      typeof text !== 'string' ||
      text.length < 1 ||
      text.length > 500 ||
      hasControlCharacters(text)
    ) {
      throw new TypeError('Chat text must contain 1–500 characters.');
    }
    const message: ChatRecord = {
      id: randomUUID(),
      playerId,
      name: player.name,
      text,
      timestamp: Date.now(),
    };
    this.emit('chat', message);
    this.#record({ t: Date.now(), type: 'chat', room: this.id, message });
    return message;
  }

  roster(): RoomPlayer[] {
    return [...this.players.values()].map(({ id, name, entityId }) => ({
      id,
      name,
      ...(entityId === undefined ? {} : { entityId }),
    }));
  }

  toJSON(): RoomJson {
    return {
      id: this.id,
      name: this.name,
      players: this.players.size,
      maxPlayers: this.maxPlayers,
      arena: { ...this.arena },
    };
  }

  close(): void {
    this.closed = true;
  }

  #record(event: RoomRecord): void {
    this.emit('event', event);
  }
}

export interface RoomManagerOptions {
  readonly maxRooms?: number;
  readonly maxPlayersPerRoom?: number;
  readonly initialRooms?: readonly RoomConfig[];
}

export class RoomManager extends EventEmitter<RoomManagerEvents> {
  readonly maxRooms: number;
  readonly maxPlayersPerRoom: number;
  readonly rooms = new Map<string, Room>();

  constructor({
    maxRooms = 50,
    maxPlayersPerRoom = 8,
    initialRooms = [],
  }: RoomManagerOptions = {}) {
    super();
    if (!Number.isInteger(maxRooms) || maxRooms < 1) {
      throw new RangeError('maxRooms must be a positive integer.');
    }
    if (!Number.isInteger(maxPlayersPerRoom) || maxPlayersPerRoom < 1) {
      throw new RangeError('maxPlayersPerRoom must be a positive integer.');
    }
    this.maxRooms = maxRooms;
    this.maxPlayersPerRoom = maxPlayersPerRoom;
    this.on('error', (error) => {
      console.error('Room manager error:', error.message);
    });
    for (const room of initialRooms) {
      this.createRoom(room);
    }
  }

  createRoom({ id = `room-${randomUUID()}`, name, maxPlayers, arena }: RoomConfig): Room {
    if (this.rooms.size >= this.maxRooms) {
      throw new RangeError('The server has reached its room limit.');
    }
    if (this.rooms.has(id)) {
      throw new Error(`Room "${id}" already exists.`);
    }
    const roomLimit = maxPlayers ?? this.maxPlayersPerRoom;
    if (roomLimit > this.maxPlayersPerRoom) {
      throw new RangeError(`Room player limit cannot exceed ${this.maxPlayersPerRoom}.`);
    }
    const room = new Room({ id, name, maxPlayers: roomLimit, arena });
    room.once('empty', () => {
      if (this.rooms.get(room.id) === room) {
        this.rooms.delete(room.id);
        room.close();
        this.emit('roomRemoved', room);
      }
    });
    this.rooms.set(room.id, room);
    this.emit('roomCreated', room);
    return room;
  }

  getRoom(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  listRooms(): RoomJson[] {
    return [...this.rooms.values()].map((room) => room.toJSON());
  }

  close(): void {
    for (const room of this.rooms.values()) {
      room.close();
    }
    this.rooms.clear();
  }
}

export function defaultRooms(maxPlayersPerRoom = 8): RoomConfig[] {
  return [
    {
      id: 'training-sector',
      name: 'Training sector',
      maxPlayers: maxPlayersPerRoom,
      arena: { asteroidCount: 4, seed: 2025 },
    },
    {
      id: 'asteroid-belt',
      name: 'Asteroid belt',
      maxPlayers: maxPlayersPerRoom,
      arena: { asteroidCount: 9, seed: 77 },
    },
    {
      id: 'deep-space',
      name: 'Deep space',
      maxPlayers: Math.min(2, maxPlayersPerRoom),
      arena: { asteroidCount: 2, seed: 314 },
    },
  ];
}
