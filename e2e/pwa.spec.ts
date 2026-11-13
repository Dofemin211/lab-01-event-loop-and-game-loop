import { expect, test } from '@playwright/test';

test('PWA manifest is installable and the cached app shell opens offline', async ({ page }) => {
  await page.goto('/');
  const manifestResponse = await page.request.get('/manifest.webmanifest');
  expect(manifestResponse.ok()).toBe(true);
  const manifest: unknown = await manifestResponse.json();
  expect(manifest).toMatchObject({
    name: 'Dogfight — Multiplayer Space Flight',
    start_url: '/',
    display: 'standalone',
    icons: expect.arrayContaining([
      expect.objectContaining({ src: '/icons/dogfight-192.png', sizes: '192x192' }),
      expect.objectContaining({ src: '/icons/dogfight-512.png', sizes: '512x512' }),
    ]),
  });
  expect((await page.request.get('/icons/dogfight-192.png')).ok()).toBe(true);
  expect((await page.request.get('/icons/dogfight-512.png')).ok()).toBe(true);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect(page.locator('#lobby-screen')).toBeVisible();
  await page.reload();
  await expect(page.locator('#lobby-screen')).toBeVisible();
  await page.context().setOffline(true);
  await page.reload();
  await expect(page.locator('#lobby-screen')).toBeVisible();
  const apiWasAvailableOffline = await page.evaluate(async () => {
    try {
      return (await fetch('/api/rooms')).ok;
    } catch {
      return false;
    }
  });
  expect(apiWasAvailableOffline).toBe(false);
  await page.context().setOffline(false);
});
