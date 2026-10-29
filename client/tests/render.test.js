import test from 'node:test';
import assert from 'node:assert/strict';
import { drawLoadingScreen, drawShip, drawWorldScene } from '../src/render/draw.js';
import { Ship } from '@dogfight/shared/sim/ship';
import { World } from '@dogfight/shared/sim/world';

function createRecordingContext() {
  const labels = [];
  return {
    labels,
    arc() {},
    beginPath() {},
    clearRect() {},
    closePath() {},
    fill() {},
    fillRect() {},
    fillText(text) {
      labels.push(text);
    },
    lineTo() {},
    moveTo() {},
    restore() {},
    rotate() {},
    save() {},
    scale() {},
    stroke() {},
    translate() {},
  };
}

test('shared HUD draws Lab 01 timing metrics and Lab 02 score and hull', () => {
  const world = new World();
  const player = world.spawn(new Ship(100, 100, { invulnerableTime: 0 }));
  const context = createRecordingContext();

  drawWorldScene(
    context,
    800,
    600,
    [],
    world,
    {
      simulationStepsPerSecond: 60,
      renderedFramesPerSecond: 120,
      frameTimeMs: 2.5,
    },
    { score: 125, player, respawnRemaining: 0 },
    new Map(),
    0.5,
  );

  assert.ok(context.labels.includes('SIMULATION'));
  assert.ok(context.labels.includes('60 steps/s'));
  assert.ok(context.labels.includes('120 frames/s'));
  assert.ok(context.labels.includes('2.50 ms'));
  assert.ok(context.labels.includes('SCORE'));
  assert.ok(context.labels.includes('000125'));
  assert.ok(context.labels.includes('◆◆◆'));
});

test('Ship rendering adds both thrust-flame layers only while thrust is active', () => {
  const context = createRecordingContext();
  let fills = 0;
  context.fill = () => {
    fills += 1;
  };
  const ship = { x: 20, y: 30, angle: 0, thrust: 0 };

  drawShip(context, ship);
  const idleFills = fills;
  drawShip(context, { ...ship, thrust: 1 });

  assert.equal(idleFills, 1);
  assert.equal(fills, 4);
});

test('Ship, bullet, and asteroid draw from the expected sprite-sheet source rectangles', () => {
  const context = createRecordingContext();
  const sourceRects = [];
  context.drawImage = (_image, ...coordinates) => sourceRects.push(coordinates.slice(0, 4));
  const sprites = { complete: true, naturalWidth: 112 };
  const world = new World();
  const ship = world.spawn(new Ship(100, 100, { invulnerableTime: 0 }));
  const asteroid = world.addAsteroid(200, 200);
  const bullet = ship.fire(world);
  const stats = {
    simulationStepsPerSecond: 60,
    renderedFramesPerSecond: 60,
    frameTimeMs: 1,
  };

  drawWorldScene(
    context,
    800,
    600,
    [],
    world,
    stats,
    { score: 0, player: ship, respawnRemaining: 0 },
    new Map(),
    1,
    0,
    { sprites },
  );

  assert.ok(sourceRects.some((rect) => rect.join(',') === '0,0,32,32'));
  assert.ok(sourceRects.some((rect) => rect.join(',') === '40,8,16,16'));
  assert.ok(sourceRects.some((rect) => rect.join(',') === '64,0,48,48'));
  assert.ok(bullet);
  assert.ok(asteroid);
});

test('Loading canvas renders progress and clearly exposes required-asset failures', () => {
  const context = createRecordingContext();
  const fillRects = [];
  context.fillRect = (...coordinates) => fillRects.push(coordinates);

  drawLoadingScreen(context, 800, 600, { progress: 0.4, status: '2/5 assets ready' });
  assert.ok(context.labels.includes('PREPARING FLIGHT DECK'));
  assert.ok(context.labels.includes('2/5 assets ready'));
  assert.equal(fillRects.at(-1)[2], 168);

  drawLoadingScreen(context, 800, 600, {
    progress: 0.4,
    status: 'Required game content did not load.',
    error: 'arena: invalid JSON',
  });
  assert.ok(context.labels.includes('ASSET LOADING FAILED'));
  assert.ok(context.labels.includes('arena: invalid JSON'));
});
