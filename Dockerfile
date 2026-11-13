FROM node:22.23.5-alpine3.23@sha256:6868d4695b947ee120bffaa463fecd68cde370d7bfec92955e7c8ac576b4f475 AS build

WORKDIR /workspace
COPY package.json package-lock.json ./
COPY client/package.json ./client/package.json
COPY server/package.json ./server/package.json
COPY shared/package.json ./shared/package.json
RUN npm ci

COPY . .
ARG APP_VERSION=1.0.0
ARG GIT_SHA=unknown
ENV APP_VERSION=${APP_VERSION} GIT_SHA=${GIT_SHA}
RUN npm run build

FROM node:22.23.5-alpine3.23@sha256:6868d4695b947ee120bffaa463fecd68cde370d7bfec92955e7c8ac576b4f475 AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    APP_ROOT=/app \
    LOG_DIR=/data/logs \
    NODE_OPTIONS=--max-old-space-size=384
WORKDIR /app

COPY package.json package-lock.json ./
COPY client/package.json ./client/package.json
COPY server/package.json ./server/package.json
COPY shared/package.json ./shared/package.json
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /workspace/dist/server-runtime ./dist/server-runtime
COPY --from=build /workspace/client/dist ./client/dist
COPY --from=build /workspace/scripts/production-env.mjs ./scripts/production-env.mjs
RUN mkdir -p /data/logs \
    && chown -R node:node /data /app

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "--import", "./scripts/production-env.mjs", "dist/server-runtime/server/src/index.js"]
