import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ZodError } from 'zod';
import { createConfig } from '../src/config.ts';

test('createConfig provides validated defaults and resolves paths from the workspace', () => {
  const config = createConfig({}, 'C:\\workspace');
  assert.equal(config.port, 3000);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.nodeEnv, 'development');
  assert.equal(config.logLevel, 'info');
  assert.deepEqual(config.allowedOrigins, []);
  assert.equal(config.maxConnectionsPerIp, 100);
  assert.equal(config.maxPayloadBytes, 16 * 1024);
  assert.equal(config.enableDevRoutes, false);
  assert.equal(config.clientDistDir, path.resolve('C:\\workspace', 'client/dist'));

  const fromEnvironment = createConfig(
    { PORT: '4200', HOST: 'localhost', LOG_DIR: 'var/logs', NODE_ENV: 'development' },
    'C:\\workspace',
  );
  assert.equal(fromEnvironment.port, 4200);
  assert.equal(fromEnvironment.host, 'localhost');
  assert.equal(fromEnvironment.logDir, path.resolve('C:\\workspace', 'var/logs'));
  assert.equal(fromEnvironment.enableDevRoutes, true);
  assert.throws(() => createConfig({ NODE_ENV: 'production' }, 'C:\\workspace'), ZodError);
  const production = createConfig(
    {
      NODE_ENV: 'production',
      PORT: '8080',
      LOG_LEVEL: 'warn',
      ALLOWED_ORIGINS: 'https://game.example, https://admin.example',
      TRUSTED_PROXY_IPS: '127.0.0.1, ::1',
      MAX_CONNECTIONS_PER_IP: '25',
      MAX_ROOMS: '12',
      MAX_PLAYERS_PER_ROOM: '6',
    },
    'C:\\workspace',
  );
  assert.equal(production.port, 8080);
  assert.equal(production.logLevel, 'warn');
  assert.deepEqual(production.allowedOrigins, ['https://game.example', 'https://admin.example']);
  assert.deepEqual(production.trustedProxyIps, ['127.0.0.1', '::1']);
  assert.equal(production.maxConnectionsPerIp, 25);
  assert.equal(production.maxRooms, 12);
  assert.equal(production.maxPlayersPerRoom, 6);
  assert.equal(
    createConfig(
      { NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://game.example' },
      'C:\\workspace',
    ).host,
    '0.0.0.0',
  );
});

test('createConfig rejects invalid numeric settings', () => {
  for (const env of [
    { PORT: 'not-a-port' },
    { PORT: '65536' },
    { MAX_ROOMS: '0' },
    { MAX_PAYLOAD_BYTES: '64' },
    { HEARTBEAT_INTERVAL_MS: '-1' },
    { NODE_ENV: 'staging' },
    { LOG_LEVEL: 'verbose' },
    { ALLOWED_ORIGINS: 'not-an-origin' },
    { ALLOWED_ORIGINS: 'https://game.example/path' },
    { TRUSTED_PROXY_IPS: 'not-an-ip' },
    { MAX_CONNECTIONS_PER_IP: '0' },
  ]) {
    assert.throws(() => createConfig(env, 'C:\\workspace'), ZodError);
  }
});
