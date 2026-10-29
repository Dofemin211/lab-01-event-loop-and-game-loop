import { World } from './world.js';

export function createSnapshot(world) {
  if (!(world instanceof World)) {
    throw new TypeError('createSnapshot expects a World.');
  }
  return structuredClone(world.toSnapshot());
}

export function restoreSnapshot(snapshot, options = {}) {
  return World.fromSnapshot(structuredClone(snapshot), options);
}
