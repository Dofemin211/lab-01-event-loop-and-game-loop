import test from 'node:test';
import assert from 'node:assert/strict';
import { createInput } from '../src/input.ts';

type InputEvent = {
  code: string;
  preventDefault: () => void;
  target?: { closest?: (selector: string) => unknown } | null;
};

type InputEventName = 'keydown' | 'keyup' | 'blur';

function createTarget() {
  const listeners = new Map<InputEventName, (event: InputEvent) => void>();
  return {
    addEventListener(type: InputEventName, callback: (event: InputEvent) => void) {
      listeners.set(type, callback);
    },
    emit(type: InputEventName, event: InputEvent) {
      const listener = listeners.get(type);
      if (!listener) {
        throw new Error(`No listener registered for ${type}.`);
      }
      listener(event);
    },
  };
}

test('createInput tracks held keys and just-pressed edges privately', () => {
  const target = createTarget();
  const input = createInput(target);
  let prevented = false;

  target.emit('keydown', { code: 'KeyW', preventDefault: () => (prevented = true) });
  target.emit('keydown', { code: 'KeyW', preventDefault: () => {} });
  assert.equal(input.isDown('KeyW'), true);
  assert.equal(input.justPressed('KeyW'), true);
  assert.equal(prevented, true);
  target.emit('keyup', { code: 'KeyW', preventDefault: () => {} });
  target.emit('keydown', { code: 'KeyF', preventDefault: () => {} });
  assert.equal(input.isDown('KeyF'), true);

  input.endFrame();
  assert.equal(input.justPressed('KeyW'), false);
  target.emit('keyup', { code: 'KeyF', preventDefault: () => {} });
  assert.equal(input.isDown('KeyF'), false);
});

test('createInput leaves experiment controls usable with the keyboard', () => {
  const target = createTarget();
  const input = createInput(target);
  let prevented = false;

  target.emit('keydown', {
    code: 'ArrowDown',
    target: { closest: () => ({}) },
    preventDefault: () => (prevented = true),
  });

  assert.equal(input.isDown('ArrowDown'), false);
  assert.equal(prevented, false);
});
