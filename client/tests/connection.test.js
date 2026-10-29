import test from 'node:test';
import assert from 'node:assert/strict';
import { MultiplayerConnection } from '../src/connection.js';

class FakeWebSocket extends EventTarget {
  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }

  send(value) {
    if (this.readyState !== 1) {
      throw new Error('Socket is not open.');
    }
    this.sent.push(JSON.parse(value));
  }

  receive(message) {
    const event = new Event('message');
    event.data = JSON.stringify(message);
    this.dispatchEvent(event);
  }

  drop(code = 1006, reason = 'network failure') {
    this.readyState = 3;
    const event = new Event('close');
    event.code = code;
    event.reason = reason;
    this.dispatchEvent(event);
  }

  close(code = 1000, reason = 'closed') {
    this.readyState = 3;
    const event = new Event('close');
    event.code = code;
    event.reason = reason;
    this.dispatchEvent(event);
  }
}

function createConnection(options = {}) {
  FakeWebSocket.instances = [];
  const timers = [];
  const connection = new MultiplayerConnection({
    url: 'ws://game.test/ws',
    WebSocketClass: FakeWebSocket,
    random: () => 1,
    setTimer: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimer: () => {},
    ...options,
  });
  return { connection, timers };
}

test('connection sends a queued join then queued chat after the socket opens and join is accepted', () => {
  const { connection } = createConnection();
  connection.connect('training', 'Ace');
  assert.equal(connection.sendChat('Ready'), true);
  const socket = FakeWebSocket.instances[0];
  socket.open();
  assert.deepEqual(socket.sent, [{ version: 0, type: 'join', room: 'training', name: 'Ace' }]);
  socket.receive({ version: 0, type: 'joined', room: { id: 'training' } });
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
  const first = FakeWebSocket.instances[0];
  first.open();
  first.drop();
  assert.equal(connection.state, 'reconnecting');
  assert.equal(timers[0].delay, 100);
  timers[0].callback();
  const second = FakeWebSocket.instances[1];
  second.open();
  assert.deepEqual(second.sent[0], {
    version: 0,
    type: 'join',
    room: 'training',
    name: 'Nova',
  });
  connection.disconnect();
  second.drop();
  assert.equal(timers.length, 1);
});

test('intentional disconnect cancels reconnect and server rejection stops reconnecting', () => {
  const { connection, timers } = createConnection();
  connection.connect('training', 'Ace');
  const first = FakeWebSocket.instances[0];
  first.open();
  connection.disconnect();
  first.drop();
  assert.equal(timers.length, 0);

  connection.connect('missing-room', 'Ace');
  const rejected = FakeWebSocket.instances[1];
  rejected.open();
  rejected.receive({ version: 0, type: 'error', message: 'Room unavailable.' });
  assert.equal(connection.state, 'disconnected');
  assert.equal(timers.length, 0);
});

test('connection validates chat messages and applies a bounded queue', () => {
  const { connection } = createConnection({ maxQueue: 1 });
  connection.connect('training', 'Ace');
  assert.throws(() => connection.sendChat(''), /1–500/);
  assert.equal(connection.sendChat('one'), true);
  assert.equal(connection.sendChat('two'), false);
  connection.disconnect();
});
