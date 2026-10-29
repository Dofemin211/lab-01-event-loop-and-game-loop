export class HttpError extends Error {
  constructor(url, status, statusText = '') {
    super(`Request failed for ${url}: HTTP ${status}${statusText ? ` ${statusText}` : ''}`);
    this.name = 'HttpError';
    this.url = url;
    this.status = status;
  }
}

export class AssetLoadError extends AggregateError {
  constructor(failures, assets, optionalErrors) {
    super(
      failures.map(({ name, error }) => new Error(`${name}: ${error.message}`)),
      `Required assets failed to load: ${failures.map(({ name }) => name).join(', ')}`,
    );
    this.name = 'AssetLoadError';
    this.failures = failures;
    this.assets = assets;
    this.optionalErrors = optionalErrors;
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
  }
}

function abortableDelay(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function fetchJson(url, { signal, fetchImpl = globalThis.fetch } = {}) {
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

export function loadJson(url, options = {}) {
  return fetchJson(url, options);
}

export async function loadImage(
  src,
  {
    signal,
    ImageCtor = globalThis.Image,
    fetchImpl = globalThis.fetch,
    createObjectURL = (blob) => URL.createObjectURL(blob),
    revokeObjectURL = (url) => URL.revokeObjectURL(url),
  } = {},
) {
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
        reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
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

export async function loadAudio(ctx, url, { signal, fetchImpl = globalThis.fetch } = {}) {
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
  fn,
  { attempts = 3, baseMs = 150, signal, random = Math.random, sleep = abortableDelay } = {},
) {
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

function combineSignals(signals) {
  const availableSignals = signals.filter(Boolean);
  if (availableSignals.length === 0) {
    return undefined;
  }
  if (availableSignals.length === 1) {
    return availableSignals[0];
  }
  return AbortSignal.any(availableSignals);
}

function getAssetLoader(asset, options) {
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
  manifest,
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
  } = {},
) {
  const entries = Object.entries(manifest?.assets ?? {});
  if (entries.length === 0) {
    throw new TypeError('The asset manifest must contain at least one asset.');
  }
  throwIfAborted(signal);

  const assets = Object.create(null);
  const requiredFailures = [];
  const optionalErrors = [];
  let loaded = 0;

  const tasks = entries.map(async ([name, asset]) => {
    const timedOutSignal =
      Number.isFinite(asset.timeoutMs) && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(asset.timeoutMs)
        : undefined;
    const assetSignal = combineSignals([signal, timedOutSignal]);
    let assetError = null;
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
    } catch (error) {
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
