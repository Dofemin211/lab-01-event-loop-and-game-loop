import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import test from 'node:test';
import { WebSocket } from 'ws';
import { RoomManager } from '../src/rooms.ts';
import { installWebSocketHandlers } from '../src/ws.ts';
import { createConfig } from '../src/config.ts';
import type { ServerConfig } from '../src/config.ts';

const quietLogger = { error() {}, info() {} };
const roomDefinition = {
  id: 'alpha',
  name: 'Alpha',
  maxPlayers: 2,
  arena: { asteroidCount: 2, seed: 1 },
};

class FakeSocket extends EventEmitter {
  readyState: WebSocket['readyState'] = WebSocket.OPEN;
  bufferedAmount = 0;
  closeCode: number | null = null;
  pingCount = 0;
  terminated = false;

  send(_message: string | Buffer | ArrayBuffer, callback?: (error?: Error) => void): void {
    callback?.();
  }

  close(code = WebSocket.CLOSED): void {
    this.closeCode = code;
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }

  ping(): void {
    this.pingCount += 1;
  }

  terminate() {
    this.terminated = true;
    this.readyState = WebSocket.CLOSED;
    this.emit('terminated');
    this.emit('close');
  }
}

function createHarness(overrides: Partial<ServerConfig> = {}) {
  const roomManager = new RoomManager({
    maxRooms: 2,
    maxPlayersPerRoom: 2,
    initialRooms: [roomDefinition],
  });
  const wss = Object.assign(new EventEmitter(), { clients: new Set<FakeSocket>() });
  const config: ServerConfig = {
    ...createConfig({}, process.cwd()),
    messageRatePerSecond: 20,
    slowClientBytes: 1024,
    joinTimeoutMs: 1000,
    heartbeatIntervalMs: 10_000,
    maxMissedHeartbeats: 2,
    maxPayloadBytes: 1024,
    ...overrides,
  };
  const service = installWebSocketHandlers(wss, roomManager, config, quietLogger);
  const connect = () => {
    const socket = new FakeSocket();
    wss.clients.add(socket);
    wss.emit('connection', socket);
    return socket;
  };
  return {
    roomManager,
    service,
    connect,
    close() {
      service.close();
      roomManager.close();
    },
  };
}

function send(socket: FakeSocket, message: Record<string, unknown>): void {
  const serialized = JSON.stringify(message);
  if (serialized === undefined) {
    throw new TypeError('Test message could not be serialized.');
  }
  socket.emit('message', Buffer.from(serialized), false);
}

test('slow-client policy drops chat and closes a client that cannot receive critical messages', () => {
  const harness = createHarness();
  try {
    const slow = harness.connect();
    send(slow, { version: 0, type: 'join', room: 'alpha', name: 'Slow' });
    const state = harness.service.states.get(slow);
    assert.ok(state);
    slow.bufferedAmount = 1025;
    send(slow, { version: 0, type: 'chat', text: 'Low priority' });
    assert.equal(state.droppedMessages, 1);
    assert.equal(slow.closeCode, null);

    const next = harness.connect();
    send(next, { version: 0, type: 'join', room: 'alpha', name: 'Fast' });
    assert.equal(slow.closeCode, 1013);
    assert.equal(harness.roomManager.getRoom('alpha')?.players.size, 1);
  } finally {
    harness.close();
  }
});

test('heartbeat terminates a socket that misses the configured pong threshold', async () => {
  const harness = createHarness({ heartbeatIntervalMs: 5, maxMissedHeartbeats: 2 });
  const socket = harness.connect();
  try {
    const terminated = once(socket, 'terminated');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Heartbeat did not terminate the socket.')), 250);
    });
    await Promise.race([terminated, deadline]);
    if (timeout) clearTimeout(timeout);
    assert.equal(socket.pingCount, 2);
    assert.equal(socket.terminated, true);
  } finally {
    harness.close();
  }
});
