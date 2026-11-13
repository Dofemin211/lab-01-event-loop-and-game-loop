# Production deployment runbook

## Status and recommendation

This repository contains a single-instance Docker Compose deployment for a Hetzner Cloud VPS. No server, DNS record, registry package, monitoring account, or public URL has been created from this workspace. Docker and Linux are unavailable in the current Windows environment, so the image, Compose stack, TLS, and real container signal handling are not locally verified.

Hetzner Cloud is the recommended next step: it provides a persistent VM, Docker support, static networking, and EU locations such as Nuremberg or Falkenstein. A small shared-vCPU x86 instance is a practical starting point; choose a size only after checking current pricing and monitoring actual memory/CPU use. Fly.io is a reasonable alternative with managed HTTPS and WebSocket-capable Machines, but its edge proxy and forwarded-IP chain require careful integration with this application's explicit trusted-proxy allowlist. Both providers' pricing and product details can change; compare their current official pages before creating resources:

- [Hetzner Cloud](https://www.hetzner.com/cloud/)
- [Fly.io Machines](https://fly.io/docs/machines/)

The room manager and match simulation are in-memory. Run exactly one application instance; a restart ends active matches. The Compose file keeps Caddy and the application on one Docker network and runs one application container.

## One-time provider setup

1. Create a Hetzner Cloud account and a single Ubuntu LTS x86 VPS in an EU region. This is a manual, potentially billable action; select the smallest server that meets the resource limits after checking current prices.
2. Add an SSH public key at server creation. Configure a firewall to allow SSH only from your management IP where possible, and allow inbound TCP 80 and 443. Do not expose port 8080.
3. Point the domain's `A` record to the server's public IPv4. Add an `AAAA` record only if IPv6 routing and firewall access have also been configured.
4. Supply `deploy/hetzner-cloud-init.yaml` as cloud-init user data, or install Docker Engine and the Compose plugin from Docker's official instructions. The cloud-init file is preparation only; its initial package installation requires internet access.
5. On the server, create a private deployment directory and copy `compose.yaml` and `deploy/Caddyfile` into it. Create a private `.env` from `.env.example`; do not commit or upload this file to GitHub. Set:

   ```dotenv
   IMAGE_NAME=ghcr.io/dofemin211/lab-01-event-loop-and-game-loop
   IMAGE_TAG=<a published full commit SHA>
   DOMAIN=<your DNS name>
   HTTPS_URL=https://<your DNS name>
   HTTP_BIND_PORT=80
   CADDY_HTTP_PORT=80
   HTTPS_BIND_PORT=443
   CADDY_HTTPS_PORT=443
   ALLOWED_ORIGINS=https://<your DNS name>
   LOG_LEVEL=info
   MAX_CONNECTIONS_PER_IP=100
   MAX_ROOMS=50
   MAX_PLAYERS_PER_ROOM=8
   ```

   Keep the app's `TRUSTED_PROXY_IPS=172.30.0.2` setting from `compose.yaml`: it trusts only the statically assigned Caddy container. Caddy replaces `X-Forwarded-For` with the immediate peer address. Do not trust an arbitrary internet address or forwarded header.

6. Publish a verified release through the `Release` workflow. GHCR packages may be private by default. Either make the package public after reviewing its contents, or authenticate the VPS to GHCR with a narrowly scoped, read-only package token. Store that token only in the server's Docker credential store, never in this repository or the deployment workflow.
7. Pull and start the pinned release:

   ```sh
   docker login ghcr.io
   docker compose pull
   docker compose up -d --wait --wait-timeout 120
   docker compose ps
   ```

   Caddy obtains and renews HTTPS certificates automatically when public DNS and ports 80/443 are correct. Verify `https://<your DNS name>/health` and `/ready`; then test the game and WebSocket connection from a separate network.

The app container has a 512 MiB memory limit and one-CPU limit, runs as its non-root Node user, and receives `SIGTERM` directly via Docker's exec-form command. It has a named volume for match logs. Caddy has persistent data/config volumes for TLS state. Compose uses `unless-stopped`; do not scale the `dogfight` service.

## Optional tag-triggered deployment

The release workflow verifies the tag commit is already on `main`, runs the full quality/test/build suite, checks the built image is below 200 MiB, and publishes version and full commit-SHA image tags to GHCR. It does not publish on pull requests.

To opt into remote updates after manual setup:

1. Create a dedicated deploy SSH key and install its public key for the server's deployment user. Grant that user access to the private deployment directory and Docker. Membership in the `docker` group is effectively root-equivalent; use a dedicated account and keep the private key protected.
2. Add repository secret `DEPLOY_SSH_PRIVATE_KEY` (private key contents), `DEPLOY_HOST` (DNS name or IP), and `DEPLOY_USER`.
3. Add repository variable `DEPLOY_KNOWN_HOSTS` containing the server's verified SSH host-key line. Obtain and verify the host key through a trusted channel; do not generate this value blindly with `ssh-keyscan` in the workflow.
4. Add repository variables `DEPLOY_ENABLED=true` and `DEPLOY_PATH` (absolute directory containing the server's `compose.yaml` and private `.env`).
5. Confirm the VPS is already authenticated to GHCR if the package is private. The workflow updates only the `dogfight` service using the commit-SHA image tag and waits for its health check.

Without those manual secrets and variables, the deploy job is skipped. Do not enable it until the first release has been tested manually.

## Reverse proxy, WebSocket, and reconnect

Caddy redirects HTTP to HTTPS, proxies normal HTTP and WebSocket upgrades to the Node process, and sets the forwarded client address to its socket peer. The Node application trusts only Caddy's fixed Compose-network IP; without a trusted proxy, it uses the immediate socket address and ignores `X-Forwarded-For`. Its production Origin allowlist must exactly match the browser origin (scheme, hostname, and port), for example `https://game.example.com`.

The server's default WebSocket heartbeat is 15 seconds. Caddy's WebSocket reverse proxy does not impose an application-level idle timeout in this configuration; keep any future proxy/load-balancer idle timeout comfortably above the heartbeat interval. On disconnect, clients can reconnect and rejoin as a new session. They cannot recover the former player identity, room process state, or an interrupted match after server restart.

## Health, metrics, and uptime

- Check `GET /health` once per minute with an uptime service; it is a liveness check and reports app version/build SHA.
- `GET /ready` returns 503 during drain/shutdown and is used by container health checks.
- `GET /metrics` is Prometheus text format with fixed reason labels and no IP labels. Treat it as operational information; if the host becomes public, restrict metrics access at the proxy/firewall or add authenticated scraping before relying on it externally.
- JSON process logs go to stdout/stderr. Match/replay NDJSON files are stored in the `match-logs` Docker volume; periodically export/rotate that volume if the evidence must survive instance loss.
- Configure alerts for repeated health-check failures, low disk space, container restart loops, sustained memory pressure, and high tick p99. The application does not currently send errors to a hosted error-tracking service.

For uptime monitoring, configure the provider/service to request the public `/health` endpoint every 60 seconds and alert after several consecutive failures. Do not put credentials in the monitored URL. This is a setup instruction only; no monitor or external service has been configured.

## Rollback and operational limits

Pin `IMAGE_TAG` to a published commit SHA, not `latest`. To roll back, change `IMAGE_TAG` in the server's private `.env` to the previous verified SHA, then run `docker compose pull dogfight` and `docker compose up -d --no-deps --wait dogfight`. A restart drops all in-memory rooms and matches. Match logs are persisted, but they are not a state-restoration mechanism.

The Dockerfile and Compose configuration have not been built or started in the current environment because Docker is unavailable. Before inviting players, complete the container checks in CI or on a Linux host: verify the actual image size, non-root UID, container health, WebSocket through Caddy, certificate issuance, restart behavior, and `SIGTERM` close code/message with a real client.
