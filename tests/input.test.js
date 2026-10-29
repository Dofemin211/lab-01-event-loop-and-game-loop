import test from 'node:test';
import assert from 'node:assert/strict';
import { createInput } from '../src/input.js';

function createTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, callback) {
      listeners.set(type, callback);
    },
    emit(type, event) {
      listeners.get(type)(event);
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

  input.endFrame();
  assert.equal(input.justPressed('KeyW'), false);
  target.emit('keyup', { code: 'KeyW' });
  assert.equal(input.isDown('KeyW'), false);
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
