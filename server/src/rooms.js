import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

const ROOM_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CONTROL_CHARACTERS = (value) =>
  [...value].some((character) => {
    const code = character.codePointAt(0);
    return code < 0x20 || code === 0x7f;
  });

function validateRoom({ id, name, maxPlayers, arena }) {
  if (id !== undefined && (typeof id !== 'string' || !ROOM_ID_PATTERN.test(id))) {
    throw new TypeError('Room id must use lowercase letters, digits, or hyphens.');
  }
  if (
    typeof name !== 'string' ||
    name.trim().length < 1 ||
    name.trim().length > 48 ||
    CONTROL_CHARACTERS(name)
  ) {
    throw new TypeError('Room name must contain 1–48 printable characters.');
  }
  if (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > 64) {
    throw new TypeError('Room player limit must be an integer between 1 and 64.');
  }
  if (
    !arena ||
    !Number.isInteger(arena.asteroidCount) ||
    arena.asteroidCount < 0 ||
    arena.asteroidCount > 100 ||
    !Number.isInteger(arena.seed)
  ) {
    throw new TypeError('Room arena must include a valid asteroid count and seed.');
  }
}

export class Room extends EventEmitter {
  constructor({ id, name, maxPlayers, arena }) {
    super();
    validateRoom({ id, name, maxPlayers, arena });
    this.id = id;
    this.name = name.trim();
    this.maxPlayers = maxPlayers;
    this.arena = { asteroidCount: arena.asteroidCount, seed: arena.seed };
    this.players = new Map();
    this.closed = false;
    this.on('error', (error) => {
      console.error(`Room ${this.id} error:`, error.message);
    });
  }

  join(player) {
    if (this.closed) {
      throw new Error('This room is no longer available.');
    }
    if (this.players.size >= this.maxPlayers) {
      throw new RangeError('This room is full.');
    }
    if (
      !player ||
      typeof player.id !== 'string' ||
      typeof player.name !== 'string' ||
      player.name.trim().length < 1 ||
      player.name.trim().length > 24
    ) {
      throw new TypeError('Player data is invalid.');
    }
    if (this.players.has(player.id)) {
      throw new Error('This player already joined the room.');
    }
    const safePlayer = { id: player.id, name: player.name.trim() };
    this.players.set(safePlayer.id, safePlayer);
    this.emit('join', safePlayer);
    this.#record('join', safePlayer);
    return safePlayer;
  }

  leave(playerId) {
    const player = this.players.get(playerId);
    if (!player) {
      return false;
    }
    this.players.delete(playerId);
    this.emit('leave', player);
    this.#record('leave', player);
    if (this.players.size === 0) {
      this.emit('empty', this);
    }
    return true;
  }

  chat(playerId, text) {
    const player = this.players.get(playerId);
    if (!player) {
      throw new Error('Join the room before sending chat.');
    }
    if (typeof text !== 'string' || text.length < 1 || text.length > 500) {
      throw new TypeError('Chat text must contain 1–500 characters.');
    }
    const message = {
      id: randomUUID(),
      playerId,
      name: player.name,
      text,
      timestamp: Date.now(),
    };
    this.emit('chat', message);
    this.#record('chat', message);
    return message;
  }

  roster() {
    return [...this.players.values()].map(({ id, name, entityId }) => ({
      id,
      name,
      ...(entityId ? { entityId } : {}),
    }));
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      players: this.players.size,
      maxPlayers: this.maxPlayers,
      arena: { ...this.arena },
    };
  }

  close() {
    this.closed = true;
  }

  #record(type, data) {
    this.emit('event', { t: Date.now(), type, room: this.id, ...data });
  }
}

export class RoomManager extends EventEmitter {
  constructor({ maxRooms = 50, maxPlayersPerRoom = 8, initialRooms = [] } = {}) {
    super();
    if (!Number.isInteger(maxRooms) || maxRooms < 1) {
      throw new RangeError('maxRooms must be a positive integer.');
    }
    if (!Number.isInteger(maxPlayersPerRoom) || maxPlayersPerRoom < 1) {
      throw new RangeError('maxPlayersPerRoom must be a positive integer.');
    }
    this.maxRooms = maxRooms;
    this.maxPlayersPerRoom = maxPlayersPerRoom;
    this.rooms = new Map();
    this.on('error', (error) => {
      console.error('Room manager error:', error.message);
    });
    for (const room of initialRooms) {
      this.createRoom(room);
    }
  }

  createRoom({ id = `room-${randomUUID()}`, name, maxPlayers, arena }) {
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
    const room = new Room({
      id,
      name,
      maxPlayers: roomLimit,
      arena,
    });
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

  getRoom(id) {
    return this.rooms.get(id);
  }

  listRooms() {
    return [...this.rooms.values()].map((room) => room.toJSON());
  }

  close() {
    for (const room of this.rooms.values()) {
      room.close();
    }
    this.rooms.clear();
  }
}

export function defaultRooms(maxPlayersPerRoom = 8) {
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
