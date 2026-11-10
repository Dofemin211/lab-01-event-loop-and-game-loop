import { EventEmitter } from 'node:events';
import { expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createConfig } from '../src/config.ts';
import { RoomManager } from '../src/rooms.ts';
import { installWebSocketHandlers } from '../src/ws.ts';

class FakeSocket extends EventEmitter {
  readyState: WebSocket['readyState'] = WebSocket.OPEN;
  bufferedAmount = 0;
  pings = 0;
  terminated = false;

  send(): void {}
  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
  ping(): void {
    this.pings += 1;
  }
  terminate(): void {
    this.terminated = true;
    this.readyState = WebSocket.CLOSED;
    this.emit('terminated');
    this.emit('close');
  }
}

test('heartbeat: closes after the configured missed-pong threshold', async () => {
  vi.useFakeTimers();
  const manager = new RoomManager();
  const server = Object.assign(new EventEmitter(), { clients: new Set<FakeSocket>() });
  const config = {
    ...createConfig({}, process.cwd()),
    heartbeatIntervalMs: 5,
    maxMissedHeartbeats: 2,
    joinTimeoutMs: 60_000,
  };
  const service = installWebSocketHandlers(server, manager, config, { error() {} });
  const socket = new FakeSocket();
  server.clients.add(socket);
  server.emit('connection', socket);
  try {
    await vi.advanceTimersByTimeAsync(15);
    expect(socket.pings).toBe(2);
    expect(socket.terminated).toBe(true);
  } finally {
    service.close();
    manager.close();
    vi.useRealTimers();
  }
});
