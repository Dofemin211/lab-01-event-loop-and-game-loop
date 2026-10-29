import './style.css';
import { createAudio } from './audio.js';
import { loadAll, loadJson, withRetry } from './assets/loader.js';
import { MultiplayerConnection } from './connection.js';
import { NetworkEmulator } from './network-emulator.js';
import { ClientNetcode } from './netcode.js';
import { createInput } from './input.js';
import { createLoop } from './loop.js';
import { createGameEventTarget, emitGameEvent } from './events.js';
import { connectHud } from './hud.js';
import { Lobby } from './lobby.js';
import { createCanvas } from './render/canvas.js';
import { connectLobbyUI } from './render/lobby-ui.js';
import { createStarfield, drawLoadingScreen, drawWorldScene } from './render/draw.js';
import { decodeBinary, encodeBinary, measureJsonBytes } from '@dogfight/shared/codec';

const canvasElement = document.querySelector('#game');
const WORLD_WIDTH = 960;
const WORLD_HEIGHT = 600;
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
const multiplayerPanel = document.querySelector('#multiplayer-panel');
const connectionStatus = document.querySelector('#connection-status');
const rosterElement = document.querySelector('#room-roster');
const chatMessages = document.querySelector('#chat-messages');
const chatForm = document.querySelector('#chat-form');
const chatInput = document.querySelector('#chat-input');

const audio = createAudio(eventTarget);
const lobby = new Lobby();
const multiplayer = new MultiplayerConnection();
let lobbyUI;
let session = null;
let netcode = null;
let roomConfiguration = null;
let pendingRoomSelection = null;
let assets = {};
let previousStates = new Map();
let stars = createStarfield(WORLD_WIDTH, WORLD_HEIGHT);
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
let networkExperimentsEnabled = false;
let networkEmulator = null;
let networkToolsConfigured = false;

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
  roomConfiguration = configuration;
  const player = configuration?.player;
  if (!player) {
    throw new Error('The server did not assign a player identity to this room.');
  }
  netcode = new ClientNetcode({
    width: 960,
    height: 600,
    sendInput: (command) => multiplayer.sendInput(command),
    interpolationDelayMs: Number(document.querySelector('#interpolation-delay').value),
  });
  netcode.setIdentity(player);
  session = { player };
  previousStates = new Map();
}

function resetShip() {
  netcode?.resetPrediction();
}

function simulate(dt) {
  if (input.justPressed('KeyR')) {
    resetShip();
  }
  netcode?.step(dt, input);
  input.endFrame();
}

function render(alpha, stats) {
  const entities = netcode?.renderEntities(performance.now()) ?? [];
  const ownEntity = entities.find((entity) => entity.id === netcode?.localEntityId) ?? null;
  const renderWorld = {
    *[Symbol.iterator]() {
      yield* entities;
    },
  };
  surface.context.save();
  surface.context.scale(surface.width / WORLD_WIDTH, surface.height / WORLD_HEIGHT);
  drawWorldScene(
    surface.context,
    WORLD_WIDTH,
    WORLD_HEIGHT,
    stars,
    renderWorld,
    stats,
    {
      score: ownEntity?.score ?? 0,
      player: ownEntity,
      respawnRemaining: ownEntity ? 0 : 0,
    },
    previousStates,
    alpha,
    performance.now(),
    assets,
  );
  surface.context.restore();
  updateNetgraph();
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
  multiplayerPanel.hidden = false;
  document.querySelector('#netgraph').hidden = !networkExperimentsEnabled;
  if (networkExperimentsEnabled) configureNetworkTools();
  void audio.unlock();
  if (!gameLoop) startLoop();
}

function updateNetgraph() {
  if (!netcode || !networkExperimentsEnabled) return;
  const latest = netcode.buffer.latest;
  const age = latest ? Math.max(0, performance.now() - latest.receivedAt) : null;
  const traffic = multiplayer.traffic();
  document.querySelector('#netgraph-codec').textContent = multiplayer.codec.toUpperCase();
  document.querySelector('#netgraph-rtt').textContent =
    multiplayer.rttMs === null ? '-- ms' : `${multiplayer.rttMs.toFixed(1)} ms`;
  document.querySelector('#netgraph-age').textContent =
    age === null ? '-- ms' : `${age.toFixed(1)} ms`;
  document.querySelector('#netgraph-traffic').textContent =
    `${traffic.inboundKilobytesPerSecond.toFixed(1)} / ${traffic.outboundKilobytesPerSecond.toFixed(1)} KB/s`;
  document.querySelector('#netgraph-pending').textContent = String(netcode.pendingCount);
  document.querySelector('#netgraph-correction').textContent =
    `${netcode.correction.toFixed(2)} px`;
  document.querySelector('#netgraph-interpolation').textContent =
    `${netcode.interpolationDelayMs} ms`;
}

function configureNetworkTools() {
  if (networkToolsConfigured) return;
  networkToolsConfigured = true;
  const elements = {
    delay: document.querySelector('#network-delay'),
    jitter: document.querySelector('#network-jitter'),
    loss: document.querySelector('#network-loss'),
    interpolation: document.querySelector('#interpolation-delay'),
    delayValue: document.querySelector('#delay-value'),
    jitterValue: document.querySelector('#jitter-value'),
    lossValue: document.querySelector('#loss-value'),
    interpolationValue: document.querySelector('#interpolation-value'),
  };
  const determinismBreak = document.querySelector('#break-determinism');
  const updateSettings = () => {
    networkEmulator.configure({
      delayMs: Number(elements.delay.value),
      jitterMs: Number(elements.jitter.value),
      lossPercent: Number(elements.loss.value),
    });
    netcode?.setInterpolationDelay(Number(elements.interpolation.value));
    elements.delayValue.value = `${elements.delay.value} ms`;
    elements.jitterValue.value = `${elements.jitter.value} ms`;
    elements.lossValue.value = `${elements.loss.value}%`;
    elements.interpolationValue.value = `${elements.interpolation.value} ms`;
  };
  for (const element of [elements.delay, elements.jitter, elements.loss, elements.interpolation]) {
    element.addEventListener('input', updateSettings);
  }
  determinismBreak.addEventListener('change', () => {
    netcode?.setDeterminismBreak(determinismBreak.checked);
  });
  document.querySelector('#network-codec').value = multiplayer.codec;
  document.querySelector('#measure-codecs').addEventListener('click', measureCodecs);
  updateSettings();
}

function measureCodecs() {
  const snapshot = {
    type: 'snapshot',
    tick: 900,
    acks: Array.from({ length: 4 }, (_, index) => ({ entityId: index + 1, seq: 300 })),
    entities: Array.from({ length: 4 }, (_, index) => ({
      id: index + 1,
      kind: 'ship',
      x: 120 + index * 100,
      y: 180 + index * 40,
      vx: 42.125,
      vy: -11.75,
      angle: -1.57075,
      radius: 13,
      hp: 3,
      thrust: 1,
      invulnerableTime: 0,
      shield: false,
      ownerId: 0,
      ttl: 0,
      commandSeq: 0,
      score: index * 100,
    })),
  };
  const jsonSnapshot = { version: 0, ...snapshot };
  const inputCommand = {
    type: 'input',
    seq: 300,
    tick: 900,
    turn: 1,
    thrust: true,
    brake: false,
    fire: false,
  };
  const ping = { type: 'ping', sentAt: 12.5 };
  const repetitions = 10_000;
  const json = JSON.stringify(jsonSnapshot);
  const binary = encodeBinary(snapshot);
  const jsonInputBytes = new TextEncoder().encode(
    JSON.stringify({ version: 0, ...inputCommand }),
  ).byteLength;
  const binaryInputBytes = encodeBinary(inputCommand).byteLength;
  const jsonPingBytes = new TextEncoder().encode(
    JSON.stringify({ version: 0, ...ping }),
  ).byteLength;
  const binaryPingBytes = encodeBinary(ping).byteLength;
  const jsonStarted = performance.now();
  for (let index = 0; index < repetitions; index += 1) {
    JSON.parse(json);
    JSON.stringify(jsonSnapshot);
  }
  const jsonElapsed = performance.now() - jsonStarted;
  const binaryStarted = performance.now();
  for (let index = 0; index < repetitions; index += 1) {
    decodeBinary(binary);
    encodeBinary(snapshot);
  }
  const binaryElapsed = performance.now() - binaryStarted;
  document.querySelector('#netcode-measurement').textContent = JSON.stringify(
    {
      browser: navigator.userAgent,
      repetitions,
      entities: snapshot.entities.length,
      jsonSnapshotBytes: measureJsonBytes(jsonSnapshot),
      binaryBytes: binary.byteLength,
      jsonEncodeDecodeUsPerSnapshot: Number(((jsonElapsed * 1000) / repetitions).toFixed(2)),
      binaryEncodeDecodeUsPerSnapshot: Number(((binaryElapsed * 1000) / repetitions).toFixed(2)),
      jsonDownKBpsAt30Hz: Number(((measureJsonBytes(jsonSnapshot) * 30) / 1024).toFixed(2)),
      binaryDownKBpsAt30Hz: Number(((binary.byteLength * 30) / 1024).toFixed(2)),
      jsonUpKBpsAt30Hz: Number(((jsonInputBytes * 30 + jsonPingBytes) / 1024).toFixed(2)),
      binaryUpKBpsAt30Hz: Number(((binaryInputBytes * 30 + binaryPingBytes) / 1024).toFixed(2)),
    },
    null,
    2,
  );
}

function renderRoster(message) {
  rosterElement.replaceChildren();
  for (const player of message.players ?? []) {
    const item = document.createElement('li');
    item.textContent = player.name;
    rosterElement.append(item);
  }
}

function renderChat(message) {
  const item = document.createElement('li');
  item.textContent = `${message.name}: ${message.text}`;
  chatMessages.append(item);
  while (chatMessages.childElementCount > 100) {
    chatMessages.firstElementChild.remove();
  }
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

multiplayer.addEventListener('state', (event) => {
  const labels = {
    disconnected: 'Disconnected from the room server.',
    connecting: 'Connecting to the room…',
    open: 'Connected; joining room…',
    joined: 'Connected to the room.',
    reconnecting: 'Connection lost. Reconnecting…',
  };
  connectionStatus.textContent = labels[event.detail.state] ?? 'Connection status unknown.';
  if (!session && event.detail.state !== 'disconnected') {
    lobbyStatus.textContent = labels[event.detail.state];
  }
});
multiplayer.addEventListener('joined', (event) => {
  if (netcode && !pendingRoomSelection) {
    netcode.setIdentity(event.detail.player);
    return;
  }
  const selection = {
    room: event.detail.room,
    playerName: pendingRoomSelection.playerName,
    player: event.detail.player,
  };
  pendingRoomSelection = null;
  emitGameEvent(eventTarget, 'roomJoined', selection);
  startGame(selection);
});
multiplayer.addEventListener('snapshot', (event) => {
  netcode?.receiveSnapshot(event.detail, performance.now());
});
multiplayer.addEventListener('roster', (event) => renderRoster(event.detail));
multiplayer.addEventListener('chat', (event) => renderChat(event.detail.message));
multiplayer.addEventListener('error', (event) => {
  connectionStatus.textContent = event.detail.message;
  if (!session) {
    lobbyStatus.textContent = event.detail.message;
    if (pendingRoomSelection) {
      pendingRoomSelection = null;
      multiplayer.disconnect();
      lobbyUI?.show();
    }
  }
});

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) {
    return;
  }
  try {
    if (multiplayer.sendChat(text)) {
      chatInput.value = '';
    }
  } catch (error) {
    connectionStatus.textContent = error.message;
  }
});

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
    const player = netcode?.predicted;
    controls.positionOutput.textContent = JSON.stringify(
      {
        timestep: settings.variableTimestep ? 'variable' : 'fixed',
        score: 0,
        hp: 0,
        x: Number((player?.x ?? 0).toFixed(2)),
        y: Number((player?.y ?? 0).toFixed(2)),
        vx: Number((player?.vx ?? 0).toFixed(2)),
        vy: Number((player?.vy ?? 0).toFixed(2)),
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
        pendingRoomSelection = selection;
        void audio.unlock();
        const parameters = new URLSearchParams(window.location.search);
        const codec = parameters.get('codec') === 'json' ? 'json' : 'binary';
        multiplayer.connect(selection.room.id, selection.playerName, { codec });
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
networkExperimentsEnabled =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get('net') === '1';
networkEmulator = new NetworkEmulator();
multiplayer.setNetworkEmulator(networkExperimentsEnabled ? networkEmulator : null);
if (networkExperimentsEnabled) {
  document.querySelector('#netcode-tools').hidden = false;
}
window.setInterval(() => multiplayer.sendPing(), 1000);
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
  stars = createStarfield(WORLD_WIDTH, WORLD_HEIGHT);
  previousStates = new Map();
  if (!session) {
    showLoadingFrame();
  }
});

const disconnectHudOnUnload = () => {
  gameLoop?.stop();
  lobbyUI?.dispose();
  multiplayer.disconnect();
  audio.dispose();
  disconnectHud();
};
window.addEventListener('pagehide', disconnectHudOnUnload, { once: true });
