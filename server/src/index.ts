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
import { BUILD_INFO } from './build-info.ts';
import { createLogger } from './logger.ts';
import { ActiveConnectionLimiter, WebSocketSecurityMetrics } from './ws-security.ts';

type Logger = {
  error(message?: unknown, ...details: unknown[]): void;
  event?(name: string, fields?: Readonly<Record<string, string | number | boolean>>): void;
  flush?(): Promise<void>;
  info(message?: unknown, ...details: unknown[]): void;
  fatal?(message?: unknown, ...details: unknown[]): void;
};

const ROOT =
  process.env.APP_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export interface ApplicationOptions {
  readonly config?: ServerConfig;
  readonly logger?: Logger;
  readonly initialRooms?: readonly RoomConfig[];
  readonly buildInfo?: { readonly version: string; readonly gitSha: string };
}

export interface Application {
  readonly config: ServerConfig;
  readonly server: Server;
  readonly wss: WebSocketServer;
  readonly roomManager: RoomManager;
  readonly matchManager: MatchManager;
  readonly logManager: MatchLogManager;
  readonly securityMetrics: WebSocketSecurityMetrics;
  readonly connectionLimiter: ActiveConnectionLimiter;
  readonly readiness: {
    readonly version: string;
    readonly gitSha: string;
    ready: boolean;
    draining: boolean;
  };
  start(): Promise<AddressInfo | string | null>;
  shutdown(): Promise<void>;
}

export function createApplication(options: ApplicationOptions = {}): Application {
  const config = options.config ?? createConfig(process.env, ROOT);
  const logger = options.logger ?? createLogger(config.logLevel);
  const buildInfo = options.buildInfo ?? {
    version: process.env.APP_VERSION ?? BUILD_INFO.version,
    gitSha: process.env.GIT_SHA ?? BUILD_INFO.gitSha,
  };
  const readiness = {
    version: buildInfo.version,
    gitSha: buildInfo.gitSha,
    ready: false,
    draining: false,
  };
  const securityMetrics = new WebSocketSecurityMetrics();
  const connectionLimiter = new ActiveConnectionLimiter(config.maxConnectionsPerIp);
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

  const server = createHttpServer({
    config,
    roomManager,
    matchManager,
    lifecycle: readiness,
    securityStats: () =>
      securityMetrics.snapshot(connectionLimiter.activeConnections, connectionLimiter.trackedIps),
    trafficStats: () => securityMetrics.trafficRates(),
    logger,
  });
  const wss = createWebSocketServer(config);
  attachWebSocketUpgrade(
    server,
    wss,
    () => readiness.draining,
    config,
    connectionLimiter,
    securityMetrics,
    logger,
  );
  const webSocketService = installWebSocketHandlers(
    wss,
    roomManager,
    config,
    logger,
    securityMetrics,
  );
  let shutdownPromise: Promise<void> | null = null;

  return {
    config,
    server,
    wss,
    roomManager,
    matchManager,
    logManager,
    securityMetrics,
    connectionLimiter,
    readiness,
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
      readiness.ready = true;
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
    readiness.ready = false;
    readiness.draining = true;
    const httpClosed = server.listening
      ? new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeIdleConnections?.();
        })
      : Promise.resolve();
    const websocketClosed = new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    const websocketDrain = webSocketService.close();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), 8000);
    });
    const drained = Promise.all([httpClosed, websocketClosed, websocketDrain]).then(
      () => 'closed' as const,
    );
    const result = await Promise.race([drained, deadline]);
    if (timer) clearTimeout(timer);
    if (result === 'timeout') {
      logger.error('Graceful shutdown deadline reached; terminating remaining connections.');
      for (const socket of wss.clients) {
        socket.terminate();
      }
      server.closeAllConnections?.();
      await Promise.allSettled([httpClosed, websocketClosed, websocketDrain]);
    }
    matchManager.close();
    roomManager.close();
    await logManager.close();
    await logger.flush?.();
  }
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

export function installProcessHandlers(
  application: Application,
  log = createLogger(application.config.logLevel),
): void {
  let shutdownPromise: Promise<void> | null = null;
  let forceExit: NodeJS.Timeout | undefined;
  const shutdown = (reason: string, exitCode: 0 | 1) => {
    if (shutdownPromise) {
      return;
    }
    log.info(`${reason}; shutting down gracefully.`);
    forceExit = setTimeout(() => {
      log.error('Shutdown exceeded the 10 second process deadline.');
      process.exit(1);
    }, 10_000);
    shutdownPromise = application.shutdown();
    shutdownPromise.then(
      () => {
        if (forceExit) clearTimeout(forceExit);
        process.exitCode = exitCode;
      },
      (error: unknown) => {
        if (forceExit) clearTimeout(forceExit);
        log.error('Graceful shutdown failed:', error);
        process.exitCode = 1;
      },
    );
  };
  process.once('SIGINT', () => shutdown('SIGINT received', 0));
  process.once('SIGTERM', () => shutdown('SIGTERM received', 0));
  process.once('uncaughtException', (error: Error) => {
    (log.fatal ?? log.error)('Uncaught exception; terminating after shutdown.', error);
    shutdown('Uncaught exception', 1);
  });
  process.once('unhandledRejection', (reason: unknown) => {
    (log.fatal ?? log.error)('Unhandled promise rejection; terminating after shutdown.', reason);
    shutdown('Unhandled promise rejection', 1);
  });
}

if (isMainModule()) {
  let application: Application | undefined;
  try {
    application = createApplication();
    const address = await application.start();
    if (!address || typeof address === 'string') {
      throw new Error('The game server did not bind to a network address.');
    }
    const log = createLogger(application.config.logLevel);
    log.info(`Game server listening on http://${address.address}:${address.port}`);
  } catch (error: unknown) {
    console.error(
      'Game server could not start:',
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  }

  if (application) {
    const log = createLogger(application.config.logLevel);
    installProcessHandlers(application, log);
  }
}
