import './style.css';
import { createInput } from './input.js';
import { createLoop } from './loop.js';
import { createCanvas } from './render/canvas.js';
import { createStarfield, drawWorldScene } from './render/draw.js';
import { createGame } from './sim/game.js';

const canvasElement = document.querySelector('#game');
if (!(canvasElement instanceof HTMLCanvasElement)) {
  throw new Error('The game canvas is missing from index.html.');
}

const surface = createCanvas(canvasElement);
const input = createInput(window);
let session = createGame({ width: surface.width, height: surface.height });
let previousStates = new Map();
let stars = createStarfield(surface.width, surface.height);
let renderedFrames = 0;
let busyWaitEnabled = false;
let measurement = null;
let gameLoop;

function resetShip() {
  session = createGame({ width: surface.width, height: surface.height });
  previousStates = new Map();
}

function simulate(dt) {
  if (input.justPressed('KeyR')) {
    resetShip();
  }
  previousStates = new Map(
    [...session.world].map((entity) => [
      entity.id,
      { x: entity.pos.x, y: entity.pos.y, angle: entity.angle },
    ]),
  );
  session.step(dt, input);
  input.endFrame();
}

function render(alpha, stats) {
  drawWorldScene(
    surface.context,
    surface.width,
    surface.height,
    stars,
    session.world,
    stats,
    {
      score: session.score,
      player: session.player,
      respawnRemaining: session.respawnRemaining,
    },
    previousStates,
    alpha,
    performance.now(),
  );
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
    const player = session.player;
    experimentControls.positionOutput.textContent = JSON.stringify(
      {
        timestep: settings.variableTimestep ? 'variable' : 'fixed',
        score: session.score,
        hp: player?.hp ?? 0,
        x: Number((player?.pos.x ?? 0).toFixed(2)),
        y: Number((player?.pos.y ?? 0).toFixed(2)),
        vx: Number((player?.vel.x ?? 0).toFixed(2)),
        vy: Number((player?.vel.y ?? 0).toFixed(2)),
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
  session.resize(surface.width, surface.height);
  previousStates = new Map();
});
