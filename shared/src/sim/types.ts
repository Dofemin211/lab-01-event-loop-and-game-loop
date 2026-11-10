import type { Asteroid } from './asteroid.ts';
import type { Bullet } from './bullet.ts';
import type { Explosion } from './explosion.ts';
import type { Pickup } from './pickup.ts';
import type { Ship } from './ship.ts';

export type GameEntity = Ship | Asteroid | Bullet | Pickup | Explosion;

export type CollisionEvent =
  | { readonly type: 'asteroid-destroyed'; readonly entity: Asteroid }
  | { readonly type: 'asteroid-hit'; readonly entity: Asteroid }
  | { readonly type: 'ship-destroyed'; readonly entity: Ship }
  | { readonly type: 'ship-hit'; readonly entity: Ship }
  | { readonly type: 'pickup-collected'; readonly entity: Pickup; readonly ship: Ship };
