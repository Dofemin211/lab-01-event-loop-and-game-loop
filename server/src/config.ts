import path from 'node:path';
import { isIP } from 'node:net';
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

const nodeEnvironmentSchema = z.enum(['development', 'test', 'production']);
const logLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']);

function isBareHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
  } catch {
    return false;
  }
}

const originsSchema = z.preprocess(
  (value: unknown) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean)
      : value,
  z
    .array(
      z
        .string()
        .url()
        .refine(
          isBareHttpOrigin,
          'Origins must be bare http(s) origins without paths or credentials.',
        ),
    )
    .default([]),
);

const ipAddressesSchema = z.preprocess(
  (value: unknown) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((address) => address.trim())
          .filter(Boolean)
      : value,
  z
    .array(z.string().refine((address) => isIP(address) !== 0, 'Expected an IPv4 or IPv6 address.'))
    .default([]),
);

export const serverConfigSchema = z
  .object({
    nodeEnv: nodeEnvironmentSchema.default('development'),
    port: integerSetting(3000, 0, 65535),
    host: stringSetting('127.0.0.1'),
    logLevel: logLevelSchema.default('info'),
    allowedOrigins: originsSchema,
    trustedProxyIps: ipAddressesSchema,
    maxConnectionsPerIp: integerSetting(100, 1, 100_000),
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
  })
  .superRefine((config, context) => {
    if (config.nodeEnv === 'production' && config.allowedOrigins.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['allowedOrigins'],
        message: 'ALLOWED_ORIGINS must contain at least one origin in production.',
      });
    }
  });

export type ServerConfig = z.infer<typeof serverConfigSchema>;

export function createConfig(env: NodeJS.ProcessEnv = process.env, cwd = ROOT): ServerConfig {
  const parsed = serverConfigSchema.parse({
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    host: env.HOST ?? (env.NODE_ENV === 'production' ? '0.0.0.0' : undefined),
    logLevel: env.LOG_LEVEL,
    allowedOrigins: env.ALLOWED_ORIGINS,
    trustedProxyIps: env.TRUSTED_PROXY_IPS,
    maxConnectionsPerIp: env.MAX_CONNECTIONS_PER_IP,
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
