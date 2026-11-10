import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viteEntrypoint = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const children = [
  spawn(process.execPath, ['--env-file-if-exists=.env', '--watch', 'server/src/index.js'], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'development' },
    stdio: 'inherit',
  }),
  spawn(process.execPath, [viteEntrypoint], {
    cwd: path.join(root, 'client'),
    env: { ...process.env, NODE_ENV: 'development' },
    stdio: 'inherit',
  }),
];

let stopping = false;

function stopChildren(exitCode = 0) {
  if (stopping) {
    return;
  }
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGTERM');
    }
  }
  Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
          } else {
            child.once('exit', resolve);
          }
        }),
    ),
  ).then(() => process.exit(exitCode));
  setTimeout(() => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }
  }, 5000).unref();
}

for (const child of children) {
  child.on('error', (error) => {
    console.error('Could not start a development process:', error.message);
    stopChildren(1);
  });
  child.on('exit', (code) => {
    if (!stopping) {
      stopChildren(code ?? 1);
    }
  });
}

process.once('SIGINT', () => stopChildren(0));
process.once('SIGTERM', () => stopChildren(0));
