import { emitGameEvent } from './events.js';

const SOUND_BY_EVENT = Object.freeze({
  fired: 'shoot',
  hit: 'hit',
  exploded: 'explosion',
});

export class GameAudio {
  #buffers = new Map();
  #listeners = new Map();

  constructor(eventTarget, { AudioContextClass = globalThis.AudioContext } = {}) {
    this.eventTarget = eventTarget;
    try {
      this.context = AudioContextClass ? new AudioContextClass() : null;
    } catch (error) {
      this.context = null;
      emitGameEvent(this.eventTarget, 'audioError', {
        message: `Web Audio could not start; the game will continue without sound: ${error.message}`,
      });
    }

    for (const [eventName, bufferName] of Object.entries(SOUND_BY_EVENT)) {
      const listener = () => this.play(bufferName);
      this.#listeners.set(eventName, listener);
      this.eventTarget.addEventListener(eventName, listener);
    }
  }

  setBuffers(buffers) {
    for (const [name, buffer] of Object.entries(buffers)) {
      if (buffer) {
        this.#buffers.set(name, buffer);
      }
    }
  }

  async unlock() {
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
    } catch (error) {
      emitGameEvent(this.eventTarget, 'audioError', {
        message: `Audio could not be enabled: ${error.message}`,
      });
      return false;
    }
  }

  play(name) {
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
    } catch (error) {
      emitGameEvent(this.eventTarget, 'audioError', {
        message: `A sound effect could not play: ${error.message}`,
      });
      return false;
    }
  }

  dispose() {
    for (const [eventName, listener] of this.#listeners) {
      this.eventTarget.removeEventListener(eventName, listener);
    }
    this.#listeners.clear();
  }
}

export function createAudio(eventTarget, options) {
  return new GameAudio(eventTarget, options);
}
