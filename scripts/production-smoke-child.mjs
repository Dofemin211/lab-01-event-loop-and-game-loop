import {
  createApplication,
  installProcessHandlers,
} from '../dist/server-runtime/server/src/index.js';

const application = createApplication();
await application.start();
installProcessHandlers(application);

process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  if (data.includes('shutdown')) {
    process.stdin.pause();
    process.stdin.unref?.();
    process.emit('SIGTERM');
  }
});
