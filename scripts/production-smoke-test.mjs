import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'dist/server-runtime/server/src/index.js');
const logDir = await mkdtemp(path.join(os.tmpdir(), 'dogfight-production-smoke-'));
process.once('exit', () => rmSync(logDir, { recursive: true, force: true }));
const packageMetadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
let expectedGitSha = process.env.GIT_SHA;
if (!expectedGitSha) {
  try {
    expectedGitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    expectedGitSha = 'unknown';
  }
}
const expectedHealth = {
  status: 'ok',
  version: process.env.APP_VERSION ?? packageMetadata.version,
  gitSha: expectedGitSha,
};

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function startServer(
  port,
  { crash = '', windowsSignalShim = process.platform === 'win32' && !crash } = {},
) {
  const args = [
    '--env-file-if-exists=.env',
    '--import',
    './scripts/production-env.mjs',
    ...(crash ? ['--import', `./scripts/trigger-${crash}.mjs`] : []),
    windowsSignalShim ? './scripts/production-smoke-child.mjs' : entry,
  ];
  return spawn(process.execPath, args, {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(port),
      ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
      LOG_DIR: logDir,
    },
    stdio: [windowsSignalShim ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
}

async function waitForHealth(port, child) {
  const deadline = Date.now() + 8000;
  let lastError;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return await response.json();
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(`Production server did not become healthy: ${String(lastError)}`);
}

function waitForExit(child, timeoutMs = 10_000, diagnostics = () => '') {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Production server did not exit before the deadline. ${diagnostics()}`));
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

if (process.platform === 'win32') {
  const mainPort = await unusedPort();
  const mainChild = startServer(mainPort, { windowsSignalShim: false });
  try {
    const health = await waitForHealth(mainPort, mainChild);
    assert.deepEqual(health, expectedHealth);
    assert.equal((await fetch(`http://127.0.0.1:${mainPort}/ready`)).status, 200);
  } finally {
    if (mainChild.exitCode === null) mainChild.kill('SIGKILL');
  }
  await waitForExit(mainChild);
}

const port = await unusedPort();
const child = startServer(port);
let stderr = '';
let stdout = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdout += chunk;
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});

try {
  const health = await waitForHealth(port, child);
  assert.deepEqual(health, expectedHealth);
  await delay(10_100);
  const ready = await fetch(`http://127.0.0.1:${port}/ready`);
  assert.equal(ready.status, 200);
  const home = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type') ?? '', /text\/html/);

  const sockets = await Promise.all(
    ['Smoke One', 'Smoke Two'].map(async (name) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: { Origin: `http://127.0.0.1:${port}` },
      });
      socket.on('error', () => {});
      await new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      const joined = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WebSocket join timed out.')), 5000);
        socket.on('message', (raw) => {
          try {
            const message = JSON.parse(raw.toString());
            if (message.type === 'joined') {
              clearTimeout(timer);
              resolve(message);
            }
          } catch (error) {
            clearTimeout(timer);
            reject(error);
          }
        });
      });
      socket.send(JSON.stringify({ version: 0, type: 'join', room: 'training-sector', name }));
      await joined;

      const shutdownNotice = new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `No shutdown message received; exit=${child.exitCode}; stdout=${stdout}; stderr=${stderr}`,
              ),
            ),
          5000,
        );
        socket.on('message', (raw) => {
          try {
            const message = JSON.parse(raw.toString());
            if (message.type === 'shutdown') {
              clearTimeout(timer);
              resolve(message);
            }
          } catch (error) {
            clearTimeout(timer);
            reject(error);
          }
        });
      });
      const socketClosed = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WebSocket close timed out.')), 5000);
        socket.once('close', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      return { socket, shutdownNotice, socketClosed };
    }),
  );
  if (process.platform === 'win32') {
    child.stdin.write('shutdown\n');
  } else {
    assert.equal(child.kill('SIGTERM'), true, 'Could not send SIGTERM to production server.');
  }
  const [clientResults, exitCode] = await Promise.all([
    Promise.all(
      sockets.map(async ({ shutdownNotice, socketClosed }) => ({
        notice: await shutdownNotice,
        closeCode: await socketClosed,
      })),
    ),
    waitForExit(child, 10_000, () => `stdout=${stdout}; stderr=${stderr}`),
  ]);
  for (const { notice, closeCode } of clientResults) {
    assert.equal(notice.type, 'shutdown');
    assert.equal(closeCode, 1001);
  }
  assert.equal(exitCode, 0, stderr);
  console.log('Production HTTP/health, WebSocket shutdown, and SIGTERM smoke test passed.');
} finally {
  if (child.exitCode === null) child.kill('SIGKILL');
}

for (const [crash, expectedLog] of [
  ['uncaught-exception', /Uncaught exception/],
  ['unhandled-rejection', /Unhandled promise rejection/],
]) {
  const crashPort = await unusedPort();
  const crashingChild = startServer(crashPort, { crash });
  let crashStderr = '';
  crashingChild.stderr.setEncoding('utf8');
  crashingChild.stderr.on('data', (chunk) => {
    crashStderr += chunk;
  });
  const crashExit = await waitForExit(crashingChild);
  assert.notEqual(crashExit, 0, `${crash} handler must exit with a non-zero status.`);
  assert.match(crashStderr, expectedLog);
  console.log(`Production ${crash} shutdown smoke test passed.`);
}
