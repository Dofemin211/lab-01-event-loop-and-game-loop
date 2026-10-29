const CONTROL_CODES = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'KeyA',
  'KeyD',
  'KeyR',
  'KeyW',
  'Space',
]);

export function createInput(target) {
  const down = new Set();
  const pressed = new Set();

  function handleKeyDown(event) {
    if (!CONTROL_CODES.has(event.code)) {
      return;
    }

    const eventTarget = event.target;
    if (
      eventTarget &&
      typeof eventTarget.closest === 'function' &&
      eventTarget.closest('input, select, textarea, [contenteditable="true"]')
    ) {
      return;
    }

    event.preventDefault();
    if (!down.has(event.code)) {
      down.add(event.code);
      pressed.add(event.code);
    }
  }

  function handleKeyUp(event) {
    down.delete(event.code);
  }

  function clear() {
    down.clear();
    pressed.clear();
  }

  target.addEventListener('keydown', handleKeyDown);
  target.addEventListener('keyup', handleKeyUp);
  target.addEventListener('blur', clear);

  return {
    isDown: (code) => down.has(code),
    justPressed: (code) => pressed.has(code),
    // Keep an edge-triggered press until a simulation step consumes it.
    endFrame: () => pressed.clear(),
    clear,
  };
}
