import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { ServerConfig } from './config.ts';

export const WEBSOCKET_REJECTION_REASONS = [
  'origin_rejected',
  'ip_limit_exceeded',
  'invalid_handshake',
  'rate_limited',
  'payload_rejected',
] as const;

export type WebSocketRejectionReason = (typeof WEBSOCKET_REJECTION_REASONS)[number];
export type WebSocketRejectionCounts = Readonly<Record<WebSocketRejectionReason, number>>;

export interface WebSocketSecurityStats {
  readonly activeConnections: number;
  readonly trackedIps: number;
  readonly rejections: WebSocketRejectionCounts;
}

export interface WebSocketTrafficRates {
  readonly receivedMessagesPerSecond: number;
  readonly receivedBytesPerSecond: number;
  readonly sentMessagesPerSecond: number;
  readonly sentBytesPerSecond: number;
}

const MAX_TRACKED_IPS = 10_000;
const TRAFFIC_BUCKETS = 60;

interface TrafficBucket {
  second: number;
  receivedMessages: number;
  receivedBytes: number;
  sentMessages: number;
  sentBytes: number;
}

export class WebSocketSecurityMetrics {
  readonly #rejections: Record<WebSocketRejectionReason, number> = {
    origin_rejected: 0,
    ip_limit_exceeded: 0,
    invalid_handshake: 0,
    rate_limited: 0,
    payload_rejected: 0,
  };
  readonly #startedAt = Math.floor(Date.now() / 1000);
  readonly #traffic: TrafficBucket[] = Array.from({ length: TRAFFIC_BUCKETS }, () => ({
    second: -1,
    receivedMessages: 0,
    receivedBytes: 0,
    sentMessages: 0,
    sentBytes: 0,
  }));

  recordRejection(reason: WebSocketRejectionReason): void {
    this.#rejections[reason] += 1;
  }

  recordReceived(bytes: number): void {
    const bucket = this.#currentTrafficBucket();
    bucket.receivedMessages += 1;
    bucket.receivedBytes += bytes;
  }

  recordSent(bytes: number): void {
    const bucket = this.#currentTrafficBucket();
    bucket.sentMessages += 1;
    bucket.sentBytes += bytes;
  }

  trafficRates(): WebSocketTrafficRates {
    const now = Math.floor(Date.now() / 1000);
    const elapsedSeconds = Math.max(1, Math.min(TRAFFIC_BUCKETS, now - this.#startedAt + 1));
    const totals = this.#traffic.reduce(
      (result, bucket) => {
        if (bucket.second < now - TRAFFIC_BUCKETS + 1 || bucket.second > now) return result;
        result.receivedMessages += bucket.receivedMessages;
        result.receivedBytes += bucket.receivedBytes;
        result.sentMessages += bucket.sentMessages;
        result.sentBytes += bucket.sentBytes;
        return result;
      },
      { receivedMessages: 0, receivedBytes: 0, sentMessages: 0, sentBytes: 0 },
    );
    return {
      receivedMessagesPerSecond: totals.receivedMessages / elapsedSeconds,
      receivedBytesPerSecond: totals.receivedBytes / elapsedSeconds,
      sentMessagesPerSecond: totals.sentMessages / elapsedSeconds,
      sentBytesPerSecond: totals.sentBytes / elapsedSeconds,
    };
  }

  snapshot(activeConnections: number, trackedIps: number): WebSocketSecurityStats {
    return {
      activeConnections,
      trackedIps,
      rejections: { ...this.#rejections },
    };
  }

  #currentTrafficBucket(): TrafficBucket {
    const second = Math.floor(Date.now() / 1000);
    const bucket = this.#traffic[second % TRAFFIC_BUCKETS];
    if (!bucket) throw new Error('WebSocket traffic bucket is unavailable.');
    if (bucket.second !== second) {
      bucket.second = second;
      bucket.receivedMessages = 0;
      bucket.receivedBytes = 0;
      bucket.sentMessages = 0;
      bucket.sentBytes = 0;
    }
    return bucket;
  }
}

export class ActiveConnectionLimiter {
  readonly maxConnectionsPerIp: number;
  readonly maxTrackedIps: number;
  readonly #activeByIp = new Map<string, number>();
  #activeConnections = 0;

  constructor(maxConnectionsPerIp: number, maxTrackedIps = MAX_TRACKED_IPS) {
    if (!Number.isInteger(maxConnectionsPerIp) || maxConnectionsPerIp < 1) {
      throw new RangeError('The per-IP connection limit must be a positive integer.');
    }
    if (!Number.isInteger(maxTrackedIps) || maxTrackedIps < 1) {
      throw new RangeError('The tracked IP limit must be a positive integer.');
    }
    this.maxConnectionsPerIp = maxConnectionsPerIp;
    this.maxTrackedIps = maxTrackedIps;
  }

  get activeConnections(): number {
    return this.#activeConnections;
  }

  get trackedIps(): number {
    return this.#activeByIp.size;
  }

  reserve(ip: string): (() => void) | null {
    const activeForIp = this.#activeByIp.get(ip) ?? 0;
    if (
      activeForIp >= this.maxConnectionsPerIp ||
      (activeForIp === 0 && this.#activeByIp.size >= this.maxTrackedIps)
    ) {
      return null;
    }
    this.#activeByIp.set(ip, activeForIp + 1);
    this.#activeConnections += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.#activeByIp.get(ip);
      if (current === undefined) return;
      if (current <= 1) {
        this.#activeByIp.delete(ip);
      } else {
        this.#activeByIp.set(ip, current - 1);
      }
      this.#activeConnections -= 1;
    };
  }
}

export function normalizeIpAddress(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const version = isIP(trimmed);
  if (version === 0) return null;
  if (version === 4) return trimmed;
  let canonical = trimmed.toLowerCase();
  try {
    canonical = new URL(`http://[${trimmed}]/`).hostname.slice(1, -1).toLowerCase();
  } catch {
    return canonical;
  }
  if (canonical.startsWith('::ffff:')) {
    const mappedWords = canonical
      .slice('::ffff:'.length)
      .split(':')
      .map((word) => Number.parseInt(word, 16));
    if (mappedWords.length === 2 && mappedWords.every(Number.isFinite)) {
      const high = mappedWords[0];
      const low = mappedWords[1];
      if (high !== undefined && low !== undefined) {
        return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
      }
    }
  }
  return canonical;
}

export function resolveClientIp(request: IncomingMessage, config: ServerConfig): string | null {
  const peerIp = normalizeIpAddress(request.socket.remoteAddress);
  if (!peerIp) return null;
  const trustedProxyIps = new Set(
    config.trustedProxyIps.map((address) => normalizeIpAddress(address)).filter(isString),
  );
  if (!trustedProxyIps.has(peerIp)) return peerIp;

  const forwardedFor = request.headers['x-forwarded-for'];
  if (typeof forwardedFor !== 'string') return peerIp;
  const chain = forwardedFor.split(',').map((address) => normalizeIpAddress(address));
  if (chain.length === 0 || chain.some((address) => address === null)) return peerIp;

  for (const address of chain.reverse()) {
    if (address && !trustedProxyIps.has(address)) return address;
  }
  return peerIp;
}

export function isAllowedWebSocketOrigin(
  origin: string | undefined,
  requestHost: string | undefined,
  config: ServerConfig,
): boolean {
  if (origin === undefined) return config.nodeEnv !== 'production';
  const parsedOrigin = parseHttpOrigin(origin);
  if (!parsedOrigin) return false;
  if (config.allowedOrigins.includes(parsedOrigin)) return true;
  if (config.nodeEnv === 'production') return false;
  return isLocalDevelopmentOrigin(parsedOrigin, requestHost);
}

export function hasSingleOriginHeader(request: IncomingMessage): boolean {
  let occurrences = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === 'origin') occurrences += 1;
  }
  return occurrences <= 1;
}

function parseHttpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.origin === 'null' ||
      url.origin !== value
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function isLocalDevelopmentOrigin(origin: string, requestHost: string | undefined): boolean {
  if (!requestHost || !origin.startsWith('http://')) return false;
  const host = requestHost.toLowerCase();
  if (
    !host.startsWith('localhost:') &&
    host !== 'localhost' &&
    !host.startsWith('127.0.0.1:') &&
    host !== '127.0.0.1' &&
    !host.startsWith('[::1]:') &&
    host !== '[::1]'
  ) {
    return false;
  }
  return origin === `http://${host}`;
}

function isString(value: string | null): value is string {
  return value !== null;
}
