import { decodeBinary, encodeBinary, encodeJson } from '@dogfight/shared/codec';
import { parseServerMessage, serverMessageSchema } from '@dogfight/shared/protocol';
import type { ClientMessage, ServerMessage } from '@dogfight/shared/protocol';
import type { NetworkEmulator } from './network-emulator.ts';
import { measureStage } from './performance.ts';

const PROTOCOL_VERSION = 0;
type ConnectionState = 'disconnected' | 'connecting' | 'open' | 'joined' | 'reconnecting';
type CodecName = 'binary' | 'json';
type TrafficDirection = 'inbound' | 'outbound';
type WebSocketLike = Pick<
  WebSocket,
  'addEventListener' | 'binaryType' | 'close' | 'readyState' | 'send'
>;
type WebSocketConstructor = new (url: string) => WebSocketLike;

interface TrafficSample {
  readonly at: number;
  inbound: number;
  outbound: number;
}

export interface ConnectionOptions {
  readonly url?: string;
  readonly WebSocketClass?: WebSocketConstructor;
  readonly random?: () => number;
  readonly setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly maxQueue?: number;
  readonly networkEmulator?: NetworkEmulator | null;
}

function emit(target: EventTarget, type: string, detail: unknown = {}): void {
  target.dispatchEvent(new CustomEvent(type, { detail }));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class MultiplayerConnection extends EventTarget {
  readonly url: string;
  readonly WebSocketClass: WebSocketConstructor;
  readonly random: () => number;
  readonly setTimer: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly maxQueue: number;
  networkEmulator: NetworkEmulator | null;
  trafficSamples: TrafficSample[] = [];
  rttMs: number | null = null;
  state: ConnectionState = 'disconnected';
  socket: WebSocketLike | null = null;
  room: string | null = null;
  codec: CodecName = 'binary';
  joinMessage: ClientMessage | null = null;
  queue: ClientMessage[] = [];
  retryCount = 0;
  reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  wanted = false;
  joined = false;

  constructor({
    url = `${globalThis.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${globalThis.location.host}/ws`,
    WebSocketClass = globalThis.WebSocket,
    random = Math.random,
    setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimer = (timer) => globalThis.clearTimeout(timer),
    baseDelayMs = 250,
    maxDelayMs = 8000,
    maxQueue = 50,
    networkEmulator = null,
  }: ConnectionOptions = {}) {
    super();
    this.url = url;
    this.WebSocketClass = WebSocketClass;
    this.random = random;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.maxQueue = maxQueue;
    this.networkEmulator = networkEmulator;
  }

  connect(
    room: string,
    name: string,
    { codec = 'binary' }: { readonly codec?: CodecName } = {},
  ): void {
    if (typeof room !== 'string' || typeof name !== 'string' || !name.trim()) {
      throw new TypeError('A room and player name are required to connect.');
    }
    this.disconnect();
    this.room = room;
    this.codec = codec;
    this.joinMessage = {
      version: PROTOCOL_VERSION,
      type: 'join',
      room,
      name: name.trim(),
      codec,
    };
    this.wanted = true;
    this.#open();
  }

  sendChat(text: string): boolean {
    const trimmed = text.trim();
    if (typeof text !== 'string' || !trimmed || trimmed.length > 500) {
      throw new RangeError('Chat text must contain 1–500 characters.');
    }
    const message: ClientMessage = { version: PROTOCOL_VERSION, type: 'chat', text: trimmed };
    if (this.joined && this.socket?.readyState === WebSocket.OPEN) {
      return this.#send(message);
    }
    if (!this.wanted) {
      return false;
    }
    if (this.queue.length >= this.maxQueue) {
      emit(this, 'error', { message: 'Your message queue is full. Try again after reconnecting.' });
      return false;
    }
    this.queue.push(message);
    return true;
  }

  sendInput(command: {
    readonly seq: number;
    readonly tick: number;
    readonly turn: -1 | 0 | 1;
    readonly thrust: boolean;
    readonly brake: boolean;
    readonly fire: boolean;
  }): boolean {
    if (!this.joined || !this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    if (this.codec === 'binary') {
      return this.#send(encodeBinary({ type: 'input', ...command }), true);
    }
    return this.#send({ version: PROTOCOL_VERSION, type: 'input', ...command });
  }

  sendPing(): boolean {
    if (!this.joined || !this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    const sentAt = performance.now();
    const message =
      this.codec === 'binary'
        ? encodeBinary({ type: 'ping', sentAt })
        : { version: PROTOCOL_VERSION, type: 'ping', sentAt };
    return this.#send(message, this.codec === 'binary');
  }

  setNetworkEmulator(emulator: NetworkEmulator | null): void {
    this.networkEmulator = emulator;
  }

  traffic(now = performance.now()): {
    inboundKilobytesPerSecond: number;
    outboundKilobytesPerSecond: number;
  } {
    this.trafficSamples = this.trafficSamples.filter((sample) => now - sample.at <= 1000);
    const bytesIn = this.trafficSamples.reduce((sum, sample) => sum + sample.inbound, 0);
    const bytesOut = this.trafficSamples.reduce((sum, sample) => sum + sample.outbound, 0);
    return {
      inboundKilobytesPerSecond: bytesIn / 1024,
      outboundKilobytesPerSecond: bytesOut / 1024,
    };
  }

  disconnect(): void {
    this.wanted = false;
    this.joined = false;
    this.queue = [];
    if (this.reconnectTimer !== null) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close(1000, 'Client left the room.');
    }
    this.#setState('disconnected');
  }

  #open(): void {
    if (!this.wanted) {
      return;
    }
    this.#setState(this.retryCount ? 'reconnecting' : 'connecting');
    let socket: WebSocketLike;
    try {
      socket = new this.WebSocketClass(this.url);
    } catch (error: unknown) {
      emit(this, 'error', { message: `Could not connect to the game server: ${errorText(error)}` });
      this.#scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('open', () => {
      if (socket !== this.socket || !this.wanted) {
        socket.close(1000, 'Connection is no longer needed.');
        return;
      }
      this.retryCount = 0;
      this.#setState('open');
      if (this.joinMessage) this.#send(this.joinMessage);
    });
    socket.addEventListener('message', (event: MessageEvent) => {
      if (socket !== this.socket) {
        return;
      }
      this.#recordTraffic('inbound', byteLength(event.data));
      const handle = () => {
        if (socket === this.socket) this.#handleMessage(event.data);
      };
      if (this.networkEmulator) this.networkEmulator.transmit(handle, 'inbound');
      else handle();
    });
    socket.addEventListener('error', () => {
      if (socket === this.socket) {
        emit(this, 'error', { message: 'The connection encountered a network error.' });
      }
    });
    socket.addEventListener('close', (event: CloseEvent) => {
      if (socket !== this.socket) {
        return;
      }
      this.socket = null;
      this.joined = false;
      if (!this.wanted) {
        this.#setState('disconnected');
        return;
      }
      emit(this, 'close', { code: event.code, reason: event.reason });
      this.#scheduleReconnect();
    });
  }

  #handleMessage(raw: unknown): void {
    const binary = typeof raw !== 'string';
    let message: ServerMessage;
    try {
      message = measureStage('decode', () => {
        if (binary) {
          const decoded = decodeBinary(raw);
          if (decoded.type !== 'snapshot' && decoded.type !== 'pong') {
            throw new TypeError('The server sent a client-only binary message.');
          }
          return serverMessageSchema.parse({ version: PROTOCOL_VERSION, ...decoded });
        }
        const parsed = parseServerMessage(raw);
        if (!parsed.success) throw new TypeError('The server sent an unreadable message.');
        return parsed.data;
      });
    } catch {
      emit(this, 'error', { message: 'The server sent an unreadable message.' });
      return;
    }

    if (message.type === 'joined') {
      this.joined = true;
      this.#setState('joined');
      for (const queued of this.queue.splice(0)) {
        this.#send(queued);
      }
    }
    if (message.type === 'pong') {
      this.rttMs = Math.max(0, performance.now() - message.sentAt);
    }
    if (message.type === 'error') {
      if (!this.joined) {
        this.disconnect();
      }
      emit(this, 'error', { message: message.message });
    }
    if (message.type === 'shutdown') {
      emit(this, 'error', { message: message.message });
    }
    emit(this, 'message', message);
    emit(this, message.type, message);
  }

  #send(message: unknown, binary = false): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    const socket = this.socket;
    const payload = binary ? message : encodeJson(message);
    if (typeof payload !== 'string' && !(payload instanceof ArrayBuffer)) {
      throw new TypeError('The selected codec produced an unsupported WebSocket payload.');
    }
    this.#recordTraffic('outbound', byteLength(payload));
    const deliver = (): void => {
      if (socket !== this.socket || socket.readyState !== WebSocket.OPEN) return;
      try {
        socket.send(payload);
      } catch (error: unknown) {
        emit(this, 'error', { message: `Could not send the message: ${errorText(error)}` });
      }
    };
    if (this.networkEmulator) {
      this.networkEmulator.transmit(deliver, 'outbound');
      return true;
    }
    try {
      deliver();
      return true;
    } catch (error: unknown) {
      emit(this, 'error', { message: `Could not send the message: ${errorText(error)}` });
      return false;
    }
  }

  #recordTraffic(direction: TrafficDirection, bytes: number): void {
    const at = performance.now();
    const last = this.trafficSamples.at(-1);
    if (last?.at === at) {
      last[direction] += bytes;
    } else {
      this.trafficSamples.push({
        at,
        inbound: direction === 'inbound' ? bytes : 0,
        outbound: direction === 'outbound' ? bytes : 0,
      });
    }
    this.trafficSamples = this.trafficSamples.filter((sample) => at - sample.at <= 2000);
  }

  #scheduleReconnect(): void {
    if (!this.wanted || this.reconnectTimer !== null) {
      return;
    }
    const ceiling = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** this.retryCount);
    const delay = Math.round(ceiling * (0.5 + this.random() * 0.5));
    this.retryCount += 1;
    this.#setState('reconnecting');
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      this.#open();
    }, delay);
  }

  #setState(state: ConnectionState): void {
    if (this.state === state) {
      return;
    }
    this.state = state;
    emit(this, 'state', { state });
  }
}

function byteLength(data: unknown): number {
  if (typeof data === 'string') return new TextEncoder().encode(data).byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  return 0;
}
