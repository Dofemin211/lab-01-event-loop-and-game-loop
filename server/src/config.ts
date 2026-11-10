import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function emptyAsUndefined(value: unknown): unknown {
  return value === '' ? undefined : value;
}

function integerSetting(fallback: number, min: number, max = Number.MAX_SAFE_INTEGER) {
  return z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int().min(min).max(max).default(fallback),
  );
}

function stringSetting(fallback: string) {
  return z.preprocess(emptyAsUndefined, z.string().trim().min(1).default(fallback));
}

export const serverConfigSchema = z.object({
  port: integerSetting(3000, 0, 65535),
  host: stringSetting('127.0.0.1'),
  logDir: stringSetting('server/logs'),
  clientDistDir: stringSetting('client/dist'),
  maxPayloadBytes: integerSetting(16 * 1024, 256, 1024 * 1024),
  maxHttpBodyBytes: integerSetting(8 * 1024, 256, 1024 * 1024),
  maxRooms: integerSetting(50, 1, 500),
  maxPlayersPerRoom: integerSetting(8, 1, 64),
  messageRatePerSecond: integerSetting(90, 1, 1000),
  slowClientBytes: integerSetting(256 * 1024, 1024, 64 * 1024 * 1024),
  joinTimeoutMs: integerSetting(5000, 100, 60_000),
  heartbeatIntervalMs: integerSetting(15_000, 100, 120_000),
  maxMissedHeartbeats: integerSetting(2, 1, 10),
  enableDevRoutes: z.boolean().default(false),
});

export type ServerConfig = z.infer<typeof serverConfigSchema>;

export function createConfig(env: NodeJS.ProcessEnv = process.env, cwd = ROOT): ServerConfig {
  const parsed = serverConfigSchema.parse({
    port: env.PORT,
    host: env.HOST,
    logDir: env.LOG_DIR,
    clientDistDir: env.CLIENT_DIST_DIR,
    maxPayloadBytes: env.MAX_PAYLOAD_BYTES,
    maxHttpBodyBytes: env.MAX_HTTP_BODY_BYTES,
    maxRooms: env.MAX_ROOMS,
    maxPlayersPerRoom: env.MAX_PLAYERS_PER_ROOM,
    messageRatePerSecond: env.MESSAGE_RATE_PER_SECOND,
    slowClientBytes: env.SLOW_CLIENT_BYTES,
    joinTimeoutMs: env.JOIN_TIMEOUT_MS,
    heartbeatIntervalMs: env.HEARTBEAT_INTERVAL_MS,
    maxMissedHeartbeats: env.MAX_MISSED_HEARTBEATS,
    enableDevRoutes: env.NODE_ENV === 'development',
  });

  return Object.freeze({
    ...parsed,
    logDir: path.resolve(cwd, parsed.logDir),
    clientDistDir: path.resolve(cwd, parsed.clientDistDir),
  });
}
