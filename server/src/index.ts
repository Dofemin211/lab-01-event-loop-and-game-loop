import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachWebSocketUpgrade, createHttpServer, createWebSocketServer } from './http.ts';
import { MatchLogManager } from './log/matchlog.ts';
import { createConfig } from './config.ts';
import { defaultRooms, RoomManager } from './rooms.ts';
import { installWebSocketHandlers } from './ws.ts';
import { MatchManager } from './match.ts';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { WebSocketServer } from 'ws';
import type { ServerConfig } from './config.ts';
import type { RoomConfig } from './rooms.ts';

type Logger = Pick<Console, 'error'>;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export interface ApplicationOptions {
  readonly config?: ServerConfig;
  readonly logger?: Logger;
  readonly initialRooms?: readonly RoomConfig[];
}

export interface Application {
  readonly config: ServerConfig;
  readonly server: Server;
  readonly wss: WebSocketServer;
  readonly roomManager: RoomManager;
  readonly matchManager: MatchManager;
  readonly logManager: MatchLogManager;
  start(): Promise<AddressInfo | string | null>;
  shutdown(): Promise<void>;
}

export function createApplication(options: ApplicationOptions = {}): Application {
  const config = options.config ?? createConfig(process.env, ROOT);
  const logger = options.logger ?? console;
  const initialRooms =
    options.initialRooms ?? defaultRooms(config.maxPlayersPerRoom).slice(0, config.maxRooms);
  const roomManager = new RoomManager({
    maxRooms: config.maxRooms,
    maxPlayersPerRoom: config.maxPlayersPerRoom,
  });
  const logManager = new MatchLogManager({ logDir: config.logDir, logger });
  const matchManager = new MatchManager(roomManager);
  roomManager.on('roomCreated', (room) => {
    room.matchLog = logManager.attach(room);
    room.replayId = room.matchLog.fileId;
  });
  for (const room of initialRooms) {
    roomManager.createRoom(room);
  }

  const server = createHttpServer({ config, roomManager, matchManager, logger });
  const wss = createWebSocketServer(config);
  attachWebSocketUpgrade(server, wss, logger);
  const webSocketService = installWebSocketHandlers(wss, roomManager, config, logger);
  let shutdownPromise: Promise<void> | null = null;

  return {
    config,
    server,
    wss,
    roomManager,
    matchManager,
    logManager,
    async start() {
      if (server.listening) {
        return server.address();
      }
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
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

  async function performShutdown(): Promise<void> {
    webSocketService.close();
    const websocketClosed = new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    const httpClosed = server.listening
      ? new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeIdleConnections?.();
        })
      : Promise.resolve();

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 5000);
      timer.unref?.();
    });
    await Promise.race([Promise.all([httpClosed, websocketClosed]), timeout]);
    clearTimeout(timer);
    for (const socket of wss.clients) {
      socket.terminate();
    }
    if (wss.clients.size > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    await logManager.close();
    matchManager.close();
    roomManager.close();
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
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
    if (!address || typeof address === 'string') {
      throw new Error('The game server did not bind to a network address.');
    }
    console.info(`Game server listening on http://${address.address}:${address.port}`);
  } catch (error: unknown) {
    console.error(
      'Game server could not start:',
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  }

  if (application) {
    let shuttingDown = false;
    const shutdown = (signal: 'SIGINT' | 'SIGTERM') => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      console.info(`${signal} received; shutting down gracefully.`);
      application.shutdown().then(
        () => {
          process.exitCode = 0;
        },
        (error: unknown) => {
          console.error(
            'Graceful shutdown failed:',
            error instanceof Error ? error.message : String(error),
          );
          process.exitCode = 1;
        },
      );
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  }
}
