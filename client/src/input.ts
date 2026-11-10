const CONTROL_CODES: ReadonlySet<string> = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'KeyA',
  'KeyD',
  'KeyF',
  'KeyR',
  'KeyW',
  'Space',
]);

interface InputKeyEvent {
  readonly code: string;
  readonly target?: { closest?: (selectors: string) => unknown } | null;
  preventDefault(): void;
}

interface InputEventTarget {
  addEventListener(
    type: 'keydown' | 'keyup' | 'blur',
    listener: (event: InputKeyEvent) => void,
  ): void;
}

export interface InputState {
  isDown(code: string): boolean;
  justPressed(code: string): boolean;
  endFrame(): void;
  clear(): void;
}

export function createInput(target: InputEventTarget): InputState {
  const down = new Set<string>();
  const pressed = new Set<string>();

  function handleKeyDown(event: InputKeyEvent): void {
    if (!CONTROL_CODES.has(event.code)) {
      return;
    }

    const closest = event.target?.closest;
    if (
      typeof closest === 'function' &&
      closest.call(event.target, 'input, select, textarea, [contenteditable="true"]')
    ) {
      return;
    }

    event.preventDefault();
    if (!down.has(event.code)) {
      down.add(event.code);
      pressed.add(event.code);
    }
  }

  function handleKeyUp(event: InputKeyEvent): void {
    down.delete(event.code);
  }

  function clear(): void {
    down.clear();
    pressed.clear();
  }

  target.addEventListener('keydown', handleKeyDown);
  target.addEventListener('keyup', handleKeyUp);
  target.addEventListener('blur', clear);

  return {
    isDown: (code) => down.has(code),
    justPressed: (code) => pressed.has(code),
    endFrame: () => pressed.clear(),
    clear,
  };
}
