import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { parseClientMessage, ProtocolError, serverMessage } from './protocol.js';
import { encodeBinary } from '@dogfight/shared/codec';

function logError(logger, message, error) {
  logger.error(message, error?.message ?? error);
}

function send(socket, state, message, { critical = true } = {}) {
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
    socket.send(message, (error) => {
      if (error) {
        logError(state.logger, 'WebSocket send failed:', error);
      }
    });
    return true;
  } catch (error) {
    logError(state.logger, 'WebSocket send failed:', error);
    socket.close(1011, 'Message delivery failed.');
    return false;
  }
}

function broadcastRoom(wss, states, room, message, { critical = true } = {}) {
  const encoded = serverMessage(message.type, message);
  for (const socket of wss.clients) {
    const state = states.get(socket);
    if (state?.room === room) {
      send(socket, state, encoded, { critical });
    }
  }
}

function attachRoomBroadcasts(room, wss, states, logger) {
  const onJoin = () =>
    broadcastRoom(wss, states, room, {
      type: 'roster',
      room: room.toJSON(),
      players: room.roster(),
    });
  const onLeave = onJoin;
  const onChat = (message) =>
    broadcastRoom(wss, states, room, { type: 'chat', message }, { critical: false });
  const onError = (error) => logError(logger, `Room ${room.id} failed:`, error);
  const onSnapshot = (snapshot) => {
    const jsonSnapshot = serverMessage('snapshot', snapshot);
    let binarySnapshot;
    for (const socket of wss.clients) {
      const state = states.get(socket);
      if (state?.room !== room) continue;
      if (state.codec === 'binary') {
        binarySnapshot ??= Buffer.from(encodeBinary(snapshot));
        send(socket, state, binarySnapshot, { critical: false });
      } else {
        send(socket, state, jsonSnapshot, { critical: false });
      }
    }
  };

  room.on('join', onJoin);
  room.on('leave', onLeave);
  room.on('chat', onChat);
  room.on('error', onError);
  room.on('snapshot', onSnapshot);
  room.once('empty', () => {
    room.off('join', onJoin);
    room.off('leave', onLeave);
    room.off('chat', onChat);
    room.off('error', onError);
    room.off('snapshot', onSnapshot);
  });
}

export function installWebSocketHandlers(wss, roomManager, config, logger = console) {
  const states = new Map();
  const attachRoom = (room) => attachRoomBroadcasts(room, wss, states, logger);
  for (const room of roomManager.rooms.values()) {
    attachRoom(room);
  }
  roomManager.on('roomCreated', attachRoom);
  roomManager.on('error', (error) => logError(logger, 'Room manager failed:', error));
  wss.on('error', (error) => logError(logger, 'WebSocket server failed:', error));

  wss.on('connection', (socket) => {
    const state = {
      config,
      logger,
      room: null,
      player: null,
      codec: 'json',
      alive: true,
      missedHeartbeats: 0,
      droppedMessages: 0,
      tokens: config.messageRatePerSecond,
      lastTokenUpdate: Date.now(),
      joinTimer: setTimeout(() => {
        send(
          socket,
          state,
          serverMessage('error', { message: 'Join a room within five seconds.' }),
        );
        socket.close(1008, 'Join timeout.');
      }, config.joinTimeoutMs),
    };
    state.joinTimer.unref?.();
    states.set(socket, state);

    socket.on('error', (error) => logError(logger, 'WebSocket client error:', error));
    socket.on('pong', () => {
      state.alive = true;
      state.missedHeartbeats = 0;
    });
    socket.on('message', (data, isBinary) => {
      if (!consumeToken(state)) {
        send(socket, state, serverMessage('error', { message: 'Message rate limit exceeded.' }));
        socket.close(1008, 'Rate limit exceeded.');
        return;
      }
      if (Buffer.byteLength(data) > config.maxPayloadBytes) {
        send(socket, state, serverMessage('error', { message: 'Message is too large.' }));
        socket.close(1009, 'Message too large.');
        return;
      }
      let message;
      try {
        message = parseClientMessage(data, isBinary);
      } catch (error) {
        if (!(error instanceof ProtocolError)) {
          logError(logger, 'Unexpected protocol validation error:', error);
          socket.close(1011, 'Internal server error.');
          return;
        }
        send(socket, state, serverMessage('error', { message: error.message }));
        socket.close(error.closeCode, error.message.slice(0, 100));
        return;
      }

      if (message.type === 'join') {
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
        } catch (error) {
          state.room = null;
          state.player = null;
          send(socket, state, serverMessage('error', { message: error.message }));
          socket.close(1008, 'Room join rejected.');
        }
        return;
      }

      if (!state.room || !state.player) {
        send(
          socket,
          state,
          serverMessage('error', { message: 'Join a room before sending chat.' }),
        );
        socket.close(1008, 'Join required.');
        return;
      }
      if (message.type === 'input') {
        try {
          state.room.match.enqueueInput(state.player.id, message);
        } catch (error) {
          send(socket, state, serverMessage('error', { message: error.message }));
        }
        return;
      }
      if (message.type === 'ping') {
        const pong = { type: 'pong', tick: state.room.match?.tick ?? 0, sentAt: message.sentAt };
        const encoded =
          state.codec === 'binary'
            ? Buffer.from(encodeBinary(pong))
            : serverMessage('pong', { tick: pong.tick, sentAt: pong.sentAt });
        send(socket, state, encoded, { critical: false });
        return;
      }
      try {
        state.room.chat(state.player.id, message.text);
      } catch (error) {
        logError(logger, 'Chat message rejected:', error);
        send(socket, state, serverMessage('error', { message: 'Chat message could not be sent.' }));
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
      } catch (error) {
        logError(logger, 'WebSocket heartbeat failed:', error);
        socket.terminate();
      }
    }
  }, config.heartbeatIntervalMs);
  heartbeat.unref?.();

  return {
    states,
    close() {
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

function consumeToken(state) {
  const now = Date.now();
  const elapsed = (now - state.lastTokenUpdate) / 1000;
  state.tokens = Math.min(
    state.config.messageRatePerSecond,
    state.tokens + elapsed * state.config.messageRatePerSecond,
  );
  state.lastTokenUpdate = now;
  if (state.tokens < 1) {
    return false;
  }
  state.tokens -= 1;
  return true;
}
