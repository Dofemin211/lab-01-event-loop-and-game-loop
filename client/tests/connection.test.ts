import test from 'node:test';
import assert from 'node:assert/strict';
import { MultiplayerConnection } from '../src/connection.ts';
import { decodeBinary, encodeBinary } from '@dogfight/shared/codec';

class FakeMessageEvent extends Event {
  constructor(readonly data: string | ArrayBuffer) {
    super('message');
  }
}

class FakeCloseEvent extends Event {
  constructor(
    readonly code: number,
    readonly reason: string,
  ) {
    super('close');
  }
}

class FakeWebSocket extends EventTarget {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readyState: 0 | 1 | 2 | 3 = 0;
  binaryType: BinaryType = 'blob';
  sent: unknown[] = [];

  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }

  send(value: string | ArrayBuffer) {
    if (this.readyState !== 1) {
      throw new Error('Socket is not open.');
    }
    this.sent.push(typeof value === 'string' ? JSON.parse(value) : value);
  }

  receive(message: object) {
    this.dispatchEvent(new FakeMessageEvent(JSON.stringify(message) ?? ''));
  }

  receiveBinary(message: Parameters<typeof encodeBinary>[0]) {
    this.dispatchEvent(new FakeMessageEvent(encodeBinary(message)));
  }

  drop(code = 1006, reason = 'network failure') {
    this.readyState = 3;
    this.dispatchEvent(new FakeCloseEvent(code, reason));
  }

  close(code = 1000, reason = 'closed') {
    this.readyState = 3;
    this.dispatchEvent(new FakeCloseEvent(code, reason));
  }
}

type TestConnectionOptions = {
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxQueue?: number;
};

function createConnection(options: TestConnectionOptions = {}) {
  FakeWebSocket.instances = [];
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const connection = new MultiplayerConnection({
    url: 'ws://game.test/ws',
    WebSocketClass: FakeWebSocket,
    random: () => 1,
    setTimer: (callback, delay) => {
      timers.push({ callback, delay });
      return setTimeout(() => {}, 0);
    },
    clearTimer: (timer) => clearTimeout(timer),
    ...options,
  });
  return { connection, timers };
}

function getSocket(index: number): FakeWebSocket {
  const socket = FakeWebSocket.instances[index];
  assert.ok(socket);
  return socket;
}

function getTimer(timers: Array<{ callback: () => void; delay: number }>, index: number) {
  const timer = timers[index];
  assert.ok(timer);
  return timer;
}

function joinedMessage(roomId: string) {
  return {
    version: 0,
    type: 'joined',
    room: {
      id: roomId,
      name: 'Training sector',
      players: 1,
      maxPlayers: 8,
      arena: { asteroidCount: 6, seed: 1 },
    },
    player: { id: 'player-1', name: 'Ace', entityId: 1 },
  };
}

test('connection sends a queued join then queued chat after the socket opens and join is accepted', () => {
  const { connection } = createConnection();
  connection.connect('training', 'Ace');
  assert.equal(connection.sendChat('Ready'), true);
  const socket = getSocket(0);
  socket.open();
  assert.deepEqual(socket.sent, [
    { version: 0, type: 'join', room: 'training', name: 'Ace', codec: 'binary' },
  ]);
  assert.equal(socket.binaryType, 'arraybuffer');
  socket.receive(joinedMessage('training'));
  assert.deepEqual(socket.sent[1], { version: 0, type: 'chat', text: 'Ready' });
  assert.equal(connection.state, 'joined');
  assert.equal(connection.sendChat('After join'), true);
  assert.deepEqual(socket.sent[2], { version: 0, type: 'chat', text: 'After join' });
  connection.disconnect();
  assert.equal(connection.state, 'disconnected');
});

test('connection reconnects with capped exponential jitter and re-sends join', () => {
  const { connection, timers } = createConnection({ baseDelayMs: 100, maxDelayMs: 250 });
  connection.connect('training', 'Nova');
  const first = getSocket(0);
  first.open();
  first.drop();
  assert.equal(connection.state, 'reconnecting');
  assert.equal(getTimer(timers, 0).delay, 100);
  getTimer(timers, 0).callback();
  const second = getSocket(1);
  second.open();
  assert.deepEqual(second.sent[0], {
    version: 0,
    type: 'join',
    room: 'training',
    name: 'Nova',
    codec: 'binary',
  });
  connection.disconnect();
  second.drop();
  assert.equal(timers.length, 1);
});

test('connection sends sequenced binary inputs and measures binary ping round trips', () => {
  const { connection } = createConnection();
  connection.connect('training', 'Ace');
  const socket = getSocket(0);
  socket.open();
  socket.receive(joinedMessage('training'));
  assert.equal(
    connection.sendInput({
      seq: 1,
      tick: 1,
      turn: -1,
      thrust: true,
      brake: false,
      fire: true,
    }),
    true,
  );
  assert.deepEqual(decodeBinary(socket.sent[1]), {
    type: 'input',
    seq: 1,
    tick: 1,
    turn: -1,
    thrust: true,
    brake: false,
    fire: true,
  });
  const sentAt = performance.now() - 10;
  socket.receiveBinary({ type: 'pong', tick: 1, sentAt });
  assert.ok(connection.rttMs !== null && connection.rttMs >= 10);
  connection.disconnect();
});

test('intentional disconnect cancels reconnect and server rejection stops reconnecting', () => {
  const { connection, timers } = createConnection();
  connection.connect('training', 'Ace');
  const first = getSocket(0);
  first.open();
  connection.disconnect();
  first.drop();
  assert.equal(timers.length, 0);

  connection.connect('missing-room', 'Ace');
  const rejected = getSocket(1);
  rejected.open();
  rejected.receive({ version: 0, type: 'error', message: 'Room unavailable.' });
  assert.equal(connection.state, 'disconnected');
  assert.equal(timers.length, 0);
});

test('shutdown notice is surfaced while the socket reconnects after its close', () => {
  const { connection, timers } = createConnection();
  connection.connect('training', 'Ace');
  const socket = getSocket(0);
  socket.open();
  socket.receive(joinedMessage('training'));
  let notice = '';
  connection.addEventListener('error', (event) => {
    if (!(event instanceof CustomEvent)) throw new TypeError('Expected an error detail event.');
    const detail: unknown = event.detail;
    if (
      typeof detail !== 'object' ||
      detail === null ||
      !('message' in detail) ||
      typeof detail.message !== 'string'
    ) {
      throw new TypeError('Expected a shutdown message.');
    }
    notice = detail.message;
  });
  socket.receive({
    version: 0,
    type: 'shutdown',
    message: 'Server is restarting. Reconnecting...',
  });
  assert.equal(notice, 'Server is restarting. Reconnecting...');
  assert.equal(connection.state, 'joined');
  socket.drop(1001, 'Server shutting down.');
  assert.equal(connection.state, 'reconnecting');
  assert.equal(timers.length, 1);
  connection.disconnect();
  assert.equal(connection.state, 'disconnected');
});

test('connection validates chat messages and applies a bounded queue', () => {
  const { connection } = createConnection({ maxQueue: 1 });
  connection.connect('training', 'Ace');
  assert.throws(() => connection.sendChat(''), /1–500/);
  assert.equal(connection.sendChat('one'), true);
  assert.equal(connection.sendChat('two'), false);
  connection.disconnect();
});
