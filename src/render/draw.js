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

export function drawShip(context, ship) {
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

export function drawScene(context, width, height, stars, ship, stats) {
  context.clearRect(0, 0, width, height);
  context.fillStyle = '#081522';
  context.fillRect(0, 0, width, height);
  drawStarfield(context, stars, width, height);
  drawShip(context, ship);
  drawHud(context, stats);
}
