export interface AssetDefinition {
  readonly type: 'image' | 'json' | 'audio';
  readonly src: string;
  readonly required?: boolean;
  readonly timeoutMs?: number;
}

export interface AssetManifest {
  readonly assets: Readonly<Record<string, AssetDefinition>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseAssetManifest(value: unknown): AssetManifest {
  if (!isRecord(value) || !isRecord(value.assets)) {
    throw new TypeError('Asset manifest must contain an assets object.');
  }
  const assets: Record<string, AssetDefinition> = {};
  const entries: [string, unknown][] = Object.entries(value.assets);
  for (const [name, rawAsset] of entries) {
    if (!isRecord(rawAsset)) {
      throw new TypeError(`Asset "${name}" must be an object.`);
    }
    const { type, src, required, timeoutMs } = rawAsset;
    if (
      (type !== 'image' && type !== 'json' && type !== 'audio') ||
      typeof src !== 'string' ||
      src.length === 0 ||
      (required !== undefined && typeof required !== 'boolean') ||
      (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)))
    ) {
      throw new TypeError(`Asset "${name}" has invalid metadata.`);
    }
    assets[name] = { type, src, required, timeoutMs };
  }
  return { assets };
}

export interface AssetLoadFailure {
  readonly name: string;
  readonly error: unknown;
}

export interface AssetProgress {
  readonly loaded: number;
  readonly total: number;
  readonly name: string;
  readonly progress: number;
  readonly error: unknown | null;
}

export interface AudioBufferDecoder<DecodedBuffer = unknown> {
  decodeAudioData(encoded: ArrayBuffer): Promise<DecodedBuffer>;
}

export interface LoadedImage extends EventTarget {
  readonly complete: boolean;
  readonly naturalWidth: number;
  src: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface FetchOptions {
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
}

export interface RetryOptions extends FetchOptions {
  readonly attempts?: number;
  readonly baseMs?: number;
  readonly random?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface LoadAllOptions extends RetryOptions {
  readonly onProgress?: (progress: AssetProgress) => void;
  readonly audioContext?: AudioBufferDecoder<unknown> | null;
  readonly imageLoader?: (src: string, options: FetchOptions) => Promise<unknown>;
  readonly jsonLoader?: (src: string, options: FetchOptions) => Promise<unknown>;
  readonly audioLoader?: (
    context: AudioBufferDecoder<unknown>,
    src: string,
    options: FetchOptions,
  ) => Promise<unknown>;
}

export class HttpError extends Error {
  readonly url: string;
  readonly status: number;

  constructor(url: string, status: number, statusText = '') {
    super(`Request failed for ${url}: HTTP ${status}${statusText ? ` ${statusText}` : ''}`);
    this.name = 'HttpError';
    this.url = url;
    this.status = status;
  }
}

export class AssetLoadError extends AggregateError {
  readonly failures: readonly AssetLoadFailure[];
  readonly assets: Readonly<Record<string, unknown>>;
  readonly optionalErrors: readonly AssetLoadFailure[];

  constructor(
    failures: readonly AssetLoadFailure[],
    assets: Readonly<Record<string, unknown>>,
    optionalErrors: readonly AssetLoadFailure[],
  ) {
    super(
      failures.map(({ name, error }) => new Error(`${name}: ${errorText(error)}`)),
      `Required assets failed to load: ${failures.map(({ name }) => name).join(', ')}`,
    );
    this.name = 'AssetLoadError';
    this.failures = failures;
    this.assets = assets;
    this.optionalErrors = optionalErrors;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
  }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function fetchJson(
  url: string,
  { signal, fetchImpl = globalThis.fetch }: FetchOptions = {},
): Promise<unknown> {
  throwIfAborted(signal);
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetchJson requires a fetch implementation.');
  }
  const response = await fetchImpl(url, { signal });
  if (!response.ok) {
    throw new HttpError(url, response.status, response.statusText);
  }
  return response.json();
}

export function loadJson(url: string, options: FetchOptions = {}): Promise<unknown> {
  return fetchJson(url, options);
}

export async function loadImage(
  src: string,
  {
    signal,
    ImageCtor = globalThis.Image,
    fetchImpl = globalThis.fetch,
    createObjectURL = (blob) => URL.createObjectURL(blob),
    revokeObjectURL = (url) => URL.revokeObjectURL(url),
  }: FetchOptions & {
    readonly ImageCtor?: new () => LoadedImage;
    readonly createObjectURL?: (blob: Blob) => string;
    readonly revokeObjectURL?: (url: string) => void;
  } = {},
): Promise<LoadedImage> {
  throwIfAborted(signal);
  if (typeof ImageCtor !== 'function') {
    throw new Error('Image loading is unavailable in this environment.');
  }
  const response = await fetchImpl(src, { signal });
  if (!response.ok) {
    throw new HttpError(src, response.status, response.statusText);
  }
  const objectUrl = createObjectURL(await response.blob());
  let released = false;
  const releaseObjectUrl = () => {
    if (!released) {
      released = true;
      revokeObjectURL(objectUrl);
    }
  };

  try {
    throwIfAborted(signal);
    return await new Promise((resolve, reject) => {
      const image = new ImageCtor();
      const cleanup = () => {
        image.removeEventListener('load', onLoad);
        image.removeEventListener('error', onError);
        signal?.removeEventListener('abort', onAbort);
        releaseObjectUrl();
      };
      const onLoad = () => {
        cleanup();
        resolve(image);
      };
      const onError = () => {
        cleanup();
        reject(new Error(`Image failed to load: ${src}`));
      };
      const onAbort = () => {
        cleanup();
        image.src = '';
        reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      };

      image.addEventListener('load', onLoad, { once: true });
      image.addEventListener('error', onError, { once: true });
      signal?.addEventListener('abort', onAbort, { once: true });
      image.src = objectUrl;
    });
  } catch (error) {
    releaseObjectUrl();
    throw error;
  }
}

export async function loadAudio<DecodedBuffer>(
  ctx: AudioBufferDecoder<DecodedBuffer>,
  url: string,
  { signal, fetchImpl = globalThis.fetch }: FetchOptions = {},
): Promise<DecodedBuffer> {
  throwIfAborted(signal);
  if (!ctx || typeof ctx.decodeAudioData !== 'function') {
    throw new TypeError('loadAudio requires an AudioContext.');
  }
  const response = await fetchImpl(url, { signal });
  if (!response.ok) {
    throw new HttpError(url, response.status, response.statusText);
  }
  const encoded = await response.arrayBuffer();
  throwIfAborted(signal);
  return ctx.decodeAudioData(encoded);
}

export async function withRetry(
  fn: (context: { attempt: number; signal: AbortSignal | undefined }) => Promise<unknown>,
  {
    attempts = 3,
    baseMs = 150,
    signal,
    random = Math.random,
    sleep = abortableDelay,
  }: RetryOptions = {},
): Promise<unknown> {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError('attempts must be a positive integer.');
  }
  if (!Number.isFinite(baseMs) || baseMs < 0) {
    throw new RangeError('baseMs must be a non-negative finite number.');
  }

  for (let attempt = 1; ; attempt += 1) {
    throwIfAborted(signal);
    try {
      return await fn({ attempt, signal });
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason ?? error;
      }
      if (error instanceof HttpError && error.status >= 400 && error.status < 500) {
        throw error;
      }
      if (
        error instanceof SyntaxError ||
        (error instanceof HttpError && error.status < 500) ||
        !(error instanceof HttpError || error instanceof TypeError)
      ) {
        throw error;
      }
      if (attempt >= attempts) {
        throw error;
      }
      const exponentialDelay = baseMs * 2 ** (attempt - 1);
      await sleep(exponentialDelay * random(), signal);
    }
  }
}

function combineSignals(signals: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
  const availableSignals = signals.filter((item): item is AbortSignal => item !== undefined);
  if (availableSignals.length === 0) {
    return undefined;
  }
  if (availableSignals.length === 1) {
    return availableSignals[0];
  }
  return AbortSignal.any(availableSignals);
}

function getAssetLoader(
  asset: AssetDefinition,
  options: LoadAllOptions & { readonly signal: AbortSignal | undefined },
): () => Promise<unknown> {
  const { audioContext, fetchImpl, imageLoader, jsonLoader, audioLoader } = options;
  const loadOptions = { signal: options.signal, fetchImpl };
  if (asset.type === 'image') {
    return () =>
      (imageLoader ?? loadImage)(asset.src, {
        signal: options.signal,
        fetchImpl,
      });
  }
  if (asset.type === 'json') {
    return () => (jsonLoader ?? loadJson)(asset.src, loadOptions);
  }
  if (asset.type === 'audio') {
    if (!audioContext) {
      throw new Error('AudioContext is unavailable; this audio asset cannot be decoded.');
    }
    return () =>
      (audioLoader ?? loadAudio)(audioContext, asset.src, {
        signal: options.signal,
        fetchImpl,
      });
  }
  throw new TypeError(`Unsupported asset type "${asset.type}".`);
}

export async function loadAll(
  manifest: AssetManifest,
  {
    onProgress = () => {},
    signal,
    audioContext,
    fetchImpl = globalThis.fetch,
    imageLoader,
    jsonLoader,
    audioLoader,
    attempts = 3,
    baseMs = 150,
    random = Math.random,
    sleep = abortableDelay,
  }: LoadAllOptions = {},
): Promise<{
  readonly assets: Readonly<Record<string, unknown>>;
  readonly optionalErrors: readonly AssetLoadFailure[];
}> {
  const entries = Object.entries(manifest?.assets ?? {});
  if (entries.length === 0) {
    throw new TypeError('The asset manifest must contain at least one asset.');
  }
  throwIfAborted(signal);

  const assets: Record<string, unknown> = Object.create(null);
  const requiredFailures: AssetLoadFailure[] = [];
  const optionalErrors: AssetLoadFailure[] = [];
  let loaded = 0;

  const tasks = entries.map(async ([name, asset]) => {
    const timedOutSignal =
      asset.timeoutMs !== undefined &&
      Number.isFinite(asset.timeoutMs) &&
      typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(asset.timeoutMs)
        : undefined;
    const assetSignal = combineSignals([signal, timedOutSignal]);
    let assetError: unknown | null = null;
    try {
      const load = getAssetLoader(asset, {
        audioContext,
        fetchImpl,
        imageLoader,
        jsonLoader,
        audioLoader,
        signal: assetSignal,
      });
      assets[name] = await withRetry(load, {
        attempts,
        baseMs,
        signal: assetSignal,
        random,
        sleep,
      });
    } catch (error: unknown) {
      assetError = error;
      if (assetSignal?.aborted && signal?.aborted) {
        throw signal.reason ?? error;
      }
      if (asset.required === false) {
        optionalErrors.push({ name, error });
      } else {
        requiredFailures.push({ name, error });
      }
    } finally {
      loaded += 1;
      onProgress({
        loaded,
        total: entries.length,
        name,
        progress: loaded / entries.length,
        error: assetError,
      });
    }
  });

  await Promise.all(tasks);
  throwIfAborted(signal);
  if (requiredFailures.length > 0) {
    throw new AssetLoadError(requiredFailures, assets, optionalErrors);
  }
  return { assets, optionalErrors };
}
