import test from 'node:test';
import assert from 'node:assert/strict';
import { GameAudio } from '../src/audio.js';
import { createGameEventTarget, emitGameEvent } from '../src/events.js';
import { connectHud } from '../src/hud.js';

class MockSource extends EventTarget {
  start() {
    MockSource.started += 1;
  }

  connect() {}

  disconnect() {
    MockSource.disconnected += 1;
  }
}
MockSource.started = 0;
MockSource.disconnected = 0;

class MockAudioContext {
  state = 'suspended';
  destination = {};
  sources = [];

  async resume() {
    this.state = 'running';
  }

  createBufferSource() {
    const source = new MockSource();
    this.sources.push(source);
    return source;
  }
}

test('Audio unlock follows a gesture, event sounds can overlap, and listeners dispose', async () => {
  MockSource.started = 0;
  MockSource.disconnected = 0;
  const events = createGameEventTarget();
  const audio = new GameAudio(events, { AudioContextClass: MockAudioContext });
  audio.setBuffers({ shoot: { id: 'shoot' }, hit: { id: 'hit' }, explosion: { id: 'explosion' } });

  emitGameEvent(events, 'fired', {});
  assert.equal(MockSource.started, 0);
  assert.equal(await audio.unlock(), true);
  emitGameEvent(events, 'fired', {});
  emitGameEvent(events, 'fired', {});
  emitGameEvent(events, 'hit', {});

  assert.equal(MockSource.started, 3);
  assert.equal(audio.context.sources.length, 3);
  audio.context.sources[0].dispatchEvent(new Event('ended'));
  assert.equal(MockSource.disconnected, 1);
  audio.dispose();
  emitGameEvent(events, 'fired', {});
  assert.equal(MockSource.started, 3);
});

test('HUD listens to score, room, and audio-state events and removes its listeners', () => {
  const events = createGameEventTarget();
  const element = { textContent: '' };
  const disconnect = connectHud(events, element);
  emitGameEvent(events, 'scoreChanged', { score: 200 });
  assert.equal(element.textContent, 'Score 200');
  emitGameEvent(events, 'roomJoined', { room: { name: 'Training sector' } });
  assert.equal(element.textContent, 'Joined Training sector');
  emitGameEvent(events, 'audioError', { message: 'Sound disabled' });
  assert.equal(element.textContent, 'Sound disabled');
  disconnect();
  emitGameEvent(events, 'scoreChanged', { score: 300 });
  assert.equal(element.textContent, 'Sound disabled');
});
