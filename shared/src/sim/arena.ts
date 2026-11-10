import type { VectorLike } from '../types.ts';

function wrapCoordinate(value: number, size: number): number {
  return ((value % size) + size) % size;
}

export function wrapShip<T extends VectorLike>(
  ship: T,
  width: number,
  height: number,
): Omit<T, 'x' | 'y'> & { readonly x: number; readonly y: number } {
  if (width <= 0 || height <= 0) {
    throw new RangeError('Arena width and height must be positive.');
  }

  return {
    ...ship,
    x: wrapCoordinate(ship.x, width),
    y: wrapCoordinate(ship.y, height),
  };
}
