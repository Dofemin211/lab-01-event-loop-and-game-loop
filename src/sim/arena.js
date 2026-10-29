function wrapCoordinate(value, size) {
  return ((value % size) + size) % size;
}

export function wrapShip(ship, width, height) {
  if (width <= 0 || height <= 0) {
    throw new RangeError('Arena width and height must be positive.');
  }

  return {
    ...ship,
    x: wrapCoordinate(ship.x, width),
    y: wrapCoordinate(ship.y, height),
  };
}
