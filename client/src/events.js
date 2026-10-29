export function createGameEventTarget() {
  return new EventTarget();
}

export function emitGameEvent(target, type, detail) {
  target?.dispatchEvent(new CustomEvent(type, { detail }));
}
