function createRandomGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function createStarfield(width, height, count = 110) {
  const random = createRandomGenerator(2025);
  return Array.from({ length: count }, () => ({
    x: random() * width,
    y: random() * height,
    radius: 0.5 + random() * 1.1,
    alpha: 0.25 + random() * 0.65,
  }));
}

export function drawStarfield(context, stars, width, height) {
  context.fillStyle = '#c9e8ff';
  for (const star of stars) {
    context.globalAlpha = star.alpha;
    context.beginPath();
    context.arc(star.x % width, star.y % height, star.radius, 0, Math.PI * 2);
    context.fill();
  }
  context.globalAlpha = 1;
}

function isDrawableImage(image) {
  return Boolean(image && image.complete !== false && image.naturalWidth > 0);
}

export function drawShip(context, ship, spriteSheet = null) {
  context.save();
  context.translate(ship.x, ship.y);
  context.rotate(ship.angle);
  context.lineJoin = 'round';

  if (ship.thrust > 0) {
    context.beginPath();
    context.moveTo(-9, -5);
    context.lineTo(-19 - Math.random() * 9, 0);
    context.lineTo(-9, 5);
    context.closePath();
    context.fillStyle = '#ff9e59';
    context.fill();

    context.beginPath();
    context.moveTo(-9, -2.5);
    context.lineTo(-16 - Math.random() * 5, 0);
    context.lineTo(-9, 2.5);
    context.closePath();
    context.fillStyle = '#ffe29a';
    context.fill();
  }

  if (isDrawableImage(spriteSheet)) {
    context.drawImage(spriteSheet, 0, 0, 32, 32, -16, -16, 32, 32);
  } else {
    context.beginPath();
    context.moveTo(17, 0);
    context.lineTo(-11, -10);
    context.lineTo(-7, 0);
    context.lineTo(-11, 10);
    context.closePath();
    context.fillStyle = '#d9f3ff';
    context.fill();
    context.strokeStyle = '#5fd4ff';
    context.lineWidth = 1.5;
    context.stroke();
  }
  context.restore();
}

export function drawHud(context, stats) {
  context.save();
  context.font = '12px ui-monospace, SFMono-Regular, Consolas, monospace';
  context.textBaseline = 'top';
  context.fillStyle = 'rgba(5, 16, 28, 0.72)';
  context.fillRect(16, 16, 206, 75);
  context.fillStyle = '#8ea8bb';
  context.fillText('SIMULATION', 28, 26);
  context.fillText('RENDER', 28, 46);
  context.fillText('FRAME TIME', 28, 66);
  context.fillStyle = '#d9f3ff';
  context.textAlign = 'right';
  context.fillText(`${stats.simulationStepsPerSecond.toFixed(0)} steps/s`, 210, 26);
  context.fillText(`${stats.renderedFramesPerSecond.toFixed(0)} frames/s`, 210, 46);
  context.fillText(`${stats.frameTimeMs.toFixed(2)} ms`, 210, 66);
  context.restore();
}

function drawBullet(context, entity, x, y, spriteSheet) {
  if (isDrawableImage(spriteSheet)) {
    context.drawImage(spriteSheet, 40, 8, 16, 16, x - 5, y - 5, 10, 10);
    return;
  }
  context.save();
  context.shadowBlur = 12;
  context.shadowColor = '#68e2ff';
  context.fillStyle = '#b7f4ff';
  context.beginPath();
  context.arc(x, y, entity.radius, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawAsteroid(context, entity, x, y, angle, spriteSheet) {
  if (isDrawableImage(spriteSheet)) {
    context.save();
    context.translate(x, y);
    context.rotate(angle);
    context.drawImage(
      spriteSheet,
      64,
      0,
      48,
      48,
      -entity.radius,
      -entity.radius,
      entity.radius * 2,
      entity.radius * 2,
    );
    context.restore();
    return;
  }
  const facets = 9;
  context.save();
  context.translate(x, y);
  context.rotate(angle);
  context.beginPath();
  for (let index = 0; index <= facets; index += 1) {
    const vertexAngle = (index / facets) * Math.PI * 2;
    const variation = 0.78 + ((entity.id * (index + 7)) % 17) / 100;
    const radius = entity.radius * variation;
    const vertexX = Math.cos(vertexAngle) * radius;
    const vertexY = Math.sin(vertexAngle) * radius;
    if (index === 0) {
      context.moveTo(vertexX, vertexY);
    } else {
      context.lineTo(vertexX, vertexY);
    }
  }
  context.closePath();
  context.fillStyle = '#35485a';
  context.fill();
  context.strokeStyle = entity.homing ? '#f5ae71' : '#8298a9';
  context.lineWidth = 1.5;
  context.stroke();
  context.restore();
}

function drawPickup(context, entity, x, y, timestamp) {
  const shield = entity.effect === 'shield';
  const color = shield ? '#73e6d1' : '#ffd477';
  const pulse = 1 + Math.sin(timestamp * 0.005 + entity.id) * 0.08;
  context.save();
  context.translate(x, y);
  context.scale(pulse, pulse);
  context.shadowBlur = 13;
  context.shadowColor = color;
  context.strokeStyle = color;
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(0, -entity.radius);
  context.lineTo(entity.radius, 0);
  context.lineTo(0, entity.radius);
  context.lineTo(-entity.radius, 0);
  context.closePath();
  context.stroke();
  context.restore();
}

function drawExplosion(context, entity) {
  for (const particle of entity.particles ?? []) {
    context.globalAlpha = Math.max(0, particle.remaining / particle.lifetime);
    context.fillStyle = '#ffbd75';
    context.beginPath();
    context.arc(particle.pos.x, particle.pos.y, 2, 0, Math.PI * 2);
    context.fill();
  }
  context.globalAlpha = 1;
  if ((!entity.particles || entity.particles.length === 0) && entity.radius > 0) {
    const alpha = Math.min(1, Math.max(0, entity.ttl / 0.95));
    context.save();
    context.globalAlpha = alpha;
    context.translate(entity.pos.x, entity.pos.y);
    context.strokeStyle = '#ffbd75';
    context.lineWidth = 2;
    context.shadowBlur = 12;
    context.shadowColor = '#ff9e59';
    context.beginPath();
    context.arc(0, 0, entity.radius * (1 - alpha * 0.25), 0, Math.PI * 2);
    context.stroke();
    context.restore();
  }
}

function drawEntity(context, entity, x, y, angle, timestamp, spriteSheet) {
  if (entity.kind === 'ship') {
    if (entity.invulnerableTime > 0 && Math.floor(timestamp / 90) % 2 === 0) {
      context.globalAlpha = 0.45;
    }
    drawShip(context, { x, y, angle, thrust: entity.thrust }, spriteSheet);
    context.globalAlpha = 1;
  } else if (entity.kind === 'bullet') {
    drawBullet(context, entity, x, y, spriteSheet);
  } else if (entity.kind === 'asteroid') {
    drawAsteroid(context, entity, x, y, angle, spriteSheet);
  } else if (entity.kind === 'pickup') {
    drawPickup(context, entity, x, y, timestamp);
  } else if (entity.kind === 'explosion') {
    drawExplosion(context, entity);
  }
}

function drawGameHud(context, stats, gameStats, width) {
  drawHud(context, stats);
  context.save();
  context.font = '12px ui-monospace, SFMono-Regular, Consolas, monospace';
  context.textBaseline = 'top';
  context.fillStyle = 'rgba(5, 16, 28, 0.78)';
  context.fillRect(width - 196, 16, 180, 63);
  context.fillStyle = '#8ea8bb';
  context.fillText('SCORE', width - 182, 26);
  context.fillText('HULL', width - 182, 48);
  context.textAlign = 'right';
  context.fillStyle = '#d9f3ff';
  context.fillText(String(gameStats.score).padStart(6, '0'), width - 28, 26);
  const hull = gameStats.player ? '◆'.repeat(gameStats.player.hp) : 'RESPAWNING';
  context.fillStyle = gameStats.player?.effects.has('shield') ? '#73e6d1' : '#d9f3ff';
  context.fillText(hull, width - 28, 48);
  context.restore();
}

function interpolateAngle(previous, current, alpha) {
  const difference = Math.atan2(Math.sin(current - previous), Math.cos(current - previous));
  return previous + difference * alpha;
}

export function drawWorldScene(
  context,
  width,
  height,
  stars,
  world,
  stats,
  gameStats,
  previousStates,
  alpha,
  timestamp = 0,
  assets = {},
) {
  context.clearRect(0, 0, width, height);
  context.fillStyle = '#081522';
  context.fillRect(0, 0, width, height);
  drawStarfield(context, stars, width, height);

  for (const entity of world) {
    if (!entity.alive) {
      continue;
    }
    const previous = previousStates.get(entity.id);
    const x = previous
      ? entity.kind === 'ship'
        ? interpolateWrapped(previous.x, entity.pos.x, alpha, width)
        : previous.x + (entity.pos.x - previous.x) * alpha
      : entity.pos.x;
    const y = previous
      ? entity.kind === 'ship'
        ? interpolateWrapped(previous.y, entity.pos.y, alpha, height)
        : previous.y + (entity.pos.y - previous.y) * alpha
      : entity.pos.y;
    const angle = previous ? interpolateAngle(previous.angle, entity.angle, alpha) : entity.angle;
    drawEntity(context, entity, x, y, angle, timestamp, assets.sprites);
  }

  drawGameHud(context, stats, gameStats, width);
  if (!gameStats.player) {
    context.save();
    context.textAlign = 'center';
    context.fillStyle = '#d9f3ff';
    context.font = '600 19px "Space Grotesk", sans-serif';
    context.fillText(
      `SHIP LOST — RESPAWNING ${Math.ceil(gameStats.respawnRemaining)}s`,
      width / 2,
      height / 2 + 54,
    );
    context.restore();
  }
}

function interpolateWrapped(previous, current, alpha, size) {
  let difference = current - previous;
  if (difference > size / 2) {
    difference -= size;
  } else if (difference < -size / 2) {
    difference += size;
  }
  return (((previous + difference * alpha) % size) + size) % size;
}

export function drawLoadingScreen(context, width, height, { progress = 0, status, error = null }) {
  context.clearRect(0, 0, width, height);
  context.fillStyle = '#081522';
  context.fillRect(0, 0, width, height);
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = '#d9f3ff';
  context.font = '600 24px "Space Grotesk", sans-serif';
  context.fillText(
    error ? 'ASSET LOADING FAILED' : 'PREPARING FLIGHT DECK',
    width / 2,
    height / 2 - 54,
  );
  context.fillStyle = '#91aabb';
  context.font = '14px "DM Mono", monospace';
  context.fillText(status, width / 2, height / 2 - 20);
  const barWidth = Math.min(420, width - 48);
  const barX = (width - barWidth) / 2;
  context.fillStyle = 'rgba(137, 199, 230, 0.18)';
  context.fillRect(barX, height / 2 + 12, barWidth, 12);
  context.fillStyle = error ? '#ff8b79' : '#63d3ff';
  context.fillRect(barX, height / 2 + 12, barWidth * Math.max(0, Math.min(1, progress)), 12);
  if (error) {
    context.fillStyle = '#ffb2a5';
    context.font = '12px "DM Mono", monospace';
    context.fillText(error, width / 2, height / 2 + 48);
  }
}

export function drawScene(context, width, height, stars, ship, stats) {
  context.clearRect(0, 0, width, height);
  context.fillStyle = '#081522';
  context.fillRect(0, 0, width, height);
  drawStarfield(context, stars, width, height);
  drawShip(context, ship);
  drawHud(context, stats);
}
