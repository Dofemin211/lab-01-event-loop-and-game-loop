import './style.css';
import { createInput } from './input.js';
import { createLoop } from './loop.js';
import { createCanvas } from './render/canvas.js';
import { createStarfield, drawScene } from './render/draw.js';
import { wrapShip } from './sim/arena.js';
import { createShip, integrate, interpolateShip } from './sim/ship.js';

const canvasElement = document.querySelector('#game');
if (!(canvasElement instanceof HTMLCanvasElement)) {
  throw new Error('The game canvas is missing from index.html.');
}

const surface = createCanvas(canvasElement);
const input = createInput(window);
const initialPoint = () => ({ x: surface.width / 2, y: surface.height / 2 });
let current = createShip(initialPoint().x, initialPoint().y);
let previous = { ...current };
let stars = createStarfield(surface.width, surface.height);
let renderedFrames = 0;
let busyWaitEnabled = false;
let measurement = null;
let gameLoop;

function resetShip() {
  const point = initialPoint();
  current = createShip(point.x, point.y);
  previous = { ...current };
}

function simulate(dt) {
  if (input.justPressed('KeyR')) {
    resetShip();
  }
  previous = { ...current };
  current = wrapShip(integrate(current, input, dt), surface.width, surface.height);
  input.endFrame();
}

function render(alpha, stats) {
  const ship = interpolateShip(previous, current, alpha, surface.width, surface.height);
  drawScene(surface.context, surface.width, surface.height, stars, ship, stats);
  renderedFrames += 1;

  if (measurement && stats.frameIntervalMs > 0) {
    measurement.intervals.push(stats.frameIntervalMs);
    measurement.frameTimes.push(stats.frameTimeMs);
  }
  if (busyWaitEnabled && renderedFrames % 60 === 0) {
    const deadline = performance.now() + 100;
    while (performance.now() < deadline) {
      // Deliberately block the main thread for the busy-wait experiment.
    }
  }
}

function readExperimentSettings() {
  return {
    scheduler: document.querySelector('#scheduler').value,
    variableTimestep: document.querySelector('#timestep').value === 'variable',
  };
}

function startLoop() {
  gameLoop = createLoop({ simulate, render, ...readExperimentSettings() });
  gameLoop.start();
}

startLoop();

const experimentsPanel = document.querySelector('#experiments');
const experimentControls = {
  scheduler: document.querySelector('#scheduler'),
  timestep: document.querySelector('#timestep'),
  busyWait: document.querySelector('#busy-wait'),
  measure: document.querySelector('#measure'),
  capturePosition: document.querySelector('#capture-position'),
  reset: document.querySelector('#reset'),
  output: document.querySelector('#experiment-output'),
  positionOutput: document.querySelector('#position-output'),
};

if (new URLSearchParams(window.location.search).get('experiments') === '1') {
  experimentsPanel.hidden = false;

  function restartWithSelectedSettings() {
    gameLoop.stop();
    startLoop();
  }

  experimentControls.scheduler.addEventListener('change', restartWithSelectedSettings);
  experimentControls.timestep.addEventListener('change', restartWithSelectedSettings);
  experimentControls.busyWait.addEventListener('change', (event) => {
    busyWaitEnabled = event.currentTarget.checked;
  });
  experimentControls.reset.addEventListener('click', resetShip);
  experimentControls.capturePosition.addEventListener('click', () => {
    const settings = readExperimentSettings();
    experimentControls.positionOutput.textContent = JSON.stringify(
      {
        timestep: settings.variableTimestep ? 'variable' : 'fixed',
        x: Number(current.x.toFixed(2)),
        y: Number(current.y.toFixed(2)),
        vx: Number(current.vx.toFixed(2)),
        vy: Number(current.vy.toFixed(2)),
      },
      null,
      2,
    );
  });
  experimentControls.measure.addEventListener('click', () => {
    if (measurement) {
      return;
    }
    measurement = {
      startedAt: performance.now(),
      intervals: [],
      frameTimes: [],
      settings: readExperimentSettings(),
    };
    experimentControls.output.textContent =
      'Measuring for 10 seconds. Leave this tab visible, or switch tabs for the background-tab experiment.';
    experimentControls.measure.disabled = true;
    experimentControls.scheduler.disabled = true;
    experimentControls.timestep.disabled = true;
    experimentControls.busyWait.disabled = true;

    window.setTimeout(() => {
      const elapsedMs = performance.now() - measurement.startedAt;
      const intervals = measurement.intervals;
      const averageInterval = intervals.length
        ? intervals.reduce((sum, value) => sum + value, 0) / intervals.length
        : 0;
      const jitter =
        intervals.length > 1
          ? Math.sqrt(
              intervals.reduce((sum, value) => sum + (value - averageInterval) ** 2, 0) /
                intervals.length,
            )
          : 0;
      const averageFrameTime = measurement.frameTimes.length
        ? measurement.frameTimes.reduce((sum, value) => sum + value, 0) /
          measurement.frameTimes.length
        : 0;
      const maximumFrameTime = measurement.frameTimes.length
        ? Math.max(...measurement.frameTimes)
        : 0;
      const result = {
        scheduler: measurement.settings.scheduler,
        timestep: measurement.settings.variableTimestep ? 'variable' : 'fixed',
        elapsedSeconds: (elapsedMs / 1000).toFixed(2),
        sampledFrames: intervals.length,
        averageFps: averageInterval ? (1000 / averageInterval).toFixed(2) : 'not available',
        frameIntervalJitterMs: jitter.toFixed(3),
        averageFrameTimeMs: averageFrameTime.toFixed(3),
        maximumFrameTimeMs: maximumFrameTime.toFixed(3),
      };
      experimentControls.output.textContent = JSON.stringify(result, null, 2);
      console.table(result);
      measurement = null;
      experimentControls.measure.disabled = false;
      experimentControls.scheduler.disabled = false;
      experimentControls.timestep.disabled = false;
      experimentControls.busyWait.disabled = false;
    }, 10_000);
  });
}

window.addEventListener('resize', () => {
  stars = createStarfield(surface.width, surface.height);
  current = wrapShip(current, surface.width, surface.height);
  previous = { ...current };
});
