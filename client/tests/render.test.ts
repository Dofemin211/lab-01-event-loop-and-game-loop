import test from 'node:test';
import assert from 'node:assert/strict';
import {
  drawLoadingScreen,
  drawShip,
  drawWorldScene,
  type DrawableEntity,
} from '../src/render/draw.ts';
import type { PickupEffect } from '@dogfight/shared/sim';
import { Ship } from '@dogfight/shared/sim/ship';
import { World } from '@dogfight/shared/sim/world';

type RecordingContext = {
  labels: string[];
  fillStyle: string;
  globalAlpha: number;
  font: string;
  textBaseline: CanvasTextBaseline;
  textAlign: CanvasTextAlign;
  lineJoin: CanvasLineJoin;
  lineWidth: number;
  strokeStyle: CanvasRenderingContext2D['strokeStyle'];
  shadowBlur: number;
  shadowColor: string;
  arc(): void;
  beginPath(): void;
  clearRect(): void;
  closePath(): void;
  fill(): void;
  fillRect(...coordinates: number[]): void;
  fillText(text: string): void;
  drawImage(image: unknown, ...coordinates: number[]): void;
  lineTo(): void;
  moveTo(): void;
  restore(): void;
  rotate(): void;
  save(): void;
  scale(): void;
  stroke(): void;
  translate(): void;
};

function createRecordingContext(): RecordingContext {
  const labels: string[] = [];
  return {
    labels,
    fillStyle: '',
    globalAlpha: 1,
    font: '',
    textBaseline: 'top',
    textAlign: 'start',
    lineJoin: 'miter',
    lineWidth: 1,
    strokeStyle: '',
    shadowBlur: 0,
    shadowColor: '',
    arc() {},
    beginPath() {},
    clearRect() {},
    closePath() {},
    fill() {},
    fillRect(..._coordinates: number[]) {},
    fillText(text: string) {
      labels.push(text);
    },
    drawImage(_image: unknown, ..._coordinates: number[]) {},
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

function drawableEntities(world: World): DrawableEntity[] {
  return [...world].map((entity): DrawableEntity => {
    const snapshot = entity.toSnapshot();
    return {
      ...snapshot,
      x: entity.pos.x,
      y: entity.pos.y,
      vx: entity.vel.x,
      vy: entity.vel.y,
      thrust: entity.kind === 'ship' ? entity.thrust : 0,
      hp: entity.kind === 'ship' || entity.kind === 'asteroid' ? entity.hp : 0,
      shield: entity.kind === 'ship' && entity.effects.has('shield'),
      ...(entity.kind === 'pickup' ? { effect: entity.effect } : {}),
      invulnerableTime: entity.kind === 'ship' ? entity.invulnerableTime : 0,
      ownerId: entity.kind === 'bullet' ? (entity.ownerId ?? entity.id) : entity.id,
      commandSeq: entity.kind === 'bullet' ? entity.commandSeq : 0,
      ttl: entity.kind === 'bullet' || entity.kind === 'pickup' ? entity.ttl : 0,
      score: entity.kind === 'ship' ? entity.score : 0,
      alive: entity.alive,
      collidable: entity.collidable,
      pos: entity.pos,
      vel: entity.vel,
      effects:
        entity.kind === 'ship'
          ? new Set<PickupEffect>(entity.effects.keys())
          : new Set<PickupEffect>(),
      particles: entity.kind === 'explosion' ? entity.particles : [],
      homing: entity.kind === 'asteroid' && entity.homing !== null,
    };
  });
}

function isDrawableShip(
  entity: DrawableEntity,
): entity is Extract<DrawableEntity, { kind: 'ship' }> {
  return entity.kind === 'ship';
}

function spriteImage(): CanvasImageSource {
  // The fake sprite provides only dimensions checked by the drawing code.
  return { complete: true, naturalWidth: 112 } as unknown as HTMLImageElement;
}

test('shared HUD draws Lab 01 timing metrics and Lab 02 score and hull', () => {
  const world = new World();
  world.spawn(new Ship(100, 100, { invulnerableTime: 0 }));
  const entities = drawableEntities(world);
  const player = entities.find(isDrawableShip);
  assert.ok(player);
  const context = createRecordingContext();

  drawWorldScene(
    context,
    800,
    600,
    [],
    entities,
    {
      simulationStepsPerSecond: 60,
      renderedFramesPerSecond: 120,
      frameTimeMs: 2.5,
      frameIntervalMs: 0,
      frameTimeJitterMs: 0,
      totalSteps: 0,
      totalFrames: 0,
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
  const sourceRects: number[][] = [];
  context.drawImage = (_image, ...coordinates) => {
    sourceRects.push(coordinates.slice(0, 4));
  };
  const sprites = spriteImage();
  const world = new World();
  const ship = world.spawn(new Ship(100, 100, { invulnerableTime: 0 }));
  const asteroid = world.addAsteroid(200, 200);
  const bullet = ship.fire(world);
  const entities = drawableEntities(world);
  const drawableShip = entities.find(isDrawableShip);
  assert.ok(drawableShip);
  const stats = {
    simulationStepsPerSecond: 60,
    renderedFramesPerSecond: 60,
    frameTimeMs: 1,
    frameIntervalMs: 0,
    frameTimeJitterMs: 0,
    totalSteps: 0,
    totalFrames: 0,
  };

  drawWorldScene(
    context,
    800,
    600,
    [],
    entities,
    stats,
    { score: 0, player: drawableShip, respawnRemaining: 0 },
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
  const fillRects: number[][] = [];
  context.fillRect = (...coordinates) => fillRects.push(coordinates);

  drawLoadingScreen(context, 800, 600, {
    progress: 0.4,
    status: '2/5 assets ready',
  });
  assert.ok(context.labels.includes('PREPARING FLIGHT DECK'));
  assert.ok(context.labels.includes('2/5 assets ready'));
  const progressBar = fillRects.at(-1);
  assert.ok(progressBar);
  assert.equal(progressBar[2], 168);

  drawLoadingScreen(context, 800, 600, {
    progress: 0.4,
    status: 'Required game content did not load.',
    error: 'arena: invalid JSON',
  });
  assert.ok(context.labels.includes('ASSET LOADING FAILED'));
  assert.ok(context.labels.includes('arena: invalid JSON'));
});
