import { integrate } from '@dogfight/shared/sim/ship';

const TICK_RATE = 30;
const STEP = 1 / TICK_RATE;
const SHIP_RADIUS = 13;

export class SnapshotBuffer {
  constructor({ capacity = 32, width = 960, height = 600 } = {}) {
    if (!Number.isInteger(capacity) || capacity < 2) {
      throw new RangeError('Snapshot buffer capacity must be at least two.');
    }
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
      throw new RangeError('Snapshot buffer dimensions must be positive.');
    }
    this.capacity = capacity;
    this.width = width;
    this.height = height;
    this.snapshots = [];
  }

  add(snapshot, receivedAt) {
    if (
      !snapshot ||
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

  interpolate(targetTick) {
    if (this.snapshots.length === 0) return [];
    if (this.snapshots.length === 1 || targetTick <= this.snapshots[0].tick) {
      return this.snapshots[0].entities.map((entity) => ({ ...entity }));
    }
    const last = this.snapshots.at(-1);
    if (targetTick >= last.tick) return last.entities.map((entity) => ({ ...entity }));

    let before = this.snapshots[0];
    let after = last;
    for (let index = 1; index < this.snapshots.length; index += 1) {
      if (this.snapshots[index].tick >= targetTick) {
        before = this.snapshots[index - 1];
        after = this.snapshots[index];
        break;
      }
    }
    const span = after.tick - before.tick;
    const alpha = span > 0 ? (targetTick - before.tick) / span : 1;
    const beforeById = new Map(before.entities.map((entity) => [entity.id, entity]));
    const afterById = new Map(after.entities.map((entity) => [entity.id, entity]));
    const result = [];
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

  estimatedTick(now) {
    const latest = this.snapshots.at(-1);
    if (!latest) return 0;
    return latest.tick + (Math.max(0, now - latest.receivedAt) * TICK_RATE) / 1000;
  }

  get latest() {
    return this.snapshots.at(-1) ?? null;
  }
}

function interpolateEntity(previous, current, alpha, width, height) {
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

function interpolateWrapped(previous, current, alpha, size) {
  let difference = current - previous;
  if (difference > size / 2) difference -= size;
  else if (difference < -size / 2) difference += size;
  return (((previous + difference * alpha) % size) + size) % size;
}

function shortestDelta(from, to, size) {
  let difference = to - from;
  if (difference > size / 2) difference -= size;
  else if (difference < -size / 2) difference += size;
  return difference;
}

function wrapCoordinate(value, size) {
  return ((value % size) + size) % size;
}

export class ClientNetcode {
  constructor({
    width = 960,
    height = 600,
    sendInput = () => false,
    interpolationDelayMs = 100,
  } = {}) {
    this.width = width;
    this.height = height;
    this.sendInput = sendInput;
    this.buffer = new SnapshotBuffer({ width, height });
    this.interpolationDelayMs = interpolationDelayMs;
    this.localPlayerId = null;
    this.localEntityId = null;
    this.predicted = null;
    this.pending = [];
    this.predictedBullets = [];
    this.localFireCooldown = 0;
    this.seq = 0;
    this.tick = 0;
    this.accumulator = 0;
    this.correction = 0;
    this.smoothOffset = { x: 0, y: 0 };
    this.lastCorrectionAt = 0;
    this.determinismBreak = false;
  }

  setIdentity(player) {
    if (!player || typeof player.id !== 'string' || !Number.isInteger(player.entityId)) {
      throw new TypeError('Network player identity is invalid.');
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

  setInterpolationDelay(delayMs) {
    if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 500) {
      throw new RangeError('Interpolation delay must be between 0 and 500 ms.');
    }
    this.interpolationDelayMs = delayMs;
  }

  setDeterminismBreak(enabled) {
    if (typeof enabled !== 'boolean') {
      throw new TypeError('Determinism experiment setting must be a boolean.');
    }
    this.determinismBreak = enabled;
  }

  step(dt, input) {
    if (!Number.isFinite(dt) || dt < 0) throw new RangeError('dt must be non-negative.');
    this.accumulator += dt;
    while (this.accumulator >= STEP) {
      this.accumulator -= STEP;
      this.tick += 1;
      this.localFireCooldown = Math.max(0, this.localFireCooldown - STEP);
      this.#advanceBullets(STEP);
      const turn =
        Number(input.isDown('ArrowRight') || input.isDown('KeyD')) -
        Number(input.isDown('ArrowLeft') || input.isDown('KeyA'));
      const command = {
        seq: ++this.seq,
        tick: this.tick,
        turn,
        thrust: input.isDown('ArrowUp') || input.isDown('KeyW'),
        brake: input.isDown('Space'),
        fire: input.isDown('KeyF'),
      };
      if (this.predicted) {
        this.predicted = wrapShip(integrate(this.predicted, keyboardFor(command), STEP));
        if (this.determinismBreak) {
          this.predicted.x = wrapCoordinate(this.predicted.x + 1, this.width);
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

  receiveSnapshot(snapshot, receivedAt = performance.now()) {
    if (!this.buffer.add(snapshot, receivedAt)) return false;
    const ownEntity = snapshot.entities.find((entity) => entity.id === this.localEntityId);
    if (!ownEntity || ownEntity.kind !== 'ship') return true;
    const ack = snapshot.acks?.find((item) => item.entityId === this.localEntityId)?.seq ?? 0;
    const before = this.predicted;
    const authoritative = {
      x: ownEntity.x,
      y: ownEntity.y,
      vx: ownEntity.vx,
      vy: ownEntity.vy,
      angle: ownEntity.angle,
      thrust: ownEntity.thrust,
    };
    this.pending = this.pending.filter(({ command }) => command.seq > ack);
    let reconciled = authoritative;
    for (const pending of this.pending) {
      reconciled = wrapShip(integrate(reconciled, keyboardFor(pending.command), pending.dt));
    }
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

  resetPrediction() {
    const latest = this.buffer.latest;
    const ownEntity = latest?.entities.find((entity) => entity.id === this.localEntityId);
    if (ownEntity) {
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

  renderEntities(now = performance.now()) {
    const latest = this.buffer.latest;
    if (!latest) return [];
    const targetTick =
      this.buffer.estimatedTick(now) - (this.interpolationDelayMs * TICK_RATE) / 1000;
    const entities = this.buffer.interpolate(targetTick);
    const local = this.predicted;
    const localIndex = entities.findIndex((entity) => entity.id === this.localEntityId);
    if (local) {
      const renderLocal = {
        ...(localIndex >= 0
          ? entities[localIndex]
          : latest.entities.find((entity) => entity.id === this.localEntityId)),
        ...local,
        x: wrapCoordinate(local.x + this.smoothOffset.x, this.width),
        y: wrapCoordinate(local.y + this.smoothOffset.y, this.height),
      };
      if (localIndex >= 0) entities[localIndex] = renderLocal;
      else entities.push(renderLocal);
    }
    for (const bullet of this.predictedBullets) {
      entities.push({
        ...bullet,
        kind: 'bullet',
        alive: true,
        collidable: false,
        pos: { x: bullet.x, y: bullet.y },
        vel: { x: bullet.vx, y: bullet.vy },
      });
    }
    return entities.map(toDrawableEntity);
  }

  get pendingCount() {
    return this.pending.length;
  }

  #predictBullet(commandSeq) {
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

  #advanceBullets(dt) {
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

function keyboardFor(command) {
  return {
    isDown(code) {
      if (code === 'ArrowLeft' || code === 'KeyA') return command.turn < 0;
      if (code === 'ArrowRight' || code === 'KeyD') return command.turn > 0;
      if (code === 'ArrowUp' || code === 'KeyW') return command.thrust;
      if (code === 'Space') return command.brake;
      if (code === 'KeyF') return command.fire;
      return false;
    },
  };
}

function wrapShip(ship) {
  return {
    ...ship,
    x: ((ship.x % 960) + 960) % 960,
    y: ((ship.y % 600) + 600) % 600,
  };
}

function toDrawableEntity(entity) {
  return {
    ...entity,
    alive: true,
    collidable: false,
    pos: { x: entity.x, y: entity.y },
    vel: { x: entity.vx, y: entity.vy },
    effects: new Set(entity.shield ? ['shield'] : []),
    particles: [],
  };
}
