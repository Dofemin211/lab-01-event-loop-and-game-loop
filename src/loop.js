const MAX_FRAME_DELTA = 0.25;
const METRICS_INTERVAL_MS = 1000;
const INTERVAL_DELAY_MS = 16;
const MAX_INTERVAL_SAMPLES = 120;

function standardDeviation(values) {
  if (values.length < 2) {
    return 0;
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const squaredDifferences = values.map((value) => (value - mean) ** 2);
  return Math.sqrt(squaredDifferences.reduce((sum, value) => sum + value, 0) / values.length);
}

export function createLoop({
  step = 1 / 60,
  simulate,
  render,
  scheduler = 'raf',
  variableTimestep = false,
  clock = () => performance.now(),
  requestFrame = (callback) => requestAnimationFrame(callback),
  cancelFrame = (id) => cancelAnimationFrame(id),
  setIntervalFn = (callback, delay) => globalThis.setInterval(callback, delay),
  clearIntervalFn = (id) => globalThis.clearInterval(id),
}) {
  if (typeof simulate !== 'function' || typeof render !== 'function') {
    throw new TypeError('createLoop requires simulate and render functions.');
  }
  if (!Number.isFinite(step) || step <= 0) {
    throw new RangeError('The simulation step must be a positive finite number.');
  }
  if (scheduler !== 'raf' && scheduler !== 'interval') {
    throw new RangeError('The scheduler must be "raf" or "interval".');
  }

  let running = false;
  let animationId = null;
  let intervalId = null;
  let previousFrameTime = null;
  let accumulator = 0;
  let totalSteps = 0;
  let totalFrames = 0;
  let windowSteps = 0;
  let windowFrames = 0;
  let metricsWindowStart = null;
  let previousMetricsTimestamp = null;
  let recentIntervals = [];
  let lastFrameDurationMs = 0;
  let stats = {
    simulationStepsPerSecond: 0,
    renderedFramesPerSecond: 0,
    frameTimeMs: 0,
    frameIntervalMs: 0,
    frameTimeJitterMs: 0,
  };

  function getMetrics() {
    return { ...stats, totalSteps, totalFrames };
  }

  function updateMetrics(timestamp, frameDuration) {
    if (previousMetricsTimestamp !== null) {
      const interval = Math.max(0, timestamp - previousMetricsTimestamp);
      stats.frameIntervalMs = interval;
      recentIntervals.push(interval);
      if (recentIntervals.length > MAX_INTERVAL_SAMPLES) {
        recentIntervals = recentIntervals.slice(-MAX_INTERVAL_SAMPLES);
      }
      stats.frameTimeJitterMs = standardDeviation(recentIntervals);
    }

    previousMetricsTimestamp = timestamp;
    lastFrameDurationMs = frameDuration;
    stats.frameTimeMs = lastFrameDurationMs;

    if (metricsWindowStart === null) {
      metricsWindowStart = timestamp;
    }
    const windowDuration = timestamp - metricsWindowStart;
    if (windowDuration >= METRICS_INTERVAL_MS) {
      stats.simulationStepsPerSecond = (windowSteps * 1000) / windowDuration;
      stats.renderedFramesPerSecond = (windowFrames * 1000) / windowDuration;
      windowSteps = 0;
      windowFrames = 0;
      metricsWindowStart = timestamp;
    }
  }

  function frame(timestamp) {
    if (!running) {
      return;
    }

    const frameStartedAt = clock();
    const elapsed =
      previousFrameTime === null ? 0 : Math.max(0, (timestamp - previousFrameTime) / 1000);
    previousFrameTime = timestamp;
    const frameDelta = Math.min(elapsed, MAX_FRAME_DELTA);

    if (variableTimestep) {
      if (frameDelta > 0) {
        simulate(frameDelta);
        totalSteps += 1;
        windowSteps += 1;
      }
      accumulator = 0;
    } else {
      // The clamp prevents a long pause from demanding an unbounded catch-up burst.
      accumulator += frameDelta;
      while (accumulator >= step) {
        simulate(step);
        accumulator -= step;
        totalSteps += 1;
        windowSteps += 1;
      }
    }

    totalFrames += 1;
    windowFrames += 1;
    render(variableTimestep ? 0 : accumulator / step, getMetrics());
    const frameDuration = Math.max(0, clock() - frameStartedAt);
    updateMetrics(timestamp, frameDuration);

    if (!running) {
      return;
    }
    if (scheduler === 'raf') {
      animationId = requestFrame(frame);
    }
  }

  function start() {
    if (running) {
      return;
    }

    running = true;
    previousFrameTime = null;
    accumulator = 0;
    windowSteps = 0;
    windowFrames = 0;
    metricsWindowStart = null;
    previousMetricsTimestamp = null;
    recentIntervals = [];
    stats = {
      simulationStepsPerSecond: 0,
      renderedFramesPerSecond: 0,
      frameTimeMs: 0,
      frameIntervalMs: 0,
      frameTimeJitterMs: 0,
    };

    if (scheduler === 'raf') {
      animationId = requestFrame(frame);
    } else {
      intervalId = setIntervalFn(() => frame(clock()), INTERVAL_DELAY_MS);
    }
  }

  function stop() {
    if (!running) {
      return;
    }

    running = false;
    if (animationId !== null) {
      cancelFrame(animationId);
      animationId = null;
    }
    if (intervalId !== null) {
      clearIntervalFn(intervalId);
      intervalId = null;
    }
    previousFrameTime = null;
  }

  return { start, stop };
}
