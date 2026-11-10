import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { z } from 'zod';
import { createConfig } from '../server/src/config.ts';
import { createApplication } from '../server/src/index.ts';

interface BrowserProfile {
  startedAt: number;
  lastFrameTimestamp: number | null;
  readonly frameIntervals: number[];
  readonly callbackDurations: number[];
  readonly longTasks: number[];
  readonly gcDurations: number[];
  readonly longTaskSupported: boolean;
  readonly gcSupported: boolean;
  readonly stageDurations: Record<'simulate' | 'render' | 'decode' | 'reconcile', number[]>;
}

const browserProfileSchema = z.object({
  startedAt: z.number(),
  lastFrameTimestamp: z.number().nullable(),
  frameIntervals: z.array(z.number()),
  callbackDurations: z.array(z.number()),
  longTasks: z.array(z.number()),
  gcDurations: z.array(z.number()),
  longTaskSupported: z.boolean(),
  gcSupported: z.boolean(),
  stageDurations: z.object({
    simulate: z.array(z.number()),
    render: z.array(z.number()),
    decode: z.array(z.number()),
    reconcile: z.array(z.number()),
  }),
});

declare global {
  interface Window {
    __lab07Profile?: BrowserProfile;
  }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const durationSeconds = Number(process.env.BROWSER_PROFILE_DURATION_SECONDS ?? 30);
if (!Number.isFinite(durationSeconds) || durationSeconds < 1) {
  throw new RangeError('BROWSER_PROFILE_DURATION_SECONDS must be at least one second.');
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? (sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0) : 0;
}

function percentiles(values: readonly number[]) {
  return {
    p50: Number(percentile(values, 0.5).toFixed(3)),
    p95: Number(percentile(values, 0.95).toFixed(3)),
    p99: Number(percentile(values, 0.99).toFixed(3)),
  };
}

const logDir = await mkdtemp(path.join(tmpdir(), 'dogfight-lab07-browser-'));
const config = createConfig(
  {
    ...process.env,
    PORT: '0',
    MAX_PLAYERS_PER_ROOM: '10',
    LOG_DIR: logDir,
  },
  ROOT,
);
const application = createApplication({
  config,
  initialRooms: [
    {
      id: 'browser-profile',
      name: 'Browser profile',
      maxPlayers: 10,
      arena: { asteroidCount: 30, seed: 202508 },
    },
  ],
});

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const address = await application.start();
  if (!address || typeof address === 'string')
    throw new Error('Browser profile server did not start.');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const profile: BrowserProfile = {
      startedAt: 0,
      lastFrameTimestamp: null,
      frameIntervals: [],
      callbackDurations: [],
      longTasks: [],
      gcDurations: [],
      longTaskSupported: PerformanceObserver.supportedEntryTypes.includes('longtask'),
      gcSupported: PerformanceObserver.supportedEntryTypes.includes('gc'),
      stageDurations: { simulate: [], render: [], decode: [], reconcile: [] },
    };
    window.__lab07Profile = profile;
    const originalRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback: FrameRequestCallback): number =>
      originalRequestAnimationFrame((timestamp) => {
        const startedAt = performance.now();
        try {
          callback(timestamp);
        } finally {
          profile.callbackDurations.push(performance.now() - startedAt);
          if (profile.lastFrameTimestamp !== timestamp) {
            if (profile.lastFrameTimestamp !== null) {
              profile.frameIntervals.push(timestamp - profile.lastFrameTimestamp);
            }
            profile.lastFrameTimestamp = timestamp;
          }
        }
      });

    const measureObserver = new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) {
        const stage = entry.name.replace('dogfight.', '');
        if (
          stage === 'simulate' ||
          stage === 'render' ||
          stage === 'decode' ||
          stage === 'reconcile'
        ) {
          profile.stageDurations[stage].push(entry.duration);
        }
      }
    });
    measureObserver.observe({ entryTypes: ['measure'] });

    if (profile.longTaskSupported) {
      const longTaskObserver = new PerformanceObserver((entries) => {
        for (const entry of entries.getEntries()) profile.longTasks.push(entry.duration);
      });
      longTaskObserver.observe({ entryTypes: ['longtask'] });
    }
    if (profile.gcSupported) {
      const gcObserver = new PerformanceObserver((entries) => {
        for (const entry of entries.getEntries()) profile.gcDurations.push(entry.duration);
      });
      gcObserver.observe({ entryTypes: ['gc'] });
    }
  });

  await page.goto(`http://${address.address}:${address.port}/?experiments=1&net=1`);
  await page.locator('#lobby-screen').waitFor({ state: 'visible', timeout: 15_000 });
  await page.locator('#player-name').fill('Browser Profile');
  await page.getByRole('button', { name: /Browser profile/ }).click();
  await page.getByRole('button', { name: 'Join selected room' }).click();
  await page.locator('#multiplayer-panel').waitFor({ state: 'visible', timeout: 10_000 });

  const botResponse = await page.request.post(
    `http://${address.address}:${address.port}/api/rooms/browser-profile/bots`,
    { data: { count: 8 } },
  );
  if (!botResponse.ok()) {
    throw new Error(`Could not add browser profiling bots: HTTP ${botResponse.status()}.`);
  }
  await page.locator('#room-roster li').nth(8).waitFor({ state: 'attached', timeout: 10_000 });
  await page.keyboard.down('w');
  await page.keyboard.down('f');
  await page.evaluate((seconds) => {
    const profile = window.__lab07Profile;
    if (!profile) throw new Error('Browser performance instrumentation was not installed.');
    profile.frameIntervals.length = 0;
    profile.callbackDurations.length = 0;
    profile.longTasks.length = 0;
    profile.gcDurations.length = 0;
    for (const stage of Object.values(profile.stageDurations)) stage.length = 0;
    profile.lastFrameTimestamp = null;
    profile.startedAt = performance.now();
    window.setTimeout(() => {
      const output = document.createElement('script');
      output.id = 'lab07-profile-result';
      output.type = 'application/json';
      output.textContent = JSON.stringify(profile);
      document.body.append(output);
    }, seconds * 1000);
  }, durationSeconds);
  await page.locator('#lab07-profile-result').waitFor({
    state: 'attached',
    timeout: (durationSeconds + 15) * 1000,
  });
  const profileJson = await page.locator('#lab07-profile-result').textContent();
  if (!profileJson) throw new Error('Browser profile result was empty.');
  const parsedProfile: unknown = JSON.parse(profileJson);
  const profile = browserProfileSchema.parse(parsedProfile);
  const report = {
    measuredAt: new Date().toISOString(),
    durationSeconds,
    browser: await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      devicePixelRatio: window.devicePixelRatio,
    })),
    workload: { humanPlayers: 1, authoritativeBots: 8, asteroids: 30, humanHolding: ['W', 'F'] },
    frames: {
      samples: profile.frameIntervals.length,
      intervalMs: percentiles(profile.frameIntervals),
      callbackDurationMs: percentiles(profile.callbackDurations),
    },
    stages: Object.fromEntries(
      Object.entries(profile.stageDurations).map(([name, values]) => [name, percentiles(values)]),
    ),
    longTasks: {
      count: profile.longTasks.length,
      totalDurationMs: Number(
        profile.longTasks.reduce((sum, duration) => sum + duration, 0).toFixed(2),
      ),
    },
    browserGc: {
      supported: profile.gcSupported,
      count: profile.gcDurations.length,
      totalDurationMs: Number(
        profile.gcDurations.reduce((sum, duration) => sum + duration, 0).toFixed(2),
      ),
    },
    limitations: [
      'Chromium runs headless; frame intervals are the browser-reported requestAnimationFrame cadence, not display scan-out measurements.',
      'Long-task observer reports main-thread tasks of at least 50 ms; browser allocation sites and a DevTools heap snapshot are not collected.',
    ],
  };
  await mkdir(path.join(ROOT, 'evidence'), { recursive: true });
  await writeFile(
    path.join(ROOT, 'evidence', 'lab07-browser-profile.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  console.log(JSON.stringify(report, null, 2));
  await page.keyboard.up('w');
  await page.keyboard.up('f');
} finally {
  await browser?.close();
  await application.shutdown();
  await rm(logDir, { recursive: true, force: true });
}
