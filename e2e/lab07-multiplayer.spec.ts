import { expect, test } from '@playwright/test';
import { decodeBinary } from '@dogfight/shared/codec';
import type { BinaryMessage } from '@dogfight/shared/codec';
import { parseServerMessage } from '@dogfight/shared/protocol';
import type { ServerMessage } from '@dogfight/shared/protocol';

function trackShipSnapshots(page: import('@playwright/test').Page): number[] {
  const shipCounts: number[] = [];
  page.on('websocket', (socket) => {
    socket.on('framereceived', ({ payload }) => {
      let message: BinaryMessage | ServerMessage;
      if (typeof payload === 'string') {
        const parsed = parseServerMessage(payload);
        if (!parsed.success) return;
        message = parsed.data;
      } else {
        message = decodeBinary(payload);
      }
      if (message.type === 'snapshot') {
        shipCounts.push(message.entities.filter((entity) => entity.kind === 'ship').length);
      }
    });
  });
  return shipCounts;
}

test('two independent browser clients see both ships and share room chat', async ({ browser }) => {
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const firstPage = await firstContext.newPage();
  const secondPage = await secondContext.newPage();
  const firstShipCounts = trackShipSnapshots(firstPage);
  const secondShipCounts = trackShipSnapshots(secondPage);

  try {
    await Promise.all([firstPage.goto('/'), secondPage.goto('/')]);
    await expect(firstPage.locator('#lobby-screen')).toBeVisible();
    await expect(secondPage.locator('#lobby-screen')).toBeVisible();

    await firstPage.locator('#player-name').fill('Pilot One');
    await firstPage.getByRole('button', { name: /Training sector/ }).click();
    await firstPage.getByRole('button', { name: 'Join selected room' }).click();
    await expect(firstPage.locator('#multiplayer-panel')).toBeVisible();
    await expect(firstPage.locator('#room-roster')).toContainText('Pilot One');

    const roomRefresh = secondPage.waitForResponse((response) =>
      response.url().endsWith('/api/rooms'),
    );
    await secondPage.getByRole('button', { name: 'Refresh rooms' }).click();
    await roomRefresh;
    await secondPage.locator('#player-name').fill('Pilot Two');
    await secondPage.getByRole('button', { name: /Training sector/ }).click();
    await secondPage.getByRole('button', { name: 'Join selected room' }).click();
    await expect(secondPage.locator('#multiplayer-panel')).toBeVisible();

    await expect(firstPage.locator('#room-roster')).toContainText('Pilot Two');
    await expect(secondPage.locator('#room-roster')).toContainText('Pilot One');
    await expect
      .poll(() => firstShipCounts.some((count) => count >= 2), { timeout: 10_000 })
      .toBe(true);
    await expect
      .poll(() => secondShipCounts.some((count) => count >= 2), { timeout: 10_000 })
      .toBe(true);

    await firstPage.locator('#chat-input').fill('Lab 07 connection check');
    await firstPage.getByRole('button', { name: 'Send' }).click();
    await expect(firstPage.locator('#chat-messages')).toContainText(
      'Pilot One: Lab 07 connection check',
    );
    await expect(secondPage.locator('#chat-messages')).toContainText(
      'Pilot One: Lab 07 connection check',
    );
  } finally {
    await Promise.all([firstContext.close(), secondContext.close()]);
  }
});
