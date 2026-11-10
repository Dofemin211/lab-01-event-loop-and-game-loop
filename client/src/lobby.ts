import { fetchJson } from './assets/loader.ts';

export interface LobbyRoom {
  readonly id: string;
  readonly name: string;
  readonly players: number;
  readonly maxPlayers: number;
  readonly arena: {
    readonly asteroidCount: number;
    readonly seed: number;
  };
}

export interface RoomSelection {
  readonly room: LobbyRoom;
  readonly playerName: string;
}

export interface LobbyOptions {
  readonly url?: string;
  readonly fetchRooms?: (
    url: string,
    options: { readonly signal: AbortSignal },
  ) => Promise<unknown>;
  readonly timeoutMs?: number;
  readonly refreshMs?: number;
  readonly setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timerId: ReturnType<typeof setTimeout>) => void;
}

type LobbyState = 'idle' | 'loading' | 'ready' | 'error' | 'joined';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseRooms(payload: unknown): LobbyRoom[] {
  if (!isRecord(payload) || !Array.isArray(payload.rooms)) {
    throw new TypeError('Room response must contain a rooms array.');
  }
  const ids = new Set<string>();
  const rooms: LobbyRoom[] = [];
  const roomValues: unknown[] = payload.rooms;
  for (const value of roomValues) {
    if (!isRecord(value) || !isRecord(value.arena)) {
      throw new TypeError('A room contains invalid fields or arena configuration.');
    }
    const { id, name, players, maxPlayers } = value;
    const { asteroidCount, seed } = value.arena;
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      typeof name !== 'string' ||
      name.length === 0 ||
      typeof players !== 'number' ||
      !Number.isInteger(players) ||
      typeof maxPlayers !== 'number' ||
      !Number.isInteger(maxPlayers) ||
      players < 0 ||
      maxPlayers < 1 ||
      players > maxPlayers ||
      typeof asteroidCount !== 'number' ||
      !Number.isInteger(asteroidCount) ||
      asteroidCount < 0 ||
      typeof seed !== 'number' ||
      !Number.isInteger(seed)
    ) {
      throw new TypeError('A room contains invalid fields or arena configuration.');
    }
    if (ids.has(id)) {
      throw new TypeError(`The room list contains duplicate id "${id}".`);
    }
    ids.add(id);
    rooms.push({
      id,
      name,
      players,
      maxPlayers,
      arena: { asteroidCount, seed },
    });
  }
  return rooms;
}

export class Lobby extends EventTarget {
  readonly url: string;
  readonly fetchRooms: NonNullable<LobbyOptions['fetchRooms']>;
  readonly timeoutMs: number;
  readonly refreshMs: number;
  readonly setTimer: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer: (timerId: ReturnType<typeof setTimeout>) => void;
  #rooms: LobbyRoom[] = [];
  #selectedRoom: LobbyRoom | null = null;
  #requestController: AbortController | null = null;
  #pollTimer: ReturnType<typeof setTimeout> | null = null;
  #generation = 0;
  #active = false;
  state: LobbyState = 'idle';
  error: unknown = null;
  playerName = 'Pilot';

  constructor({
    url = '/api/rooms',
    fetchRooms = fetchJson,
    timeoutMs = 3000,
    refreshMs = 5000,
    setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimer = (timerId) => globalThis.clearTimeout(timerId),
  }: LobbyOptions = {}) {
    super();
    this.url = url;
    this.fetchRooms = fetchRooms;
    this.timeoutMs = timeoutMs;
    this.refreshMs = refreshMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
  }

  get rooms(): LobbyRoom[] {
    return this.#rooms.map((room) => ({ ...room, arena: { ...room.arena } }));
  }

  get selectedRoom(): LobbyRoom | null {
    return this.#selectedRoom
      ? { ...this.#selectedRoom, arena: { ...this.#selectedRoom.arena } }
      : null;
  }

  setPlayerName(name: string): void {
    const normalized = name.trim();
    if (!normalized || normalized.length > 24) {
      throw new RangeError('Player name must contain 1–24 characters.');
    }
    this.playerName = normalized;
  }

  async refresh(): Promise<LobbyRoom[]> {
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
    } catch (error: unknown) {
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

  #isCurrent(generation: number, controller: AbortController): boolean {
    return generation === this.#generation && !controller.signal.aborted && this.state !== 'joined';
  }

  start(): void {
    if (this.#active) {
      return;
    }
    this.#active = true;
    void this.#poll();
  }

  async #poll(): Promise<void> {
    if (!this.#active) {
      return;
    }
    try {
      await this.refresh();
    } catch {
      // refresh emits lobbyError; periodic polling remains active to recover.
    } finally {
      if (this.#active) {
        this.#pollTimer = this.setTimer(() => void this.#poll(), this.refreshMs);
      }
    }
  }

  stop(): void {
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

  join(roomId: string): RoomSelection {
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
    const detail: RoomSelection = {
      room: { ...room, arena: { ...room.arena } },
      playerName: this.playerName,
    };
    this.dispatchEvent(new CustomEvent('roomJoined', { detail }));
    this.dispatchEvent(new CustomEvent('stateChanged', { detail: { state: this.state } }));
    return detail;
  }
}
