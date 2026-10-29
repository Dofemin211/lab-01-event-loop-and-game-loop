import test from 'node:test';
import assert from 'node:assert/strict';
import { drawShip, drawWorldScene } from '../src/render/draw.js';
import { Ship } from '../src/sim/ship.js';
import { World } from '../src/sim/world.js';

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
