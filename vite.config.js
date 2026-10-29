import { defineConfig } from 'vite';

function lab03FailureRoutes() {
  return {
    name: 'lab03-development-failure-routes',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        if (pathname === '/api/dev/slow.json') {
          setTimeout(() => {
            if (!response.destroyed) {
              response.writeHead(200, { 'Content-Type': 'application/json' });
              response.end('{"width":960,"height":600,"asteroidCount":6}');
            }
          }, 1500);
          return;
        }
        if (pathname === '/api/dev/missing-sprites.svg') {
          response.writeHead(404, { 'Content-Type': 'text/plain' });
          response.end('Sprite sheet deliberately missing for the Lab 03 failure test.');
          return;
        }
        if (pathname === '/api/dev/corrupt.json') {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end('{"arena":');
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [lab03FailureRoutes()],
});
