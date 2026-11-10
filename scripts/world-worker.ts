import { parentPort } from 'node:worker_threads';
import { integrate } from '@dogfight/shared/sim';
import type { ShipState, InputReader } from '@dogfight/shared/sim';

interface WorkerRequest {
  readonly state: ShipState;
  readonly steps: number;
}

const port = parentPort;
if (!port) throw new Error('The simulation worker requires a parent port.');

const controls: InputReader = {
  isDown(code: string): boolean {
    return code === 'KeyW' || code === 'ArrowRight';
  },
};

port.on('message', ({ state: initial, steps }: WorkerRequest) => {
  let state = initial;
  for (let index = 0; index < steps; index += 1) {
    state = integrate(state, controls, 1 / 60);
  }
  port.postMessage(state);
});
