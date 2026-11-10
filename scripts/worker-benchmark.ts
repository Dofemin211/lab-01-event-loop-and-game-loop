import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import type { ShipState } from '@dogfight/shared/sim';
import { integrate } from '@dogfight/shared/sim';

const steps = Number(process.env.WORKER_STEPS ?? 250_000);
const runs = Number(process.env.WORKER_RUNS ?? 5);
if (!Number.isInteger(steps) || steps < 1 || !Number.isInteger(runs) || runs < 1) {
  throw new RangeError('WORKER_STEPS and WORKER_RUNS must be positive integers.');
}

const initialState: ShipState = {
  x: 480,
  y: 300,
  vx: 0,
  vy: 0,
  angle: -Math.PI / 2,
  thrust: 0,
};
const controls = {
  isDown: (code: string) => code === 'KeyW' || code === 'ArrowRight',
};

function runOnMainThread(): ShipState {
  let state = initialState;
  for (let index = 0; index < steps; index += 1) {
    state = integrate(state, controls, 1 / 60);
  }
  return state;
}

const workerStartedAt = performance.now();
const worker = new Worker(fileURLToPath(new URL('./world-worker.ts', import.meta.url)), {
  execArgv: ['--experimental-strip-types'],
});
const startupMs = await new Promise<number>((resolve, reject) => {
  worker.once('online', () => resolve(performance.now() - workerStartedAt));
  worker.once('error', reject);
});

function runOnWorker(): Promise<ShipState> {
  return new Promise((resolve, reject) => {
    const handleMessage = (state: ShipState): void => {
      worker.off('error', handleError);
      resolve(state);
    };
    const handleError = (error: Error): void => {
      worker.off('message', handleMessage);
      reject(error);
    };
    worker.once('message', handleMessage);
    worker.once('error', handleError);
    worker.postMessage({ state: initialState, steps });
  });
}

const mainTimes: number[] = [];
const workerTimes: number[] = [];
let mainResult: ShipState = initialState;
let workerResult: ShipState = initialState;
let workerKeepsEventLoopResponsive = false;
let coldRunMs: number;
try {
  const coldRunStartedAt = performance.now();
  const coldResult = await runOnWorker();
  coldRunMs = performance.now() - coldRunStartedAt;
  assert.deepEqual(coldResult, runOnMainThread());

  for (let run = 0; run < runs; run += 1) {
    const mainStartedAt = performance.now();
    mainResult = runOnMainThread();
    mainTimes.push(performance.now() - mainStartedAt);

    let eventLoopTurnCompleted = false;
    setImmediate(() => {
      eventLoopTurnCompleted = true;
    });
    const workerStarted = performance.now();
    workerResult = await runOnWorker();
    workerTimes.push(performance.now() - workerStarted);
    workerKeepsEventLoopResponsive ||= eventLoopTurnCompleted;
  }
  assert.deepEqual(workerResult, mainResult);
} finally {
  await worker.terminate();
}

const summary = {
  workload: { stepsPerRun: steps, runs, input: 'fixed thrust and turn, 1/60 s per step' },
  mainThread: {
    averageMs: Number((mainTimes.reduce((sum, value) => sum + value, 0) / runs).toFixed(3)),
    samplesMs: mainTimes.map((value) => Number(value.toFixed(3))),
  },
  workerRoundTrip: {
    startupMs: Number(startupMs.toFixed(3)),
    coldRunMs: Number(coldRunMs.toFixed(3)),
    averageMs: Number((workerTimes.reduce((sum, value) => sum + value, 0) / runs).toFixed(3)),
    samplesMs: workerTimes.map((value) => Number(value.toFixed(3))),
  },
  equivalentResult: true,
  mainThreadResponsiveDuringWorkerWork: workerKeepsEventLoopResponsive,
  decision:
    workerTimes.reduce((sum, value) => sum + value, 0) / runs <
    mainTimes.reduce((sum, value) => sum + value, 0) / runs
      ? 'Worker round-trip was faster for this batch; this is not sufficient alone to justify moving the live world across the worker boundary.'
      : 'Worker round-trip overhead exceeded the main-thread batch; keep the live simulation on the main thread.',
  limitations: [
    'This isolated benchmark repeatedly integrates one ship; it excludes collision detection, rendering, and full world snapshot transfer.',
    'The worker is an experiment only and is not used by the game runtime.',
  ],
};
console.log(JSON.stringify(summary, null, 2));
