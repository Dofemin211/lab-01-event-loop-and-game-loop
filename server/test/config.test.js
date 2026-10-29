import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createConfig } from '../src/config.js';

test('createConfig provides validated defaults and resolves paths from the workspace', () => {
  const config = createConfig({}, 'C:\\workspace');
  assert.equal(config.port, 3000);
  assert.equal(config.host, '127.0.0.1');
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
});

test('createConfig rejects invalid numeric settings', () => {
  for (const env of [
    { PORT: 'not-a-port' },
    { PORT: '65536' },
    { MAX_ROOMS: '0' },
    { MAX_PAYLOAD_BYTES: '64' },
    { HEARTBEAT_INTERVAL_MS: '-1' },
  ]) {
    assert.throws(() => createConfig(env, 'C:\\workspace'), RangeError);
  }
});
