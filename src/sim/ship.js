export const SHIP_TUNING = Object.freeze({
  rotationSpeed: 4.2,
  thrustAcceleration: 280,
  drag: 0.18,
  maxSpeed: 320,
  brakeStrength: 3.5,
});

export function createShip(x = 0, y = 0) {
  return { x, y, vx: 0, vy: 0, angle: -Math.PI / 2, thrust: 0 };
}

export function integrate(ship, input, dt) {
  if (!Number.isFinite(dt) || dt < 0) {
    throw new RangeError('dt must be a non-negative finite number.');
  }

  const turn =
    Number(input.isDown('ArrowRight') || input.isDown('KeyD')) -
    Number(input.isDown('ArrowLeft') || input.isDown('KeyA'));
  const isThrusting = input.isDown('ArrowUp') || input.isDown('KeyW');
  const isBraking = input.isDown('Space');
  const angle = ship.angle + turn * SHIP_TUNING.rotationSpeed * dt;
  const acceleration = isThrusting ? SHIP_TUNING.thrustAcceleration : 0;
  const drag = Math.exp(-(SHIP_TUNING.drag + (isBraking ? SHIP_TUNING.brakeStrength : 0)) * dt);
  let vx = (ship.vx + Math.cos(angle) * acceleration * dt) * drag;
  let vy = (ship.vy + Math.sin(angle) * acceleration * dt) * drag;
  const speed = Math.hypot(vx, vy);

  if (speed > SHIP_TUNING.maxSpeed) {
    const speedScale = SHIP_TUNING.maxSpeed / speed;
    vx *= speedScale;
    vy *= speedScale;
  }

  return {
    x: ship.x + vx * dt,
    y: ship.y + vy * dt,
    vx,
    vy,
    angle,
    thrust: isThrusting ? 1 : 0,
  };
}

function interpolateCoordinate(previous, current, alpha, size) {
  if (!size) {
    return previous + (current - previous) * alpha;
  }

  let difference = current - previous;
  if (difference > size / 2) {
    difference -= size;
  } else if (difference < -size / 2) {
    difference += size;
  }
  return (((previous + difference * alpha) % size) + size) % size;
}

export function interpolateShip(previous, current, alpha, width, height) {
  const angleDifference = Math.atan2(
    Math.sin(current.angle - previous.angle),
    Math.cos(current.angle - previous.angle),
  );
  return {
    x: interpolateCoordinate(previous.x, current.x, alpha, width),
    y: interpolateCoordinate(previous.y, current.y, alpha, height),
    vx: previous.vx + (current.vx - previous.vx) * alpha,
    vy: previous.vy + (current.vy - previous.vy) * alpha,
    angle: previous.angle + angleDifference * alpha,
    thrust: alpha < 0.5 ? previous.thrust : current.thrust,
  };
}
