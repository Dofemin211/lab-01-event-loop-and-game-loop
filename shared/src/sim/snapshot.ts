import { World } from './world.ts';
import type { WorldOptions } from './world.ts';
import type { WorldSnapshot } from '../types.ts';

export function createSnapshot(world: World): WorldSnapshot {
  if (!(world instanceof World)) {
    throw new TypeError('createSnapshot expects a World.');
  }
  return structuredClone(world.toSnapshot());
}

export function restoreSnapshot(snapshot: WorldSnapshot, options: WorldOptions = {}): World {
  return World.fromSnapshot(structuredClone(snapshot), options);
}
