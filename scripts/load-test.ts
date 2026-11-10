import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import { z } from 'zod';

const MatchStatsSchema = z.array(
  z.object({
    roomId: z.string(),
    lastTickDurationMs: z.number().finite(),
    tickDurationPercentilesMs: z.object({ p50: z.number(), p95: z.number(), p99: z.number() }),
  }),
);
const PerformanceSchema = z.object({
  elapsedMs: z.number().finite().nonnegative(),
  cpuUserMs: z.number().finite().nonnegative(),
  cpuSystemMs: z.number().finite().nonnegative(),
  cpuPercentOfOneCore: z.number().finite().nonnegative(),
  eventLoopActiveMs: z.number().finite().nonnegative(),
  eventLoopIdleMs: z.number().finite().nonnegative(),
  eventLoopUtilization: z.number().finite().min(0).max(1),
  memoryBytes: z.object({
    rss: z.number().int().nonnegative(),
    heapUsed: z.number().int().nonnegative(),
  }),
});

interface Traffic {
  receivedBytes: number;
  sentBytes: number;
  joined: number;
  rejected: number;
  transportErrors: number;
}

type ScenarioResult = Awaited<ReturnType<typeof runScenario>>;

function bytesOf(data: RawData): number {
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  return data.byteLength;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? (sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0) : 0;
}

function average(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

async function readJson<Value>(
  baseUrl: string,
  pathname: string,
  schema: z.ZodType<Value>,
  init?: RequestInit,
): Promise<Value> {
  const response = await fetch(new URL(pathname, baseUrl), init);
  const data: unknown = await response.json();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${pathname}: ${JSON.stringify(data)}`);
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new Error(`Invalid ${pathname} response: ${parsed.error.message}`);
  return parsed.data;
}

async function createRooms(baseUrl: string, count: number, scenario: number): Promise<string[]> {
  const roomIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const result = await readJson(
      baseUrl,
      '/api/rooms',
      z.object({ room: z.object({ id: z.string() }) }),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Load test ${scenario}-${index}`,
          maxPlayers: 8,
          arena: { asteroidCount: 30, seed: scenario * 1000 + index },
        }),
      },
    );
    roomIds.push(result.room.id);
  }
  return roomIds;
}

async function runScenario(
  baseUrl: string,
  clientCount: number,
  durationSeconds: number,
  id: number,
) {
  const roomIds = await createRooms(baseUrl, Math.ceil(clientCount / 8), id);
  const traffic: Traffic = {
    receivedBytes: 0,
    sentBytes: 0,
    joined: 0,
    rejected: 0,
    transportErrors: 0,
  };
  const sockets: WebSocket[] = [];
  const sequence = new Map<WebSocket, number>();
  const roomForSocket = new Map<WebSocket, string>();
  let joinedSignal = (): void => {};
  const allJoined = new Promise<void>((resolve) => {
    joinedSignal = resolve;
  });
  const joinedSet = new Set<WebSocket>();

  for (let index = 0; index < clientCount; index += 1) {
    const socket = new WebSocket(new URL('/ws', baseUrl.replace(/^http/, 'ws')));
    const roomId = roomIds[Math.floor(index / 8)];
    if (!roomId) throw new Error('Load-test room assignment is missing.');
    sockets.push(socket);
    sequence.set(socket, 0);
    roomForSocket.set(socket, roomId);
    socket.on('message', (data: RawData) => {
      traffic.receivedBytes += bytesOf(data);
      let payload: unknown;
      try {
        payload = JSON.parse(data.toString());
      } catch {
        traffic.rejected += 1;
        return;
      }
      if (typeof payload !== 'object' || payload === null || !('type' in payload)) return;
      if (payload.type === 'joined') {
        traffic.joined += 1;
        joinedSet.add(socket);
        if (joinedSet.size === clientCount) joinedSignal();
      } else if (payload.type === 'error') {
        traffic.rejected += 1;
      }
    });
    socket.on('error', () => {
      traffic.transportErrors += 1;
    });
  }

  const opened = await Promise.all(
    sockets.map(
      (socket) =>
        new Promise<void>((resolve, reject) => {
          socket.once('open', () => resolve());
          socket.once('error', reject);
        }),
    ),
  ).then(
    () => true,
    () => false,
  );
  if (!opened)
    traffic.transportErrors += sockets.filter(
      (socket) => socket.readyState !== WebSocket.OPEN,
    ).length;

  for (const [index, socket] of sockets.entries()) {
    if (socket.readyState !== WebSocket.OPEN) continue;
    const roomId = roomForSocket.get(socket);
    if (!roomId) continue;
    const join = JSON.stringify({
      version: 0,
      type: 'join',
      room: roomId,
      name: `Load-${id}-${index}`,
      codec: 'json',
    });
    traffic.sentBytes += Buffer.byteLength(join);
    socket.send(join);
  }

  const joinTimeout = setTimeout(() => joinedSignal(), 10_000);
  await allJoined;
  clearTimeout(joinTimeout);
  const baseline = await readJson(baseUrl, '/api/performance', PerformanceSchema);
  const tickSamples: number[] = [];
  const roomP99Samples: number[] = [];
  const cpuSamples: number[] = [];
  const eluSamples: number[] = [];
  const rssSamples: number[] = [];
  let previousPerformance = baseline;

  const inputTimer = setInterval(() => {
    for (const socket of sockets) {
      if (socket.readyState !== WebSocket.OPEN || !joinedSet.has(socket)) continue;
      const seq = (sequence.get(socket) ?? 0) + 1;
      sequence.set(socket, seq);
      const input = JSON.stringify({
        version: 0,
        type: 'input',
        seq,
        tick: seq,
        turn: seq % 90 < 45 ? 1 : -1,
        thrust: true,
        brake: false,
        fire: true,
      });
      traffic.sentBytes += Buffer.byteLength(input);
      socket.send(input);
    }
  }, 1000 / 30);

  const sampleTimer = setInterval(() => {
    void sample();
  }, 1000);
  async function sample(): Promise<void> {
    const [stats, current] = await Promise.all([
      readJson(baseUrl, '/api/stats', MatchStatsSchema),
      readJson(baseUrl, '/api/performance', PerformanceSchema),
    ]);
    for (const match of stats) {
      if (roomIds.includes(match.roomId)) {
        tickSamples.push(match.lastTickDurationMs);
        roomP99Samples.push(match.tickDurationPercentilesMs.p99);
      }
    }
    const elapsed = current.elapsedMs - previousPerformance.elapsedMs;
    const cpu =
      current.cpuUserMs +
      current.cpuSystemMs -
      previousPerformance.cpuUserMs -
      previousPerformance.cpuSystemMs;
    const active = current.eventLoopActiveMs - previousPerformance.eventLoopActiveMs;
    const idle = current.eventLoopIdleMs - previousPerformance.eventLoopIdleMs;
    if (elapsed > 0) cpuSamples.push((cpu / elapsed) * 100);
    if (active + idle > 0) eluSamples.push(active / (active + idle));
    rssSamples.push(current.memoryBytes.rss);
    previousPerformance = current;
  }

  const workloadStartedAt = performance.now();
  await delay(durationSeconds * 1000);
  clearInterval(inputTimer);
  clearInterval(sampleTimer);
  await sample();
  const elapsedSeconds = (performance.now() - workloadStartedAt) / 1000;
  const closes = sockets.map(
    (socket) =>
      new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        socket.once('close', () => resolve());
        socket.close(1000, 'Load-test completed.');
      }),
  );
  await Promise.race([Promise.all(closes), delay(2000)]);
  for (const socket of sockets) {
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }

  return {
    clients: clientCount,
    rooms: roomIds.length,
    joined: traffic.joined,
    rejectedMessages: traffic.rejected,
    transportErrors: traffic.transportErrors,
    durationSeconds: Number(elapsedSeconds.toFixed(2)),
    serverTrafficBytesPerSecond: {
      incoming: Number((traffic.sentBytes / elapsedSeconds).toFixed(0)),
      outgoing: Number((traffic.receivedBytes / elapsedSeconds).toFixed(0)),
    },
    serverTickDurationMs: {
      samples: tickSamples.length,
      p50: Number(percentile(tickSamples, 0.5).toFixed(4)),
      p95: Number(percentile(tickSamples, 0.95).toFixed(4)),
      p99: Number(percentile(tickSamples, 0.99).toFixed(4)),
      max: Number(Math.max(0, ...tickSamples).toFixed(4)),
      worstRoomRollingP99: Number(Math.max(0, ...roomP99Samples).toFixed(4)),
    },
    serverCpuPercentOfOneCore: {
      average: Number(average(cpuSamples).toFixed(2)),
      max: Number(Math.max(0, ...cpuSamples).toFixed(2)),
    },
    serverEventLoopUtilization: Number(average(eluSamples).toFixed(4)),
    serverRssMiB: {
      average: Number((average(rssSamples) / (1024 * 1024)).toFixed(2)),
      max: Number((Math.max(0, ...rssSamples) / (1024 * 1024)).toFixed(2)),
    },
  };
}

const baseUrl = process.env.LOAD_BASE_URL ?? 'http://127.0.0.1:3000';
const durationSeconds = Number(process.env.LOAD_DURATION_SECONDS ?? 10);
const clientCounts = (process.env.LOAD_CLIENT_COUNTS ?? '8,32,64,128').split(',').map(Number);
if (
  !Number.isFinite(durationSeconds) ||
  durationSeconds < 1 ||
  !clientCounts.length ||
  clientCounts.some((count) => !Number.isInteger(count) || count < 1 || count > 400)
) {
  throw new RangeError('Set valid LOAD_DURATION_SECONDS and comma-separated LOAD_CLIENT_COUNTS.');
}

const results: ScenarioResult[] = [];
for (const [index, count] of clientCounts.entries()) {
  const result = await runScenario(baseUrl, count, durationSeconds, index + 1);
  results.push(result);
  console.log(JSON.stringify(result));
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await writeFile(
  path.join(root, 'evidence', 'lab07-load.json'),
  `${JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      host: {
        platform: process.platform,
        architecture: process.arch,
        cpu: os.cpus()[0]?.model ?? 'unknown',
        logicalCores: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
      },
      durationSecondsPerScenario: durationSeconds,
      scenarios: results,
    },
    null,
    2,
  )}\n`,
  'utf8',
);
