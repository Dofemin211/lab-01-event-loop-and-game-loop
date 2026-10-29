import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function integerSetting(env, name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

export function createConfig(env = process.env, cwd = ROOT) {
  const port = integerSetting(env, 'PORT', 3000, { min: 0, max: 65535 });
  const host = env.HOST?.trim() || '127.0.0.1';
  const logDir = path.resolve(cwd, env.LOG_DIR?.trim() || 'server/logs');

  return Object.freeze({
    port,
    host,
    logDir,
    clientDistDir: path.resolve(cwd, env.CLIENT_DIST_DIR?.trim() || 'client/dist'),
    maxPayloadBytes: integerSetting(env, 'MAX_PAYLOAD_BYTES', 16 * 1024, {
      min: 256,
      max: 1024 * 1024,
    }),
    maxHttpBodyBytes: integerSetting(env, 'MAX_HTTP_BODY_BYTES', 8 * 1024, {
      min: 256,
      max: 1024 * 1024,
    }),
    maxRooms: integerSetting(env, 'MAX_ROOMS', 50, { min: 1, max: 500 }),
    maxPlayersPerRoom: integerSetting(env, 'MAX_PLAYERS_PER_ROOM', 8, {
      min: 1,
      max: 64,
    }),
    messageRatePerSecond: integerSetting(env, 'MESSAGE_RATE_PER_SECOND', 90, {
      min: 1,
      max: 1000,
    }),
    slowClientBytes: integerSetting(env, 'SLOW_CLIENT_BYTES', 256 * 1024, {
      min: 1024,
      max: 64 * 1024 * 1024,
    }),
    joinTimeoutMs: integerSetting(env, 'JOIN_TIMEOUT_MS', 5000, {
      min: 100,
      max: 60_000,
    }),
    heartbeatIntervalMs: integerSetting(env, 'HEARTBEAT_INTERVAL_MS', 15_000, {
      min: 100,
      max: 120_000,
    }),
    maxMissedHeartbeats: integerSetting(env, 'MAX_MISSED_HEARTBEATS', 2, {
      min: 1,
      max: 10,
    }),
    enableDevRoutes: env.NODE_ENV === 'development',
  });
}

export { ROOT };
