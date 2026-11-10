import { integrate } from '@dogfight/shared/sim';
import type { InputReader, ShipState } from '@dogfight/shared/sim';
import type { SnapshotEntity, SnapshotMessage } from '@dogfight/shared/protocol';
import type { DrawableEntity } from './render/draw.ts';
import type { InputState } from './input.ts';
import { measureStage } from './performance.ts';

const TICK_RATE = 30;
const STEP = 1 / TICK_RATE;
const SHIP_RADIUS = 13;

interface SnapshotBufferOptions {
  readonly capacity?: number;
  readonly width?: number;
  readonly height?: number;
}

interface BufferedSnapshot {
  readonly tick: number;
  readonly receivedAt: number;
  readonly entities: readonly SnapshotEntity[];
}

export interface SequencedInput {
  readonly seq: number;
  readonly tick: number;
  readonly turn: -1 | 0 | 1;
  readonly thrust: boolean;
  readonly brake: boolean;
  readonly fire: boolean;
}

export interface PendingInput {
  readonly command: SequencedInput;
  readonly dt: number;
}

export interface ReconciliationResult {
  readonly state: ShipState;
  readonly pending: readonly PendingInput[];
}

export function reconcilePrediction(
  authoritative: ShipState,
  pending: readonly PendingInput[],
  acknowledgedSeq: number,
  width: number,
  height: number,
): ReconciliationResult {
  return measureStage('reconcile', () => {
    const remaining = pending.filter(({ command }) => command.seq > acknowledgedSeq);
    let state = authoritative;
    for (const input of remaining) {
      state = wrapShip(integrate(state, keyboardFor(input.command), input.dt), width, height);
    }
    return { state, pending: remaining };
  });
}

interface PredictedBullet {
  readonly id: number;
  readonly commandSeq: number;
  readonly ownerId: number | null;
  x: number;
  y: number;
  vx: number;
  vy: number;
  readonly angle: number;
  readonly radius: number;
  ttl: number;
}

interface ClientNetcodeOptions {
  readonly width?: number;
  readonly height?: number;
  readonly sendInput?: (command: SequencedInput) => boolean;
  readonly interpolationDelayMs?: number;
}

interface NetworkPlayerIdentity {
  readonly id: string;
  readonly entityId?: number;
}

export class SnapshotBuffer {
  readonly capacity: number;
  readonly width: number;
  readonly height: number;
  readonly snapshots: BufferedSnapshot[] = [];

  constructor({ capacity = 32, width = 960, height = 600 }: SnapshotBufferOptions = {}) {
    if (!Number.isInteger(capacity) || capacity < 2) {
      throw new RangeError('Snapshot buffer capacity must be at least two.');
    }
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
      throw new RangeError('Snapshot buffer dimensions must be positive.');
    }
    this.capacity = capacity;
    this.width = width;
    this.height = height;
  }

  add(snapshot: SnapshotMessage, receivedAt: number): boolean {
    if (
      !Number.isSafeInteger(snapshot.tick) ||
      !Array.isArray(snapshot.entities) ||
      !Number.isFinite(receivedAt)
    ) {
      throw new TypeError('Snapshot buffer received invalid data.');
    }
    const last = this.snapshots.at(-1);
    if (last && snapshot.tick <= last.tick) return false;
    this.snapshots.push({ tick: snapshot.tick, receivedAt, entities: snapshot.entities });
    if (this.snapshots.length > this.capacity) this.snapshots.shift();
    return true;
  }

  interpolate(targetTick: number): SnapshotEntity[] {
    if (this.snapshots.length === 0) return [];
    const first = this.snapshots[0];
    const last = this.snapshots.at(-1);
    if (!first || !last) return [];
    if (this.snapshots.length === 1 || targetTick <= first.tick) {
      return first.entities.map((entity) => ({ ...entity }));
    }
    if (targetTick >= last.tick) return last.entities.map((entity) => ({ ...entity }));

    let before = first;
    let after = last;
    for (let index = 1; index < this.snapshots.length; index += 1) {
      const current = this.snapshots[index];
      const previous = this.snapshots[index - 1];
      if (current && previous && current.tick >= targetTick) {
        before = previous;
        after = current;
        break;
      }
    }
    const span = after.tick - before.tick;
    const alpha = span > 0 ? (targetTick - before.tick) / span : 1;
    const beforeById = new Map(before.entities.map((entity) => [entity.id, entity]));
    const afterById = new Map(after.entities.map((entity) => [entity.id, entity]));
    const result: SnapshotEntity[] = [];
    for (const entity of before.entities) {
      const next = afterById.get(entity.id);
      if (!next) {
        if (alpha < 0.5) result.push({ ...entity });
        continue;
      }
      result.push(interpolateEntity(entity, next, alpha, this.width, this.height));
    }
    for (const entity of after.entities) {
      if (!beforeById.has(entity.id) && alpha >= 0.5) result.push({ ...entity });
    }
    return result;
  }

  estimatedTick(now: number): number {
    const latest = this.snapshots.at(-1);
    if (!latest) return 0;
    return latest.tick + (Math.max(0, now - latest.receivedAt) * TICK_RATE) / 1000;
  }

  get latest(): BufferedSnapshot | null {
    return this.snapshots.at(-1) ?? null;
  }
}

function interpolateEntity(
  previous: SnapshotEntity,
  current: SnapshotEntity,
  alpha: number,
  width: number,
  height: number,
): SnapshotEntity {
  if (previous.kind !== current.kind) {
    return alpha < 0.5 ? previous : current;
  }
  const difference = Math.atan2(
    Math.sin(current.angle - previous.angle),
    Math.cos(current.angle - previous.angle),
  );
  return {
    ...current,
    x:
      current.kind === 'ship'
        ? interpolateWrapped(previous.x, current.x, alpha, width)
        : previous.x + (current.x - previous.x) * alpha,
    y:
      current.kind === 'ship'
        ? interpolateWrapped(previous.y, current.y, alpha, height)
        : previous.y + (current.y - previous.y) * alpha,
    vx: previous.vx + (current.vx - previous.vx) * alpha,
    vy: previous.vy + (current.vy - previous.vy) * alpha,
    angle: previous.angle + difference * alpha,
    thrust: alpha < 0.5 ? previous.thrust : current.thrust,
  };
}

function interpolateWrapped(
  previous: number,
  current: number,
  alpha: number,
  size: number,
): number {
  let difference = current - previous;
  if (difference > size / 2) difference -= size;
  else if (difference < -size / 2) difference += size;
  return (((previous + difference * alpha) % size) + size) % size;
}

function shortestDelta(from: number, to: number, size: number): number {
  let difference = to - from;
  if (difference > size / 2) difference -= size;
  else if (difference < -size / 2) difference += size;
  return difference;
}

function wrapCoordinate(value: number, size: number): number {
  return ((value % size) + size) % size;
}

export class ClientNetcode {
  readonly width: number;
  readonly height: number;
  readonly sendInput: (command: SequencedInput) => boolean;
  buffer: SnapshotBuffer;
  interpolationDelayMs: number;
  localPlayerId: string | null = null;
  localEntityId: number | null = null;
  predicted: ShipState | null = null;
  pending: PendingInput[] = [];
  predictedBullets: PredictedBullet[] = [];
  localFireCooldown = 0;
  seq = 0;
  tick = 0;
  accumulator = 0;
  correction = 0;
  smoothOffset = { x: 0, y: 0 };
  lastCorrectionAt = 0;
  determinismBreak = false;

  constructor({
    width = 960,
    height = 600,
    sendInput = () => false,
    interpolationDelayMs = 100,
  }: ClientNetcodeOptions = {}) {
    this.width = width;
    this.height = height;
    this.sendInput = sendInput;
    this.buffer = new SnapshotBuffer({ width, height });
    this.interpolationDelayMs = interpolationDelayMs;
  }

  setIdentity(player: NetworkPlayerIdentity): void {
    if (!player || typeof player.id !== 'string' || !Number.isInteger(player.entityId)) {
      throw new TypeError('Network player identity is invalid.');
    }
    if (player.entityId === undefined) {
      throw new TypeError('Network player entity identity is missing.');
    }
    this.localPlayerId = player.id;
    this.localEntityId = player.entityId;
    this.seq = 0;
    this.tick = 0;
    this.predicted = null;
    this.pending = [];
    this.predictedBullets = [];
    this.buffer = new SnapshotBuffer({ width: this.width, height: this.height });
  }

  setInterpolationDelay(delayMs: number): void {
    if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 500) {
      throw new RangeError('Interpolation delay must be between 0 and 500 ms.');
    }
    this.interpolationDelayMs = delayMs;
  }

  setDeterminismBreak(enabled: boolean): void {
    if (typeof enabled !== 'boolean') {
      throw new TypeError('Determinism experiment setting must be a boolean.');
    }
    this.determinismBreak = enabled;
  }

  step(dt: number, input: InputState): void {
    if (!Number.isFinite(dt) || dt < 0) throw new RangeError('dt must be non-negative.');
    this.accumulator += dt;
    while (this.accumulator >= STEP) {
      this.accumulator -= STEP;
      this.tick += 1;
      this.localFireCooldown = Math.max(0, this.localFireCooldown - STEP);
      this.#advanceBullets(STEP);
      const turningRight = input.isDown('ArrowRight') || input.isDown('KeyD');
      const turningLeft = input.isDown('ArrowLeft') || input.isDown('KeyA');
      const turn: -1 | 0 | 1 = turningRight === turningLeft ? 0 : turningRight ? 1 : -1;
      const command: SequencedInput = {
        seq: ++this.seq,
        tick: this.tick,
        turn,
        thrust: input.isDown('ArrowUp') || input.isDown('KeyW'),
        brake: input.isDown('Space'),
        fire: input.isDown('KeyF'),
      };
      if (this.predicted) {
        this.predicted = wrapShip(
          integrate(this.predicted, keyboardFor(command), STEP),
          this.width,
          this.height,
        );
        if (this.determinismBreak) {
          this.predicted = {
            ...this.predicted,
            x: wrapCoordinate(this.predicted.x + 1, this.width),
          };
        }
        this.pending.push({ command, dt: STEP });
        if (command.fire && this.localFireCooldown <= 0) {
          this.#predictBullet(command.seq);
          this.localFireCooldown = 0.22;
        }
      }
      this.sendInput(command);
      if (this.pending.length > 256) this.pending.shift();
    }
    const smoothing = Math.exp(-Math.max(0, dt) / 0.1);
    this.smoothOffset.x *= smoothing;
    this.smoothOffset.y *= smoothing;
  }

  receiveSnapshot(snapshot: SnapshotMessage, receivedAt = performance.now()): boolean {
    if (!this.buffer.add(snapshot, receivedAt)) return false;
    const ownEntity = snapshot.entities.find((entity) => entity.id === this.localEntityId);
    if (!ownEntity || ownEntity.kind !== 'ship') return true;
    const ack = snapshot.acks.find((item) => item.entityId === this.localEntityId)?.seq ?? 0;
    const before = this.predicted;
    const authoritative: ShipState = {
      x: ownEntity.x,
      y: ownEntity.y,
      vx: ownEntity.vx,
      vy: ownEntity.vy,
      angle: ownEntity.angle,
      thrust: ownEntity.thrust,
    };
    const result = reconcilePrediction(authoritative, this.pending, ack, this.width, this.height);
    this.pending = [...result.pending];
    const reconciled = result.state;
    this.predicted = reconciled;
    if (before) {
      const correctionX = shortestDelta(before.x, reconciled.x, this.width);
      const correctionY = shortestDelta(before.y, reconciled.y, this.height);
      this.correction = Math.hypot(correctionX, correctionY);
      this.smoothOffset.x -= correctionX;
      this.smoothOffset.y -= correctionY;
      this.lastCorrectionAt = receivedAt;
    }
    const authoritativeShots = new Set(
      snapshot.entities
        .filter((entity) => entity.kind === 'bullet' && entity.ownerId === this.localEntityId)
        .map((entity) => entity.commandSeq),
    );
    this.predictedBullets = this.predictedBullets.filter(
      (bullet) => !authoritativeShots.has(bullet.commandSeq),
    );
    return true;
  }

  resetPrediction(): void {
    const latest = this.buffer.latest;
    const ownEntity = latest?.entities.find((entity) => entity.id === this.localEntityId);
    if (ownEntity?.kind === 'ship') {
      this.predicted = {
        x: ownEntity.x,
        y: ownEntity.y,
        vx: ownEntity.vx,
        vy: ownEntity.vy,
        angle: ownEntity.angle,
        thrust: ownEntity.thrust,
      };
      this.pending = [];
    }
  }

  renderEntities(now = performance.now()): DrawableEntity[] {
    const latest = this.buffer.latest;
    if (!latest) return [];
    const targetTick =
      this.buffer.estimatedTick(now) - (this.interpolationDelayMs * TICK_RATE) / 1000;
    const entities = this.buffer.interpolate(targetTick);
    const local = this.predicted;
    const localIndex = entities.findIndex((entity) => entity.id === this.localEntityId);
    const localSnapshot = latest.entities.find(
      (entity) => entity.id === this.localEntityId && entity.kind === 'ship',
    );
    if (local && localSnapshot?.kind === 'ship') {
      const renderLocal: SnapshotEntity = {
        ...localSnapshot,
        ...local,
        x: wrapCoordinate(local.x + this.smoothOffset.x, this.width),
        y: wrapCoordinate(local.y + this.smoothOffset.y, this.height),
      };
      if (localIndex >= 0) entities[localIndex] = renderLocal;
      else entities.push(renderLocal);
    }
    const drawable = entities.map(toDrawableEntity);
    for (const bullet of this.predictedBullets) {
      if (bullet.ownerId === null) continue;
      drawable.push({
        ...bullet,
        kind: 'bullet',
        alive: true,
        collidable: false,
        pos: { x: bullet.x, y: bullet.y },
        vel: { x: bullet.vx, y: bullet.vy },
        hp: 1,
        thrust: 0,
        shield: false,
        invulnerableTime: 0,
        ttl: bullet.ttl,
        score: 0,
        effects: new Set(),
        particles: [],
        radius: bullet.radius,
      });
    }
    return drawable;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  #predictBullet(commandSeq: number): void {
    if (!this.predicted) return;
    const speed = 460;
    const dx = Math.cos(this.predicted.angle);
    const dy = Math.sin(this.predicted.angle);
    this.predictedBullets.push({
      id: -commandSeq,
      commandSeq,
      ownerId: this.localEntityId,
      x: this.predicted.x + dx * (SHIP_RADIUS + 5),
      y: this.predicted.y + dy * (SHIP_RADIUS + 5),
      vx: this.predicted.vx + dx * speed,
      vy: this.predicted.vy + dy * speed,
      angle: this.predicted.angle,
      radius: 3,
      ttl: 1.8,
    });
  }

  #advanceBullets(dt: number): void {
    this.predictedBullets = this.predictedBullets.filter((bullet) => {
      bullet.x += bullet.vx * dt;
      bullet.y += bullet.vy * dt;
      bullet.ttl -= dt;
      return (
        bullet.ttl > 0 &&
        bullet.x >= 0 &&
        bullet.x <= this.width &&
        bullet.y >= 0 &&
        bullet.y <= this.height
      );
    });
  }
}

function keyboardFor(command: SequencedInput): InputReader {
  return {
    isDown(code: string): boolean {
      if (code === 'ArrowLeft' || code === 'KeyA') return command.turn < 0;
      if (code === 'ArrowRight' || code === 'KeyD') return command.turn > 0;
      if (code === 'ArrowUp' || code === 'KeyW') return command.thrust;
      if (code === 'Space') return command.brake;
      if (code === 'KeyF') return command.fire;
      return false;
    },
  };
}

function wrapShip(ship: ShipState, width = 960, height = 600): ShipState {
  return {
    ...ship,
    x: wrapCoordinate(ship.x, width),
    y: wrapCoordinate(ship.y, height),
  };
}

function toDrawableEntity(entity: SnapshotEntity): DrawableEntity {
  return {
    ...entity,
    alive: true,
    collidable: false,
    pos: { x: entity.x, y: entity.y },
    vel: { x: entity.vx, y: entity.vy },
    effects: new Set(entity.kind === 'ship' && entity.shield ? ['shield'] : []),
    particles: [],
  };
}
