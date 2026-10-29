import './style.css';
import { createAudio } from './audio.js';
import { loadAll, loadJson, withRetry } from './assets/loader.js';
import { createInput } from './input.js';
import { createLoop } from './loop.js';
import { createGameEventTarget, emitGameEvent } from './events.js';
import { connectHud } from './hud.js';
import { Lobby } from './lobby.js';
import { createCanvas } from './render/canvas.js';
import { connectLobbyUI } from './render/lobby-ui.js';
import { createStarfield, drawLoadingScreen, drawWorldScene } from './render/draw.js';
import { createGame } from './sim/game.js';

const canvasElement = document.querySelector('#game');
if (!(canvasElement instanceof HTMLCanvasElement)) {
  throw new Error('The game canvas is missing from index.html.');
}

const surface = createCanvas(canvasElement);
const input = createInput(window);
const eventTarget = createGameEventTarget();
const statusElement = document.querySelector('#game-status');
const disconnectHud = connectHud(eventTarget, statusElement);
const loadingActions = document.querySelector('#loading-actions');
const loadingMessage = document.querySelector('#loading-message');
const retryButton = document.querySelector('#retry-loading');
const cancelButton = document.querySelector('#cancel-loading');
const loadingFailureControl = document.querySelector('#loading-failure-test-control');
const loadingFailureMode = document.querySelector('#loading-failure-mode');
const lobbyFailureControl = document.querySelector('#lobby-failure-test-control');
const lobbyFailureMode = document.querySelector('#lobby-failure-mode');
const runFailureButton = document.querySelector('#run-failure-test');
const lobbyRoot = document.querySelector('#lobby-screen');
const gameControls = document.querySelector('#game-controls');
const lobbyStatus = document.querySelector('#lobby-status');

const audio = createAudio(eventTarget);
const lobby = new Lobby();
let lobbyUI;
let session = null;
let roomConfiguration = null;
let assets = {};
let arenaDefinition = { asteroidCount: 6, seed: 2025 };
let previousStates = new Map();
let stars = createStarfield(surface.width, surface.height);
let renderedFrames = 0;
let busyWaitEnabled = false;
let measurement = null;
let gameLoop = null;
let loadController = null;
let loadingRunController = null;
let abortTimer = null;
let loadingProgress = 0;
let loadingStatus = 'Starting asset requests…';
let loadingError = null;
let experimentsEnabled = false;

function showLoadingFrame() {
  drawLoadingScreen(surface.context, surface.width, surface.height, {
    progress: loadingProgress,
    status: loadingStatus,
    error: loadingError,
  });
}

function describeLoadError(error) {
  if (error instanceof AggregateError) {
    return error.errors.map((item) => item.message).join(' · ');
  }
  return error.message || 'The loading operation was cancelled.';
}

function failureManifest(manifest, mode) {
  const result = structuredClone(manifest);
  if (mode === '404') {
    result.assets.sprites.src = '/api/dev/missing-sprites.svg';
  } else if (mode === 'timeout') {
    result.assets.arena.src = '/api/dev/slow.json';
    result.assets.arena.timeoutMs = 250;
  } else if (mode === 'abort') {
    result.assets.arena.src = '/api/dev/slow.json';
  } else if (mode === 'json') {
    result.assets.arena.src = '/api/dev/corrupt.json';
  }
  return result;
}

function setLoadingFailure(error) {
  loadingError = describeLoadError(error);
  loadingStatus = 'Required game content did not load. Check the message, then retry.';
  loadingMessage.textContent = loadingError;
  retryButton.hidden = false;
  cancelButton.hidden = true;
  loadingActions.hidden = false;
  showLoadingFrame();
}

async function loadGameAssets({ failureMode = '', automaticAbort = false } = {}) {
  loadController?.abort();
  const controller = new AbortController();
  loadController = controller;
  loadingRunController = controller;
  const { signal } = controller;
  loadingProgress = 0;
  loadingError = null;
  loadingStatus = 'Loading asset manifest…';
  loadingMessage.textContent = '';
  loadingActions.hidden = false;
  retryButton.hidden = true;
  cancelButton.hidden = false;
  loadingFailureControl.hidden = !import.meta.env.DEV;
  if (import.meta.env.DEV) {
    loadingFailureMode.value = failureMode;
  }
  lobbyUI?.hide();
  showLoadingFrame();

  if (abortTimer !== null) {
    window.clearTimeout(abortTimer);
    abortTimer = null;
  }
  if (automaticAbort) {
    abortTimer = window.setTimeout(() => {
      controller.abort(new DOMException('Aborted by the Lab 03 failure test.', 'AbortError'));
    }, 100);
  }

  try {
    const manifest = await withRetry(
      ({ signal: retrySignal }) => loadJson('/assets/manifest.json', { signal: retrySignal }),
      { attempts: 3, baseMs: 120, signal },
    );
    const configuredManifest = import.meta.env.DEV
      ? failureManifest(manifest, failureMode)
      : manifest;
    const result = await loadAll(configuredManifest, {
      signal,
      audioContext: audio.context,
      onProgress: ({ loaded, total, name, progress, error }) => {
        loadingProgress = progress;
        loadingStatus = error
          ? `${loaded}/${total} assets settled · ${name} failed`
          : `${loaded}/${total} assets ready · ${name}`;
        showLoadingFrame();
      },
    });
    assets = result.assets;
    arenaDefinition = assets.arena;
    audio.setBuffers({
      shoot: assets.shoot,
      hit: assets.hit,
      explosion: assets.explosion,
    });
    if (result.optionalErrors.length > 0) {
      emitGameEvent(eventTarget, 'audioError', {
        message: `Game ready without optional sound: ${result.optionalErrors
          .map(({ name }) => name)
          .join(', ')}.`,
      });
    }

    loadingProgress = 1;
    loadingStatus = 'Assets ready. Contacting the local room list…';
    loadingActions.hidden = true;
    lobbyUI.show();
  } catch (error) {
    setLoadingFailure(error);
  } finally {
    if (abortTimer !== null) {
      window.clearTimeout(abortTimer);
      abortTimer = null;
    }
    if (loadController === controller) {
      loadController = null;
    }
    if (loadingRunController === controller) {
      loadingRunController = null;
    }
  }
}

function createSession(configuration = roomConfiguration) {
  const arena = {
    ...arenaDefinition,
    ...(configuration?.room?.arena ?? configuration?.arena ?? {}),
  };
  session = createGame({
    ...arena,
    width: surface.width,
    height: surface.height,
    emit: (type, detail) => emitGameEvent(eventTarget, type, detail),
  });
  previousStates = new Map();
}

function resetShip() {
  createSession();
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
    assets,
  );
  renderedFrames += 1;

  if (measurement && stats.frameIntervalMs > 0) {
    measurement.intervals.push(stats.frameIntervalMs);
    measurement.frameTimes.push(stats.frameTimeMs);
  }
  if (busyWaitEnabled && renderedFrames % 60 === 0) {
    const deadline = performance.now() + 100;
    while (performance.now() < deadline) {
      // Deliberately block the main thread for the Lab 01 experiment.
    }
  }
}

function startLoop() {
  gameLoop = createLoop({ simulate, render, ...readExperimentSettings() });
  gameLoop.start();
}

function startGame(selection) {
  roomConfiguration = selection;
  createSession(selection);
  lobbyRoot.hidden = true;
  gameControls.hidden = false;
  document.querySelector('.flight-label').hidden = false;
  document.querySelector('.coordinate-label').hidden = false;
  document.querySelector('#experiments').hidden = !experimentsEnabled;
  void audio.unlock();
  startLoop();
}

function readExperimentSettings() {
  return {
    scheduler: document.querySelector('#scheduler').value,
    variableTimestep: document.querySelector('#timestep').value === 'variable',
  };
}

function configureExperiments() {
  if (new URLSearchParams(window.location.search).get('experiments') !== '1') {
    return;
  }
  experimentsEnabled = true;
  const controls = {
    scheduler: document.querySelector('#scheduler'),
    timestep: document.querySelector('#timestep'),
    busyWait: document.querySelector('#busy-wait'),
    measure: document.querySelector('#measure'),
    measureAssets: document.querySelector('#measure-assets'),
    capturePosition: document.querySelector('#capture-position'),
    reset: document.querySelector('#reset'),
    output: document.querySelector('#experiment-output'),
    positionOutput: document.querySelector('#position-output'),
    assetOutput: document.querySelector('#asset-measurement-output'),
  };

  function restartWithSelectedSettings() {
    if (!gameLoop) {
      return;
    }
    gameLoop.stop();
    startLoop();
  }

  controls.scheduler.addEventListener('change', restartWithSelectedSettings);
  controls.timestep.addEventListener('change', restartWithSelectedSettings);
  controls.busyWait.addEventListener('change', (event) => {
    busyWaitEnabled = event.currentTarget.checked;
  });
  controls.reset.addEventListener('click', resetShip);
  controls.capturePosition.addEventListener('click', () => {
    const settings = readExperimentSettings();
    const player = session?.player;
    controls.positionOutput.textContent = JSON.stringify(
      {
        timestep: settings.variableTimestep ? 'variable' : 'fixed',
        score: session?.score ?? 0,
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
  controls.measure.addEventListener('click', () => {
    if (measurement || !gameLoop) {
      return;
    }
    measurement = {
      startedAt: performance.now(),
      intervals: [],
      frameTimes: [],
      settings: readExperimentSettings(),
    };
    controls.output.textContent =
      'Measuring for 10 seconds. Leave this tab visible, or switch tabs for the background-tab experiment.';
    controls.measure.disabled = true;
    controls.scheduler.disabled = true;
    controls.timestep.disabled = true;
    controls.busyWait.disabled = true;

    window.setTimeout(() => {
      const completedMeasurement = measurement;
      if (!completedMeasurement) {
        return;
      }
      const elapsedMs = performance.now() - completedMeasurement.startedAt;
      const intervals = completedMeasurement.intervals;
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
      const averageFrameTime = completedMeasurement.frameTimes.length
        ? completedMeasurement.frameTimes.reduce((sum, value) => sum + value, 0) /
          completedMeasurement.frameTimes.length
        : 0;
      const maximumFrameTime = completedMeasurement.frameTimes.length
        ? Math.max(...completedMeasurement.frameTimes)
        : 0;
      const result = {
        scheduler: completedMeasurement.settings.scheduler,
        timestep: completedMeasurement.settings.variableTimestep ? 'variable' : 'fixed',
        elapsedSeconds: (elapsedMs / 1000).toFixed(2),
        sampledFrames: intervals.length,
        averageFps: averageInterval ? (1000 / averageInterval).toFixed(2) : 'not available',
        frameIntervalJitterMs: jitter.toFixed(3),
        averageFrameTimeMs: averageFrameTime.toFixed(3),
        maximumFrameTimeMs: maximumFrameTime.toFixed(3),
      };
      controls.output.textContent = JSON.stringify(result, null, 2);
      console.table(result);
      measurement = null;
      controls.measure.disabled = false;
      controls.scheduler.disabled = false;
      controls.timestep.disabled = false;
      controls.busyWait.disabled = false;
    }, 10_000);
  });
  controls.measureAssets.addEventListener('click', async () => {
    controls.measureAssets.disabled = true;
    controls.assetOutput.textContent = 'Measuring local asset downloads…';
    try {
      const manifest = await loadJson('/assets/manifest.json');
      const paths = Object.values(manifest.assets).map((asset) => asset.src);
      const loadBytes = async (path, runId) => {
        const separator = path.includes('?') ? '&' : '?';
        const response = await fetch(`${path}${separator}lab03-run=${runId}`, {
          cache: 'no-store',
        });
        if (!response.ok) {
          throw new Error(`Asset benchmark request failed: ${path} (HTTP ${response.status})`);
        }
        return (await response.arrayBuffer()).byteLength;
      };
      const measure = async (label, run) => {
        const startedAt = performance.now();
        const bytes = await run();
        return {
          strategy: label,
          elapsedMs: Number((performance.now() - startedAt).toFixed(2)),
          bytes: bytes.reduce((sum, value) => sum + value, 0),
        };
      };
      const sequential = await measure('Sequential await', async () => {
        const bytes = [];
        for (const [index, path] of paths.entries()) {
          bytes.push(await loadBytes(path, `sequential-${index}-${Date.now()}`));
        }
        return bytes;
      });
      const concurrent = await measure('Promise.all', () =>
        Promise.all(
          paths.map((path, index) => loadBytes(path, `concurrent-${index}-${Date.now()}`)),
        ),
      );
      const result = {
        browser: navigator.userAgent,
        measuredAt: new Date().toISOString(),
        assets: paths.length,
        sequential,
        concurrent,
        note: 'Local Vite HTTP transfer and body-read time; browser cache disabled for each request.',
      };
      controls.assetOutput.textContent = JSON.stringify(result, null, 2);
      console.table([sequential, concurrent]);
    } catch (error) {
      controls.assetOutput.textContent = `Asset comparison failed: ${error.message}`;
    } finally {
      controls.measureAssets.disabled = false;
    }
  });
}

function connectLobby() {
  lobbyUI = connectLobbyUI(
    lobby,
    {
      root: lobbyRoot,
      rooms: document.querySelector('#room-list'),
      playerName: document.querySelector('#player-name'),
      joinButton: document.querySelector('#join-room'),
      refreshButton: document.querySelector('#refresh-rooms'),
      status: lobbyStatus,
    },
    {
      onJoin: (selection) => {
        emitGameEvent(eventTarget, 'roomJoined', selection);
        startGame(selection);
      },
    },
  );
}

retryButton.addEventListener('click', () => {
  void loadGameAssets({ failureMode: import.meta.env.DEV ? loadingFailureMode.value : '' });
});
cancelButton.addEventListener('click', () => {
  loadingRunController?.abort(new DOMException('Loading cancelled by the player.', 'AbortError'));
});
runFailureButton.addEventListener('click', () => {
  void loadGameAssets({
    failureMode: lobbyFailureMode.value,
    automaticAbort: lobbyFailureMode.value === 'abort',
  });
});

if (import.meta.env.DEV) {
  loadingFailureControl.hidden = false;
  lobbyFailureControl.hidden = false;
}

configureExperiments();
connectLobby();
lobbyUI.hide();
showLoadingFrame();
void loadGameAssets({
  failureMode: import.meta.env.DEV
    ? (new URLSearchParams(window.location.search).get('lab3Failure') ?? '')
    : '',
  automaticAbort:
    import.meta.env.DEV &&
    new URLSearchParams(window.location.search).get('lab3Failure') === 'abort',
});

window.addEventListener('resize', () => {
  stars = createStarfield(surface.width, surface.height);
  session?.resize(surface.width, surface.height);
  previousStates = new Map();
  if (!session) {
    showLoadingFrame();
  }
});

const disconnectHudOnUnload = () => {
  gameLoop?.stop();
  lobbyUI?.dispose();
  audio.dispose();
  disconnectHud();
};
window.addEventListener('pagehide', disconnectHudOnUnload, { once: true });
