import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AssetLoadError,
  HttpError,
  fetchJson,
  loadAll,
  loadAudio,
  loadImage,
  loadJson,
  withRetry,
} from '../src/assets/loader.js';

function response(body, { status = 200, statusText = 'OK' } = {}) {
  return new Response(body, {
    status,
    statusText,
    headers: { 'Content-Type': 'application/json' },
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test('fetchJson returns successful JSON and checks response.ok before parsing', async () => {
  const controller = new AbortController();
  const parsed = await fetchJson('/rooms.json', {
    fetchImpl: async (url, options) => {
      assert.equal(url, '/rooms.json');
      assert.equal(options.signal, controller.signal);
      return response('{"rooms":[{"id":"one"}]}');
    },
    signal: controller.signal,
  });
  assert.deepEqual(parsed, { rooms: [{ id: 'one' }] });

  await assert.rejects(
    fetchJson('/missing.json', { fetchImpl: async () => response('missing', { status: 404 }) }),
    (error) => error instanceof HttpError && error.status === 404,
  );
});

test('loadJson preserves JSON syntax errors as a rejected promise', async () => {
  await assert.rejects(
    loadJson('/broken.json', { fetchImpl: async () => response('{"broken":') }),
    SyntaxError,
  );
});

test('loadImage resolves only after load and rejects when its signal aborts', async () => {
  class MockImage extends EventTarget {
    complete = true;
    naturalWidth = 1;

    set src(value) {
      this.source = value;
      queueMicrotask(() => this.dispatchEvent(new Event('load')));
    }

    get src() {
      return this.source;
    }
  }
  const image = await loadImage('/sprite.svg', {
    ImageCtor: MockImage,
    fetchImpl: async () => new Response(new Blob(['<svg/>'])),
    createObjectURL: () => 'blob:sprite',
    revokeObjectURL: (url) => assert.equal(url, 'blob:sprite'),
  });
  assert.equal(image.src, 'blob:sprite');

  class WaitingImage extends EventTarget {
    set src(value) {
      this.source = value;
    }
  }
  const controller = new AbortController();
  const pending = loadImage('/slow.svg', {
    ImageCtor: WaitingImage,
    signal: controller.signal,
    fetchImpl: async () => new Response(new Blob(['<svg/>'])),
    createObjectURL: () => 'blob:slow',
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('loadAudio checks HTTP status and decodes its response before returning', async () => {
  const context = {
    decodeAudioData: async (buffer) => ({ byteLength: buffer.byteLength }),
  };
  const audio = await loadAudio(context, '/shoot.wav', {
    fetchImpl: async () => new Response(new Uint8Array([1, 2, 3])),
  });
  assert.equal(audio.byteLength, 3);

  await assert.rejects(
    loadAudio(context, '/missing.wav', {
      fetchImpl: async () => response('', { status: 404 }),
    }),
    (error) => error instanceof HttpError && error.status === 404,
  );

  const controller = new AbortController();
  await loadAudio(context, '/signal.wav', {
    signal: controller.signal,
    fetchImpl: async (_url, options) => {
      assert.equal(options.signal, controller.signal);
      return new Response(new Uint8Array([9]));
    },
  });
});

test('withRetry applies exponential delay and succeeds on a transient retry', async () => {
  let calls = 0;
  const delays = [];
  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) {
        throw new TypeError('temporary network failure');
      }
      return 'ready';
    },
    {
      attempts: 3,
      baseMs: 100,
      random: () => 0.5,
      sleep: async (ms) => delays.push(ms),
    },
  );
  assert.equal(result, 'ready');
  assert.equal(calls, 3);
  assert.deepEqual(delays, [50, 100]);
});

test('withRetry does not retry HTTP 4xx responses', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new HttpError('/missing', 404);
      },
      { attempts: 4, sleep: async () => assert.fail('4xx must not be retried') },
    ),
    (error) => error.status === 404,
  );
  assert.equal(calls, 1);
});

test('withRetry retries server errors but does not retry corrupt data', async () => {
  let serverCalls = 0;
  const serverResult = await withRetry(
    async () => {
      serverCalls += 1;
      if (serverCalls === 1) {
        throw new HttpError('/busy', 503, 'Unavailable');
      }
      return 'online';
    },
    { attempts: 2, sleep: async () => {} },
  );
  assert.equal(serverResult, 'online');
  assert.equal(serverCalls, 2);

  let parseCalls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        parseCalls += 1;
        throw new SyntaxError('invalid JSON');
      },
      { attempts: 3, sleep: async () => assert.fail('Corrupt JSON is not transient') },
    ),
    SyntaxError,
  );
  assert.equal(parseCalls, 1);
});

test('withRetry stops while waiting when its signal is aborted', async () => {
  const controller = new AbortController();
  const started = deferred();
  const pending = withRetry(
    async () => {
      throw new TypeError('offline');
    },
    {
      attempts: 5,
      signal: controller.signal,
      sleep: (ms, signal) =>
        new Promise((resolve, reject) => {
          started.resolve();
          const timer = setTimeout(resolve, ms);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    },
  );
  await started.promise;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('loadAll loads independent assets concurrently and reports settled-item progress', async () => {
  const first = deferred();
  const second = deferred();
  const progress = [];
  const started = [];
  const pending = loadAll(
    {
      assets: {
        first: { type: 'json', src: '/first.json' },
        second: { type: 'json', src: '/second.json' },
      },
    },
    {
      jsonLoader: (url) => {
        started.push(url);
        return url === '/first.json' ? first.promise : second.promise;
      },
      onProgress: (item) => progress.push(item),
      sleep: async () => {},
    },
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started.sort(), ['/first.json', '/second.json']);
  first.resolve({ id: 1 });
  second.resolve({ id: 2 });
  const result = await pending;
  assert.deepEqual(Object.keys(result.assets).sort(), ['first', 'second']);
  assert.equal(progress.length, 2);
  assert.equal(progress.at(-1).progress, 1);
});

test('loadAll reports optional failures but rejects when any required asset fails', async () => {
  const optional = await loadAll(
    {
      assets: {
        decoration: { type: 'image', src: '/missing.svg', required: false },
        arena: { type: 'json', src: '/arena.json' },
      },
    },
    {
      imageLoader: async () => {
        throw new HttpError('/missing.svg', 404);
      },
      jsonLoader: async () => ({ width: 800 }),
    },
  );
  assert.equal(optional.assets.arena.width, 800);
  assert.equal(optional.optionalErrors.length, 1);

  await assert.rejects(
    loadAll(
      { assets: { arena: { type: 'json', src: '/broken.json' } } },
      {
        jsonLoader: async () => {
          throw new SyntaxError('invalid JSON');
        },
      },
    ),
    (error) =>
      error instanceof AssetLoadError &&
      error.failures[0].name === 'arena' &&
      error.errors[0].message.includes('arena'),
  );
});

test('A sprite HTTP 404 is not retried and prevents a successful required-asset result', async () => {
  let requests = 0;
  await assert.rejects(
    loadAll(
      { assets: { sprites: { type: 'image', src: '/missing.svg' } } },
      {
        attempts: 5,
        imageLoader: async () => {
          requests += 1;
          throw new HttpError('/missing.svg', 404);
        },
        sleep: async () => assert.fail('A 404 must not be retried'),
      },
    ),
    (error) => error instanceof AssetLoadError,
  );
  assert.equal(requests, 1);
});

test('loadAll observes an already-aborted signal and timeout signals', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    loadAll(
      { assets: { arena: { type: 'json', src: '/arena.json' } } },
      { signal: controller.signal },
    ),
    { name: 'AbortError' },
  );

  const keepAlive = setTimeout(() => {}, 20);
  await assert.rejects(
    loadAll(
      {
        assets: {
          arena: { type: 'json', src: '/slow.json', timeoutMs: 5 },
        },
      },
      {
        jsonLoader: (_url, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
        sleep: async () => {},
      },
    ),
    (error) => error instanceof AssetLoadError && error.failures[0].error.name === 'TimeoutError',
  );
  clearTimeout(keepAlive);
});
