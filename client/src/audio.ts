import { Bus, emitGameEvent } from './events.ts';
import type { GameEvents } from './events.ts';
import type { AudioBufferDecoder } from './assets/loader.ts';

type SoundName = 'shoot' | 'hit' | 'explosion';
type SoundEvent = 'fired' | 'hit' | 'exploded';
type SoundBuffer = object;

interface BufferSourceLike extends EventTarget {
  buffer: SoundBuffer | null;
  connect(destination: object): unknown;
  disconnect(): void;
  start(): void;
}

interface AudioContextLike extends AudioBufferDecoder {
  readonly destination: object;
  readonly state: string;
  resume(): Promise<void>;
  createBufferSource(): BufferSourceLike;
}

type AudioContextConstructor = new () => AudioContextLike;

const SOUND_BY_EVENT: readonly (readonly [SoundEvent, SoundName])[] = [
  ['fired', 'shoot'],
  ['hit', 'hit'],
  ['exploded', 'explosion'],
];
const SOUND_NAMES: readonly SoundName[] = ['shoot', 'hit', 'explosion'];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class GameAudio {
  readonly eventTarget: Bus<GameEvents>;
  context: AudioContextLike | null;
  readonly #buffers = new Map<SoundName, SoundBuffer>();
  readonly #unsubscribe: (() => void)[] = [];

  constructor(
    eventTarget: Bus<GameEvents>,
    {
      AudioContextClass = globalThis.AudioContext,
    }: { AudioContextClass?: AudioContextConstructor } = {},
  ) {
    this.eventTarget = eventTarget;
    try {
      this.context = AudioContextClass ? new AudioContextClass() : null;
    } catch (error: unknown) {
      this.context = null;
      emitGameEvent(this.eventTarget, 'audioError', {
        message: `Web Audio could not start; the game will continue without sound: ${errorMessage(error)}`,
      });
    }

    for (const [eventName, bufferName] of SOUND_BY_EVENT) {
      this.#unsubscribe.push(this.eventTarget.on(eventName, () => this.play(bufferName)));
    }
  }

  setBuffers(buffers: Readonly<Partial<Record<SoundName, SoundBuffer | null>>>): void {
    for (const name of SOUND_NAMES) {
      const buffer = buffers[name];
      if (buffer) {
        this.#buffers.set(name, buffer);
      }
    }
  }

  async unlock(): Promise<boolean> {
    if (!this.context) {
      emitGameEvent(this.eventTarget, 'audioError', {
        message: 'Web Audio is unavailable; the game will continue without sound.',
      });
      return false;
    }

    try {
      if (this.context.state !== 'running') {
        await this.context.resume();
      }
      return this.context.state === 'running';
    } catch (error: unknown) {
      emitGameEvent(this.eventTarget, 'audioError', {
        message: `Audio could not be enabled: ${errorMessage(error)}`,
      });
      return false;
    }
  }

  play(name: SoundName): boolean {
    const buffer = this.#buffers.get(name);
    if (!buffer || this.context?.state !== 'running') {
      return false;
    }

    try {
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.context.destination);
      source.addEventListener('ended', () => source.disconnect(), { once: true });
      source.start();
      return true;
    } catch (error: unknown) {
      emitGameEvent(this.eventTarget, 'audioError', {
        message: `A sound effect could not play: ${errorMessage(error)}`,
      });
      return false;
    }
  }

  dispose(): void {
    for (const unsubscribe of this.#unsubscribe) {
      unsubscribe();
    }
    this.#unsubscribe.length = 0;
  }
}

export function createAudio(
  eventTarget: Bus<GameEvents>,
  options?: { AudioContextClass?: AudioContextConstructor },
): GameAudio {
  return new GameAudio(eventTarget, options);
}
