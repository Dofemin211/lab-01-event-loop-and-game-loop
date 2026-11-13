import './style.css';
import { createAudio } from './audio.ts';
import { loadAll, loadJson, parseAssetManifest, withRetry } from './assets/loader.ts';
import type { AssetManifest } from './assets/loader.ts';
import { MultiplayerConnection } from './connection.ts';
import { NetworkEmulator } from './network-emulator.ts';
import { ClientNetcode } from './netcode.ts';
import { createInput } from './input.ts';
import { createLoop } from './loop.ts';
import type { LoopStats } from './loop.ts';
import { performanceStagePercentiles } from './performance.ts';
import { createGameEventTarget, emitGameEvent } from './events.ts';
import { connectHud } from './hud.ts';
import { Lobby } from './lobby.ts';
import type { RoomSelection } from './lobby.ts';
import { createCanvas } from './render/canvas.ts';
import { connectLobbyUI } from './render/lobby-ui.ts';
import { createStarfield, drawLoadingScreen, drawWorldScene } from './render/draw.ts';
import type { DrawableEntity } from './render/draw.ts';
import { decodeBinary, encodeBinary, measureJsonBytes } from '@dogfight/shared/codec';
import { serverMessageSchema } from '@dogfight/shared/protocol';
import type { ServerMessage } from '@dogfight/shared/protocol';

function requireElement<T extends HTMLElement>(selector: string, constructor: { new (): T }): T {
  const element = document.querySelector(selector);
  if (!(element instanceof constructor)) {
    throw new Error(`Required page element "${selector}" is missing or has the wrong type.`);
  }
  return element;
}

function eventDetail(event: Event): unknown {
  if (!(event instanceof CustomEvent)) {
    throw new TypeError('Game notifications must be CustomEvent instances.');
  }
  return event.detail;
}

function serverEvent(event: Event): ServerMessage {
  const parsed = serverMessageSchema.safeParse(eventDetail(event));
  if (!parsed.success) {
    throw new TypeError(
      `Game notification contains an invalid server message: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

function errorEventMessage(event: Event): string {
  const detail = eventDetail(event);
  if (
    typeof detail !== 'object' ||
    detail === null ||
    !('message' in detail) ||
    typeof detail.message !== 'string'
  ) {
    throw new TypeError('Connection error notification must contain a message.');
  }
  return detail.message;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const canvasElement = requireElement('#game', HTMLCanvasElement);
const WORLD_WIDTH = 960;
const WORLD_HEIGHT = 600;
const surface = createCanvas(canvasElement);
const input = createInput(window);
const eventTarget = createGameEventTarget();
const statusElement = requireElement('#game-status', HTMLElement);
const disconnectHud = connectHud(eventTarget, statusElement);
const loadingActions = requireElement('#loading-actions', HTMLElement);
const loadingMessage = requireElement('#loading-message', HTMLElement);
const retryButton = requireElement('#retry-loading', HTMLButtonElement);
const cancelButton = requireElement('#cancel-loading', HTMLButtonElement);
const loadingFailureControl = requireElement('#loading-failure-test-control', HTMLElement);
const loadingFailureMode = requireElement('#loading-failure-mode', HTMLSelectElement);
const lobbyFailureControl = requireElement('#lobby-failure-test-control', HTMLElement);
const lobbyFailureMode = requireElement('#lobby-failure-mode', HTMLSelectElement);
const runFailureButton = requireElement('#run-failure-test', HTMLButtonElement);
const lobbyRoot = requireElement('#lobby-screen', HTMLElement);
const gameControls = requireElement('#game-controls', HTMLElement);
const lobbyStatus = requireElement('#lobby-status', HTMLElement);
const multiplayerPanel = requireElement('#multiplayer-panel', HTMLElement);
const connectionStatus = requireElement('#connection-status', HTMLElement);
const rosterElement = requireElement('#room-roster', HTMLUListElement);
const chatMessages = requireElement('#chat-messages', HTMLOListElement);
const chatForm = requireElement('#chat-form', HTMLFormElement);
const chatInput = requireElement('#chat-input', HTMLInputElement);

const audio = createAudio(eventTarget);
const lobby = new Lobby();
const multiplayer = new MultiplayerConnection();
interface GameSelection extends RoomSelection {
  readonly player: Extract<ServerMessage, { type: 'joined' }>['player'];
}

interface Measurement {
  readonly startedAt: number;
  readonly intervals: number[];
  readonly frameTimes: number[];
  readonly settings: ReturnType<typeof readExperimentSettings>;
}

let lobbyUI: ReturnType<typeof connectLobbyUI> | null = null;
let session: { readonly player: GameSelection['player'] } | null = null;
let netcode: ClientNetcode | null = null;
let roomConfiguration: GameSelection | null = null;
let pendingRoomSelection: RoomSelection | null = null;
let assets: Readonly<Record<string, unknown>> = {};
let previousStates = new Map<number, { x: number; y: number; angle: number }>();
let stars = createStarfield(WORLD_WIDTH, WORLD_HEIGHT);
let renderedFrames = 0;
let busyWaitEnabled = false;
let measurement: Measurement | null = null;
let gameLoop: ReturnType<typeof createLoop> | null = null;
let loadController: AbortController | null = null;
let loadingRunController: AbortController | null = null;
let abortTimer: number | null = null;
let loadingProgress = 0;
let loadingStatus = 'Starting asset requests…';
let loadingError: string | null = null;
let experimentsEnabled = false;
let networkExperimentsEnabled = false;
let networkEmulator: NetworkEmulator | null = null;
let networkToolsConfigured = false;

function showLoadingFrame(): void {
  drawLoadingScreen(surface.context, surface.width, surface.height, {
    progress: loadingProgress,
    status: loadingStatus,
    error: loadingError,
  });
}

function describeLoadError(error: unknown): string {
  if (error instanceof AggregateError) {
    return error.errors.map(errorText).join(' · ');
  }
  return errorText(error) || 'The loading operation was cancelled.';
}

function failureManifest(
  manifest: AssetManifest,
  mode: string,
): {
  assets: Record<
    string,
    { type: 'image' | 'json' | 'audio'; src: string; required?: boolean; timeoutMs?: number }
  >;
} {
  const result = {
    assets: Object.fromEntries(
      Object.entries(manifest.assets).map(([name, asset]) => [name, { ...asset }]),
    ),
  };
  if (mode === '404') {
    const sprites = result.assets.sprites;
    if (sprites) sprites.src = '/api/dev/missing-sprites.svg';
  } else if (mode === 'timeout') {
    const arena = result.assets.arena;
    if (arena) {
      arena.src = '/api/dev/slow.json';
      arena.timeoutMs = 250;
    }
  } else if (mode === 'abort') {
    const arena = result.assets.arena;
    if (arena) arena.src = '/api/dev/slow.json';
  } else if (mode === 'json') {
    const arena = result.assets.arena;
    if (arena) arena.src = '/api/dev/corrupt.json';
  }
  return result;
}

function setLoadingFailure(error: unknown): void {
  loadingError = describeLoadError(error);
  loadingStatus = 'Required game content did not load. Check the message, then retry.';
  loadingMessage.textContent = loadingError;
  retryButton.hidden = false;
  cancelButton.hidden = true;
  loadingActions.hidden = false;
  showLoadingFrame();
}

async function loadGameAssets({
  failureMode = '',
  automaticAbort = false,
}: { readonly failureMode?: string; readonly automaticAbort?: boolean } = {}): Promise<void> {
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
    const loadedManifest = await withRetry(
      ({ signal: retrySignal }) => loadJson('/assets/manifest.json', { signal: retrySignal }),
      { attempts: 3, baseMs: 120, signal },
    );
    const manifest = parseAssetManifest(loadedManifest);
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
      shoot: soundBuffer('shoot'),
      hit: soundBuffer('hit'),
      explosion: soundBuffer('explosion'),
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
    if (!lobbyUI) throw new Error('The room lobby has not been initialized.');
    lobbyUI.show();
  } catch (error: unknown) {
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

function soundBuffer(name: string): object | null {
  const value = assets[name];
  return typeof value === 'object' && value !== null ? value : null;
}

function createSession(configuration: GameSelection | null = roomConfiguration): void {
  if (!configuration) {
    throw new Error('A room must be joined before starting a game session.');
  }
  roomConfiguration = configuration;
  const player = configuration?.player;
  if (!player) {
    throw new Error('The server did not assign a player identity to this room.');
  }
  netcode = new ClientNetcode({
    width: 960,
    height: 600,
    sendInput: (command) => multiplayer.sendInput(command),
    interpolationDelayMs: Number(requireElement('#interpolation-delay', HTMLInputElement).value),
  });
  netcode.setIdentity(player);
  session = { player };
  previousStates = new Map();
}

function resetShip(): void {
  netcode?.resetPrediction();
}

function simulate(dt: number): void {
  if (input.justPressed('KeyR')) {
    resetShip();
  }
  netcode?.step(dt, input);
  input.endFrame();
}

function render(alpha: number, stats: LoopStats): void {
  const entities = netcode?.renderEntities(performance.now()) ?? [];
  const ownEntity = entities.find((entity) => entity.id === netcode?.localEntityId) ?? null;
  const renderWorld = {
    *[Symbol.iterator](): Generator<DrawableEntity> {
      yield* entities;
    },
  };
  const ownShip = ownEntity?.kind === 'ship' ? ownEntity : null;
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
      player: ownShip,
      respawnRemaining: ownEntity ? 0 : 0,
    },
    previousStates,
    alpha,
    performance.now(),
    { sprites: spriteAsset(assets.sprites) },
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

function percentileSummary(values: readonly number[]): {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
} {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number): number =>
    sorted.length ? (sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0) : 0;
  return { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) };
}

function spriteAsset(value: unknown): CanvasImageSource | null {
  if (value instanceof HTMLImageElement && value.complete && value.naturalWidth > 0) {
    return value;
  }
  return null;
}

function startLoop(): void {
  gameLoop = createLoop({ simulate, render, ...readExperimentSettings() });
  gameLoop.start();
}

function startGame(selection: GameSelection): void {
  roomConfiguration = selection;
  createSession(selection);
  lobbyRoot.hidden = true;
  gameControls.hidden = false;
  requireElement('.flight-label', HTMLElement).hidden = false;
  requireElement('.coordinate-label', HTMLElement).hidden = false;
  requireElement('#experiments', HTMLElement).hidden = !experimentsEnabled;
  multiplayerPanel.hidden = false;
  requireElement('#netgraph', HTMLElement).hidden = !networkExperimentsEnabled;
  if (networkExperimentsEnabled) configureNetworkTools();
  void audio.unlock();
  if (!gameLoop) startLoop();
}

function updateNetgraph() {
  if (!netcode || !networkExperimentsEnabled) return;
  const latest = netcode.buffer.latest;
  const age = latest ? Math.max(0, performance.now() - latest.receivedAt) : null;
  const traffic = multiplayer.traffic();
  requireElement('#netgraph-codec', HTMLElement).textContent = multiplayer.codec.toUpperCase();
  requireElement('#netgraph-rtt', HTMLElement).textContent =
    multiplayer.rttMs === null ? '-- ms' : `${multiplayer.rttMs.toFixed(1)} ms`;
  requireElement('#netgraph-age', HTMLElement).textContent =
    age === null ? '-- ms' : `${age.toFixed(1)} ms`;
  requireElement('#netgraph-traffic', HTMLElement).textContent =
    `${traffic.inboundKilobytesPerSecond.toFixed(1)} / ${traffic.outboundKilobytesPerSecond.toFixed(1)} KB/s`;
  requireElement('#netgraph-pending', HTMLElement).textContent = String(netcode.pendingCount);
  requireElement('#netgraph-correction', HTMLElement).textContent =
    `${netcode.correction.toFixed(2)} px`;
  requireElement('#netgraph-interpolation', HTMLElement).textContent =
    `${netcode.interpolationDelayMs} ms`;
}

function configureNetworkTools(): void {
  if (networkToolsConfigured) return;
  networkToolsConfigured = true;
  const elements = {
    delay: requireElement('#network-delay', HTMLInputElement),
    jitter: requireElement('#network-jitter', HTMLInputElement),
    loss: requireElement('#network-loss', HTMLInputElement),
    interpolation: requireElement('#interpolation-delay', HTMLInputElement),
    delayValue: requireElement('#delay-value', HTMLOutputElement),
    jitterValue: requireElement('#jitter-value', HTMLOutputElement),
    lossValue: requireElement('#loss-value', HTMLOutputElement),
    interpolationValue: requireElement('#interpolation-value', HTMLOutputElement),
  };
  const determinismBreak = requireElement('#break-determinism', HTMLInputElement);
  if (!networkEmulator) {
    throw new Error('The network emulator has not been initialized.');
  }
  const emulator = networkEmulator;
  const updateSettings = () => {
    emulator.configure({
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
  requireElement('#network-codec', HTMLSelectElement).value = multiplayer.codec;
  requireElement('#measure-codecs', HTMLButtonElement).addEventListener('click', measureCodecs);
  updateSettings();
}

function measureCodecs(): void {
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
  requireElement('#netcode-measurement', HTMLElement).textContent = JSON.stringify(
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

function renderRoster(message: Extract<ServerMessage, { type: 'roster' }>): void {
  rosterElement.replaceChildren();
  for (const player of message.players) {
    const item = document.createElement('li');
    item.textContent = player.name;
    rosterElement.append(item);
  }
}

function renderChat(message: Extract<ServerMessage, { type: 'chat' }>['message']): void {
  const item = document.createElement('li');
  item.textContent = `${message.name}: ${message.text}`;
  chatMessages.append(item);
  while (chatMessages.childElementCount > 100) {
    chatMessages.firstElementChild?.remove();
  }
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

multiplayer.addEventListener('state', (event) => {
  const detail = eventDetail(event);
  if (
    typeof detail !== 'object' ||
    detail === null ||
    !('state' in detail) ||
    (detail.state !== 'disconnected' &&
      detail.state !== 'connecting' &&
      detail.state !== 'open' &&
      detail.state !== 'joined' &&
      detail.state !== 'reconnecting')
  ) {
    throw new TypeError('Connection state notification must contain a valid state.');
  }
  const state = detail.state;
  const labels: Record<typeof state, string> = {
    disconnected: 'Disconnected from the room server.',
    connecting: 'Connecting to the room…',
    open: 'Connected; joining room…',
    joined: 'Connected to the room.',
    reconnecting: 'Connection lost. Reconnecting…',
  };
  connectionStatus.textContent = labels[state] ?? 'Connection status unknown.';
  if (!session && state !== 'disconnected') {
    lobbyStatus.textContent = labels[state];
  }
});
multiplayer.addEventListener('joined', (event) => {
  const message = serverEvent(event);
  if (message.type !== 'joined') {
    throw new TypeError('Joined notification must contain a joined message.');
  }
  const joined = message;
  if (netcode && !pendingRoomSelection) {
    netcode.setIdentity(joined.player);
    return;
  }
  if (!pendingRoomSelection) {
    throw new Error('The server accepted a room join without a pending lobby selection.');
  }
  const selection = {
    room: joined.room,
    playerName: pendingRoomSelection.playerName,
    player: joined.player,
  };
  pendingRoomSelection = null;
  emitGameEvent(eventTarget, 'roomJoined', selection);
  startGame(selection);
});
multiplayer.addEventListener('snapshot', (event) => {
  const message = serverEvent(event);
  if (message.type !== 'snapshot') {
    throw new TypeError('Snapshot notification must contain a snapshot message.');
  }
  netcode?.receiveSnapshot(message, performance.now());
});
multiplayer.addEventListener('roster', (event) => {
  const message = serverEvent(event);
  if (message.type !== 'roster') {
    throw new TypeError('Roster notification must contain a roster message.');
  }
  renderRoster(message);
});
multiplayer.addEventListener('chat', (event) => {
  const message = serverEvent(event);
  if (message.type !== 'chat') {
    throw new TypeError('Chat notification must contain a chat message.');
  }
  renderChat(message.message);
});
multiplayer.addEventListener('error', (event) => {
  const message = errorEventMessage(event);
  connectionStatus.textContent = message;
  if (!session) {
    lobbyStatus.textContent = message;
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
  } catch (error: unknown) {
    connectionStatus.textContent = errorText(error);
  }
});

function readExperimentSettings(): { scheduler: 'raf' | 'interval'; variableTimestep: boolean } {
  return {
    scheduler:
      requireElement('#scheduler', HTMLSelectElement).value === 'interval' ? 'interval' : 'raf',
    variableTimestep: requireElement('#timestep', HTMLSelectElement).value === 'variable',
  };
}

function configureExperiments(): void {
  if (new URLSearchParams(window.location.search).get('experiments') !== '1') {
    return;
  }
  experimentsEnabled = true;
  const controls = {
    scheduler: requireElement('#scheduler', HTMLSelectElement),
    timestep: requireElement('#timestep', HTMLSelectElement),
    busyWait: requireElement('#busy-wait', HTMLInputElement),
    measure: requireElement('#measure', HTMLButtonElement),
    measureAssets: requireElement('#measure-assets', HTMLButtonElement),
    capturePosition: requireElement('#capture-position', HTMLButtonElement),
    reset: requireElement('#reset', HTMLButtonElement),
    output: requireElement('#experiment-output', HTMLElement),
    positionOutput: requireElement('#position-output', HTMLElement),
    assetOutput: requireElement('#asset-measurement-output', HTMLElement),
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
    if (!(event.currentTarget instanceof HTMLInputElement)) {
      throw new TypeError('Busy-wait control must be an input element.');
    }
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
        frameIntervalPercentilesMs: percentileSummary(intervals),
        frameTimePercentilesMs: percentileSummary(completedMeasurement.frameTimes),
        stageDurationPercentilesMs: performanceStagePercentiles(),
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
      const manifest = parseAssetManifest(await loadJson('/assets/manifest.json'));
      const paths = Object.values(manifest.assets).map((asset) => asset.src);
      const loadBytes = async (path: string, runId: string): Promise<number> => {
        const separator = path.includes('?') ? '&' : '?';
        const response = await fetch(`${path}${separator}lab03-run=${runId}`, {
          cache: 'no-store',
        });
        if (!response.ok) {
          throw new Error(`Asset benchmark request failed: ${path} (HTTP ${response.status})`);
        }
        return (await response.arrayBuffer()).byteLength;
      };
      const measure = async (
        label: string,
        run: () => Promise<readonly number[]>,
      ): Promise<{ strategy: string; elapsedMs: number; bytes: number }> => {
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
    } catch (error: unknown) {
      controls.assetOutput.textContent = `Asset comparison failed: ${errorText(error)}`;
    } finally {
      controls.measureAssets.disabled = false;
    }
  });
}

function connectLobby(): ReturnType<typeof connectLobbyUI> {
  const ui = connectLobbyUI(
    lobby,
    {
      root: lobbyRoot,
      rooms: requireElement('#room-list', HTMLElement),
      playerName: requireElement('#player-name', HTMLInputElement),
      joinButton: requireElement('#join-room', HTMLButtonElement),
      refreshButton: requireElement('#refresh-rooms', HTMLButtonElement),
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
  lobbyUI = ui;
  return ui;
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
  requireElement('#netcode-tools', HTMLElement).hidden = false;
}
window.setInterval(() => multiplayer.sendPing(), 1000);
connectLobby().hide();
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

if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
    console.error('Offline app shell could not be registered:', errorText(error));
  });
}
