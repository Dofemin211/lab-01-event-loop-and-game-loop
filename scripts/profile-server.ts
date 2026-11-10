import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import inspector from 'node:inspector';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PerformanceObserver, performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import { encodeBinary } from '@dogfight/shared/codec';
import { parseServerMessage } from '@dogfight/shared/protocol';
import { createConfig } from '../server/src/config.ts';
import { createApplication } from '../server/src/index.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const durationSeconds = Number(process.env.PROFILE_DURATION_SECONDS ?? 20);
const port = process.env.PROFILE_PORT ?? '3001';
const codec = process.env.PROFILE_CODEC === 'json' ? 'json' : 'binary';
if (!Number.isFinite(durationSeconds) || durationSeconds < 1) {
  throw new RangeError('PROFILE_DURATION_SECONDS must be at least one second.');
}

function bytesOf(data: RawData): number {
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  return data.byteLength;
}

function command(
  session: inspector.Session,
  method: 'Profiler.enable' | 'Profiler.start' | 'HeapProfiler.startSampling',
  params?: inspector.HeapProfiler.StartSamplingParameterType,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (method === 'HeapProfiler.startSampling') {
      session.post(method, params, (error) => (error ? reject(error) : resolve()));
    } else {
      session.post(method, (error) => (error ? reject(error) : resolve()));
    }
  });
}

function stopCpuProfile(session: inspector.Session): Promise<inspector.Profiler.Profile> {
  return new Promise((resolve, reject) => {
    session.post('Profiler.stop', (error, result) =>
      error ? reject(error) : resolve(result.profile),
    );
  });
}

function stopHeapProfile(
  session: inspector.Session,
): Promise<inspector.HeapProfiler.SamplingHeapProfile> {
  return new Promise((resolve, reject) => {
    session.post('HeapProfiler.stopSampling', (error, result) =>
      error ? reject(error) : resolve(result.profile),
    );
  });
}

function cpuHotspots(
  profile: inspector.Profiler.Profile,
): Array<{ function: string; sampleMs: number }> {
  const names = new Map(
    profile.nodes.map((node) => [node.id, node.callFrame.functionName || '(anonymous)']),
  );
  const totals = new Map<string, number>();
  for (const [index, id] of (profile.samples ?? []).entries()) {
    const name = names.get(id) ?? '(unknown)';
    totals.set(name, (totals.get(name) ?? 0) + (profile.timeDeltas?.[index] ?? 0) / 1000);
  }
  return [...totals]
    .map(([name, sampleMs]) => ({ function: name, sampleMs: Number(sampleMs.toFixed(2)) }))
    .sort((a, b) => b.sampleMs - a.sampleMs)
    .slice(0, 15);
}

function heapHotspots(
  profile: inspector.HeapProfiler.SamplingHeapProfile,
): Array<{ function: string; sampledBytes: number }> {
  const totals = new Map<string, number>();
  const visit = (node: inspector.HeapProfiler.SamplingHeapProfileNode): void => {
    const name = node.callFrame.functionName || '(anonymous)';
    totals.set(name, (totals.get(name) ?? 0) + node.selfSize);
    for (const child of node.children) visit(child);
  };
  visit(profile.head);
  return [...totals]
    .map(([name, sampledBytes]) => ({ function: name, sampledBytes }))
    .sort((a, b) => b.sampledBytes - a.sampledBytes)
    .slice(0, 15);
}

const logDir = await mkdtemp(path.join(tmpdir(), 'dogfight-lab07-profile-'));
const config = createConfig({ ...process.env, PORT: port, LOG_DIR: logDir }, ROOT);
const application = createApplication({
  config,
  initialRooms: [
    {
      id: 'profile-sector',
      name: 'Profile sector',
      maxPlayers: Math.min(8, config.maxPlayersPerRoom),
      arena: { asteroidCount: 30, seed: 202507 },
    },
  ],
});
const session = new inspector.Session();
const gcDurations: number[] = [];
const gcObserver = new PerformanceObserver((entries) => {
  for (const entry of entries.getEntries()) gcDurations.push(entry.duration);
});
const sockets: WebSocket[] = [];
let sentBytes = 0;
let receivedBytes = 0;
let serverErrors = 0;
let joined = 0;
try {
  const address = await application.start();
  if (!address || typeof address === 'string') throw new Error('Profile server did not start.');
  const websocketUrl = `ws://${address.address}:${address.port}/ws`;
  const profileSession = session;
  profileSession.connect();
  await command(profileSession, 'Profiler.enable');
  await command(profileSession, 'Profiler.start');
  await command(profileSession, 'HeapProfiler.startSampling', { samplingInterval: 2048 });
  gcObserver.observe({ entryTypes: ['gc'] });
  const cpuBefore = process.cpuUsage();
  const elapsedStartedAt = performance.now();

  const joinedPromise = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Profile clients did not join in time.')),
      10_000,
    );
    for (let index = 0; index < 8; index += 1) {
      const socket = new WebSocket(websocketUrl);
      sockets.push(socket);
      socket.on('message', (data: RawData) => {
        receivedBytes += bytesOf(data);
        const parsed = parseServerMessage(data);
        if (!parsed.success) return;
        if (parsed.data.type === 'joined') {
          joined += 1;
          if (joined === 8) {
            clearTimeout(timeout);
            resolve();
          }
        } else if (parsed.data.type === 'error') {
          serverErrors += 1;
        }
      });
      socket.on('open', () => {
        const message = JSON.stringify({
          version: 0,
          type: 'join',
          room: 'profile-sector',
          name: `Profile-${index}`,
          codec,
        });
        sentBytes += Buffer.byteLength(message);
        socket.send(message);
      });
      socket.on('error', () => {
        serverErrors += 1;
      });
    }
  });
  await joinedPromise;

  const sequences = sockets.map(() => 0);
  const inputTimer = setInterval(() => {
    sockets.forEach((socket, index) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      const seq = (sequences[index] ?? 0) + 1;
      sequences[index] = seq;
      const input = {
        version: 0,
        type: 'input',
        seq,
        tick: seq,
        turn: seq % 90 < 45 ? 1 : -1,
        thrust: true,
        brake: false,
        fire: true,
      };
      if (codec === 'binary') {
        const binaryInput = Buffer.from(encodeBinary(input));
        sentBytes += binaryInput.byteLength;
        socket.send(binaryInput);
      } else {
        const jsonInput = JSON.stringify(input);
        sentBytes += Buffer.byteLength(jsonInput);
        socket.send(jsonInput);
      }
    });
  }, 1000 / 30);

  await delay(durationSeconds * 1000);
  clearInterval(inputTimer);
  const [cpuProfile, heapProfile] = await Promise.all([
    stopCpuProfile(profileSession),
    stopHeapProfile(profileSession),
  ]);
  const elapsedMs = performance.now() - elapsedStartedAt;
  const cpu = process.cpuUsage(cpuBefore);
  gcObserver.disconnect();
  const report = {
    measuredAt: new Date().toISOString(),
    durationSeconds: Number((elapsedMs / 1000).toFixed(2)),
    codec,
    clients: { target: 8, joined, serverErrors },
    trafficBytesPerSecond: {
      serverIncoming: Number((sentBytes / (elapsedMs / 1000)).toFixed(0)),
      serverOutgoing: Number((receivedBytes / (elapsedMs / 1000)).toFixed(0)),
    },
    processCpuPercentOfOneCore: Number(
      (((cpu.user + cpu.system) / (elapsedMs * 1000)) * 100).toFixed(2),
    ),
    eventLoopUtilization: Number(performance.eventLoopUtilization().utilization.toFixed(4)),
    memoryBytes: process.memoryUsage(),
    gc: {
      count: gcDurations.length,
      totalDurationMs: Number(gcDurations.reduce((sum, duration) => sum + duration, 0).toFixed(2)),
    },
    cpuProfile: cpuHotspots(cpuProfile),
    sampledAllocations: heapHotspots(heapProfile),
    limitations: [
      'Node server and scripted WebSocket load clients share one process; CPU and heap data include harness work.',
      'Inspector CPU and heap sampling add profiler overhead; CPU sample time is an estimate, not wall-clock attribution.',
    ],
  };
  await mkdir(path.join(ROOT, 'evidence'), { recursive: true });
  await writeFile(
    path.join(ROOT, 'evidence', 'lab07-profile.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  console.log(JSON.stringify(report, null, 2));
  profileSession.disconnect();
} finally {
  gcObserver.disconnect();
  for (const socket of sockets) socket.close(1000, 'Profile complete.');
  await application.shutdown();
  await rm(logDir, { recursive: true, force: true });
}
