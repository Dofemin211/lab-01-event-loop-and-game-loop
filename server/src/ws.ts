import { randomUUID } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';
import { encodeBinary } from '@dogfight/shared/codec';
import { Match, type MatchSnapshot } from './match.ts';
import { parseClientMessage, ProtocolError, serverMessage } from './protocol.ts';
import type { ServerConfig } from './config.ts';
import type { Room, RoomManager, RoomPlayer, ChatRecord } from './rooms.ts';
import { TokenBucket } from './token-bucket.ts';

type Logger = Pick<Console, 'error'>;
type OutgoingData = string | Buffer | ArrayBuffer;

interface SocketLike extends NodeJS.EventEmitter {
  readyState: number;
  bufferedAmount: number;
  send(message: OutgoingData, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  ping(): void;
  terminate(): void;
}

interface WebSocketServerLike extends NodeJS.EventEmitter {
  readonly clients: Iterable<SocketLike>;
  on(event: 'connection', listener: (socket: SocketLike) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

interface SocketState {
  readonly config: ServerConfig;
  readonly logger: Logger;
  room: Room | null;
  player: RoomPlayer | null;
  codec: 'binary' | 'json';
  alive: boolean;
  missedHeartbeats: number;
  droppedMessages: number;
  readonly rateLimiter: TokenBucket;
  readonly joinTimer: NodeJS.Timeout;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logError(logger: Logger, message: string, error: unknown): void {
  logger.error(message, errorText(error));
}

function send(
  socket: SocketLike,
  state: SocketState,
  message: OutgoingData,
  { critical = true }: { readonly critical?: boolean } = {},
): boolean {
  if (socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  if (socket.bufferedAmount > state.config.slowClientBytes) {
    if (!critical) {
      state.droppedMessages += 1;
      return false;
    }
    socket.close(1013, 'Client cannot keep up.');
    return false;
  }
  try {
    socket.send(message, (error?: Error) => {
      if (error) {
        logError(state.logger, 'WebSocket send failed:', error);
      }
    });
    return true;
  } catch (error: unknown) {
    logError(state.logger, 'WebSocket send failed:', error);
    socket.close(1011, 'Message delivery failed.');
    return false;
  }
}

function rawDataLength(data: RawData): number {
  if (typeof data === 'string') return Buffer.byteLength(data);
  if (Array.isArray(data)) return Buffer.concat(data).byteLength;
  return data.byteLength;
}

function attachRoomBroadcasts(
  room: Room,
  wss: WebSocketServerLike,
  states: Map<SocketLike, SocketState>,
  logger: Logger,
): void {
  const broadcast = (message: string, critical = true): void => {
    for (const socket of wss.clients) {
      const state = states.get(socket);
      if (state?.room === room) {
        send(socket, state, message, { critical });
      }
    }
  };
  const onJoin = (): void => {
    broadcast(
      serverMessage('roster', {
        room: room.toJSON(),
        players: room.roster(),
      }),
    );
  };
  const onChat = (message: ChatRecord): void => {
    broadcast(serverMessage('chat', { message }), false);
  };
  const onError = (error: Error): void => logError(logger, `Room ${room.id} failed:`, error);
  const onSnapshot = (snapshot: MatchSnapshot): void => {
    let jsonSnapshot: string | undefined;
    let binarySnapshot: Buffer | undefined;
    for (const socket of wss.clients) {
      const state = states.get(socket);
      if (state?.room !== room) continue;
      if (state.codec === 'binary') {
        binarySnapshot ??= Buffer.from(encodeBinary(snapshot));
        send(socket, state, binarySnapshot, { critical: false });
      } else {
        jsonSnapshot ??= serverMessage('snapshot', snapshot);
        send(socket, state, jsonSnapshot, { critical: false });
      }
    }
  };

  room.on('join', onJoin);
  room.on('leave', onJoin);
  room.on('chat', onChat);
  room.on('error', onError);
  room.on('snapshot', onSnapshot);
  room.once('empty', () => {
    room.off('join', onJoin);
    room.off('leave', onJoin);
    room.off('chat', onChat);
    room.off('error', onError);
    room.off('snapshot', onSnapshot);
  });
}

function assertNever(value: never): never {
  throw new Error(`Unhandled client message type: ${String(value)}`);
}

export function installWebSocketHandlers(
  wss: WebSocketServerLike,
  roomManager: RoomManager,
  config: ServerConfig,
  logger: Logger = console,
) {
  const states = new Map<SocketLike, SocketState>();
  const attachRoom = (room: Room): void => attachRoomBroadcasts(room, wss, states, logger);
  for (const room of roomManager.rooms.values()) {
    attachRoom(room);
  }
  roomManager.on('roomCreated', attachRoom);
  roomManager.on('error', (error) => logError(logger, 'Room manager failed:', error));
  wss.on('error', (error) => logError(logger, 'WebSocket server failed:', error));

  wss.on('connection', (socket) => {
    const state: SocketState = {
      config,
      logger,
      room: null,
      player: null,
      codec: 'json',
      alive: true,
      missedHeartbeats: 0,
      droppedMessages: 0,
      rateLimiter: new TokenBucket(config.messageRatePerSecond),
      joinTimer: setTimeout(() => {
        send(
          socket,
          state,
          serverMessage('error', { message: 'Join a room within five seconds.' }),
        );
        socket.close(1008, 'Join timeout.');
      }, config.joinTimeoutMs),
    };
    state.joinTimer.unref();
    states.set(socket, state);

    socket.on('error', (error) => logError(logger, 'WebSocket client error:', error));
    socket.on('pong', () => {
      state.alive = true;
      state.missedHeartbeats = 0;
    });
    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (!consumeToken(state)) {
        send(socket, state, serverMessage('error', { message: 'Message rate limit exceeded.' }));
        socket.close(1008, 'Rate limit exceeded.');
        return;
      }
      if (rawDataLength(data) > config.maxPayloadBytes) {
        send(socket, state, serverMessage('error', { message: 'Message is too large.' }));
        socket.close(1009, 'Message too large.');
        return;
      }
      let message;
      try {
        message = parseClientMessage(data, isBinary);
      } catch (error: unknown) {
        if (!(error instanceof ProtocolError)) {
          logError(logger, 'Unexpected protocol validation error:', error);
          socket.close(1011, 'Internal server error.');
          return;
        }
        send(socket, state, serverMessage('error', { message: error.message }));
        socket.close(error.closeCode, error.message.slice(0, 100));
        return;
      }

      switch (message.type) {
        case 'join': {
          if (state.room) {
            send(socket, state, serverMessage('error', { message: 'You already joined a room.' }));
            socket.close(1008, 'Already joined.');
            return;
          }
          const room = roomManager.getRoom(message.room);
          if (!room) {
            send(socket, state, serverMessage('error', { message: 'That room is not available.' }));
            socket.close(1008, 'Unknown room.');
            return;
          }
          const player = { id: randomUUID(), name: message.name };
          try {
            state.room = room;
            state.player = room.join(player);
            state.codec = message.codec ?? 'json';
            clearTimeout(state.joinTimer);
            send(
              socket,
              state,
              serverMessage('joined', { room: room.toJSON(), player: state.player }),
            );
          } catch (error: unknown) {
            state.room = null;
            state.player = null;
            send(socket, state, serverMessage('error', { message: errorText(error) }));
            socket.close(1008, 'Room join rejected.');
          }
          return;
        }
        case 'input':
        case 'ping':
        case 'chat':
          break;
        default:
          assertNever(message);
      }

      const room = state.room;
      const player = state.player;
      if (!room || !player) {
        send(
          socket,
          state,
          serverMessage('error', { message: 'Join a room before sending chat.' }),
        );
        socket.close(1008, 'Join required.');
        return;
      }
      switch (message.type) {
        case 'input': {
          const match: Match | undefined = room.match;
          if (!match) {
            send(socket, state, serverMessage('error', { message: 'The room is not ready.' }));
            socket.close(1011, 'Match is unavailable.');
            return;
          }
          try {
            match.enqueueInput(player.id, {
              seq: message.seq,
              tick: message.tick,
              turn: message.turn,
              thrust: message.thrust,
              brake: message.brake,
              fire: message.fire,
            });
          } catch (error: unknown) {
            send(socket, state, serverMessage('error', { message: errorText(error) }));
          }
          return;
        }
        case 'ping': {
          const pong = { type: 'pong', tick: room.match?.tick ?? 0, sentAt: message.sentAt };
          const encoded =
            state.codec === 'binary'
              ? Buffer.from(encodeBinary(pong))
              : serverMessage('pong', { tick: pong.tick, sentAt: pong.sentAt });
          send(socket, state, encoded, { critical: false });
          return;
        }
        case 'chat':
          try {
            room.chat(player.id, message.text);
          } catch (error: unknown) {
            logError(logger, 'Chat message rejected:', error);
            send(
              socket,
              state,
              serverMessage('error', { message: 'Chat message could not be sent.' }),
            );
          }
          return;
        default:
          assertNever(message);
      }
    });

    socket.on('close', () => {
      clearTimeout(state.joinTimer);
      if (state.room && state.player) {
        state.room.leave(state.player.id);
      }
      states.delete(socket);
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      const state = states.get(socket);
      if (!state || socket.readyState !== WebSocket.OPEN) {
        continue;
      }
      if (!state.alive) {
        state.missedHeartbeats += 1;
        if (state.missedHeartbeats >= config.maxMissedHeartbeats) {
          socket.terminate();
          continue;
        }
      }
      state.alive = false;
      try {
        socket.ping();
      } catch (error: unknown) {
        logError(logger, 'WebSocket heartbeat failed:', error);
        socket.terminate();
      }
    }
  }, config.heartbeatIntervalMs);
  heartbeat.unref();

  return {
    states,
    close(): void {
      clearInterval(heartbeat);
      roomManager.off('roomCreated', attachRoom);
      for (const [socket, state] of states) {
        clearTimeout(state.joinTimer);
        if (state.room && state.player) {
          state.room.leave(state.player.id);
        }
        socket.close(1001, 'Server shutting down.');
      }
      states.clear();
    },
  };
}

function consumeToken(state: SocketState): boolean {
  return state.rateLimiter.consume();
}
