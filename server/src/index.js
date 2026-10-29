import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachWebSocketUpgrade, createHttpServer, createWebSocketServer } from './http.js';
import { MatchLogManager } from './log/matchlog.js';
import { createConfig } from './config.js';
import { defaultRooms, RoomManager } from './rooms.js';
import { installWebSocketHandlers } from './ws.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function createApplication({
  config = createConfig(process.env, ROOT),
  logger = console,
  initialRooms = defaultRooms(config.maxPlayersPerRoom).slice(0, config.maxRooms),
} = {}) {
  const roomManager = new RoomManager({
    maxRooms: config.maxRooms,
    maxPlayersPerRoom: config.maxPlayersPerRoom,
  });
  const logManager = new MatchLogManager({ logDir: config.logDir, logger });
  roomManager.on('roomCreated', (room) => {
    room.matchLog = logManager.attach(room);
    room.replayId = room.matchLog.fileId;
  });
  for (const room of initialRooms) {
    roomManager.createRoom(room);
  }

  const server = createHttpServer({ config, roomManager, logger });
  const wss = createWebSocketServer(config);
  attachWebSocketUpgrade(server, wss, logger);
  const webSocketService = installWebSocketHandlers(wss, roomManager, config, logger);
  let shutdownPromise = null;

  return {
    config,
    server,
    wss,
    roomManager,
    logManager,
    async start() {
      if (server.listening) {
        return server.address();
      }
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(config.port, config.host);
      });
      return server.address();
    },
    shutdown() {
      if (shutdownPromise) {
        return shutdownPromise;
      }
      shutdownPromise = performShutdown();
      return shutdownPromise;
    },
  };

  async function performShutdown() {
    webSocketService.close();
    const websocketClosed = new Promise((resolve) => {
      wss.close(() => resolve());
    });
    const httpClosed = server.listening
      ? new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeIdleConnections?.();
        })
      : Promise.resolve();

    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(resolve, 5000);
      timer.unref?.();
    });
    await Promise.race([Promise.all([httpClosed, websocketClosed]), timeout]);
    clearTimeout(timer);
    for (const socket of wss.clients) {
      socket.terminate();
    }
    if (wss.clients.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await logManager.close();
    roomManager.close();
    if (server.listening) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  }
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  let application;
  try {
    application = createApplication();
    const address = await application.start();
    console.info(`Game server listening on http://${address.address}:${address.port}`);
  } catch (error) {
    console.error('Game server could not start:', error.message);
    process.exitCode = 1;
  }

  if (application) {
    let shuttingDown = false;
    const shutdown = (signal) => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      console.info(`${signal} received; shutting down gracefully.`);
      application.shutdown().then(
        () => {
          process.exitCode = 0;
        },
        (error) => {
          console.error('Graceful shutdown failed:', error.message);
          process.exitCode = 1;
        },
      );
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  }
}
