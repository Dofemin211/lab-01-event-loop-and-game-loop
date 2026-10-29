import { fetchJson } from './assets/loader.js';

export function parseRooms(payload) {
  if (!payload || !Array.isArray(payload.rooms)) {
    throw new TypeError('Room response must contain a rooms array.');
  }
  const ids = new Set();
  return payload.rooms.map((room) => {
    if (
      !room ||
      typeof room.id !== 'string' ||
      room.id.length === 0 ||
      typeof room.name !== 'string' ||
      room.name.length === 0 ||
      !Number.isInteger(room.players) ||
      !Number.isInteger(room.maxPlayers) ||
      room.players < 0 ||
      room.maxPlayers < 1 ||
      room.players > room.maxPlayers ||
      !room.arena ||
      !Number.isInteger(room.arena.asteroidCount) ||
      room.arena.asteroidCount < 0
    ) {
      throw new TypeError('A room contains invalid fields or arena configuration.');
    }
    if (ids.has(room.id)) {
      throw new TypeError(`The room list contains duplicate id "${room.id}".`);
    }
    ids.add(room.id);
    return {
      id: room.id,
      name: room.name,
      players: room.players,
      maxPlayers: room.maxPlayers,
      arena: { ...room.arena },
    };
  });
}

export class Lobby extends EventTarget {
  #rooms = [];
  #selectedRoom = null;
  #requestController = null;
  #pollTimer = null;
  #generation = 0;
  #active = false;

  constructor({
    url = '/api/rooms',
    fetchRooms = fetchJson,
    timeoutMs = 3000,
    refreshMs = 5000,
    setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimer = (timerId) => globalThis.clearTimeout(timerId),
  } = {}) {
    super();
    this.url = url;
    this.fetchRooms = fetchRooms;
    this.timeoutMs = timeoutMs;
    this.refreshMs = refreshMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.state = 'idle';
    this.error = null;
    this.playerName = 'Pilot';
  }

  get rooms() {
    return this.#rooms.map((room) => ({ ...room, arena: { ...room.arena } }));
  }

  get selectedRoom() {
    return this.#selectedRoom ? { ...this.#selectedRoom } : null;
  }

  setPlayerName(name) {
    const normalized = name.trim();
    if (!normalized || normalized.length > 24) {
      throw new RangeError('Player name must contain 1–24 characters.');
    }
    this.playerName = normalized;
  }

  async refresh() {
    const generation = ++this.#generation;
    this.#requestController?.abort();
    const controller = new AbortController();
    this.#requestController = controller;
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = AbortSignal.any([controller.signal, timeoutSignal]);
    this.state = 'loading';
    this.error = null;
    this.dispatchEvent(new CustomEvent('stateChanged', { detail: { state: this.state } }));

    try {
      const payload = await this.fetchRooms(this.url, { signal });
      const rooms = parseRooms(payload);
      if (signal.aborted) {
        throw signal.reason;
      }
      if (!this.#isCurrent(generation, controller)) {
        return this.rooms;
      }
      this.#rooms = rooms;
      this.state = 'ready';
      this.dispatchEvent(new CustomEvent('roomsChanged', { detail: { rooms: this.rooms } }));
      this.dispatchEvent(new CustomEvent('stateChanged', { detail: { state: this.state } }));
      return this.rooms;
    } catch (error) {
      if (!this.#isCurrent(generation, controller)) {
        return this.rooms;
      }
      this.state = 'error';
      this.error = error;
      this.dispatchEvent(new CustomEvent('lobbyError', { detail: { error } }));
      this.dispatchEvent(new CustomEvent('stateChanged', { detail: { state: this.state, error } }));
      throw error;
    } finally {
      if (this.#requestController === controller) {
        this.#requestController = null;
      }
    }
  }

  #isCurrent(generation, controller) {
    return generation === this.#generation && !controller.signal.aborted && this.state !== 'joined';
  }

  start() {
    if (this.#active) {
      return;
    }
    this.#active = true;
    void this.#poll();
  }

  async #poll() {
    if (!this.#active) {
      return;
    }
    try {
      await this.refresh();
    } catch {
      // The lobbyError event reports this poll failure; the next scheduled poll can recover.
    } finally {
      if (this.#active) {
        this.#pollTimer = this.setTimer(() => void this.#poll(), this.refreshMs);
      }
    }
  }

  stop() {
    this.#active = false;
    this.#generation += 1;
    if (this.#pollTimer !== null) {
      this.clearTimer(this.#pollTimer);
      this.#pollTimer = null;
    }
    this.#requestController?.abort();
    this.#requestController = null;
    if (this.state !== 'joined') {
      this.state = 'idle';
    }
  }

  join(roomId) {
    const room = this.#rooms.find((candidate) => candidate.id === roomId);
    if (!room) {
      throw new RangeError(`Room "${roomId}" is not available. Refresh the lobby and try again.`);
    }
    if (room.players >= room.maxPlayers) {
      throw new RangeError(`Room "${room.name}" is full.`);
    }
    this.stop();
    this.#selectedRoom = { ...room, arena: { ...room.arena } };
    this.state = 'joined';
    const detail = { room: this.selectedRoom, playerName: this.playerName };
    this.dispatchEvent(new CustomEvent('roomJoined', { detail }));
    this.dispatchEvent(new CustomEvent('stateChanged', { detail: { state: this.state } }));
    return detail;
  }
}
