export const CONTROL_PROTOCOL_VERSION = 0;
export const BINARY_PROTOCOL_VERSION = 1;
export const CLIENT_MESSAGE_TYPES = Object.freeze(['join', 'chat', 'input', 'ping']);
export const MESSAGE_KIND = Object.freeze({
  input: 1,
  snapshot: 2,
  ping: 3,
  pong: 4,
});

export function validateInputCommand(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw new TypeError('Input command must be an object.');
  }
  if (!Number.isSafeInteger(command.seq) || command.seq < 1 || command.seq > 0xffffffff) {
    throw new RangeError('Input sequence must be an unsigned 32-bit integer above zero.');
  }
  if (!Number.isSafeInteger(command.tick) || command.tick < 0 || command.tick > 0xffffffff) {
    throw new RangeError('Input tick must be an unsigned 32-bit integer.');
  }
  if (!Number.isInteger(command.turn) || command.turn < -1 || command.turn > 1) {
    throw new RangeError('Input turn must be -1, 0, or 1.');
  }
  if (
    typeof command.thrust !== 'boolean' ||
    typeof command.brake !== 'boolean' ||
    typeof command.fire !== 'boolean'
  ) {
    throw new TypeError('Input thrust, brake, and fire flags must be booleans.');
  }
  if (
    Object.keys(command).some(
      (key) => !['seq', 'tick', 'turn', 'thrust', 'brake', 'fire'].includes(key),
    )
  ) {
    throw new TypeError('Input command contains unsupported fields.');
  }
  return {
    seq: command.seq,
    tick: command.tick,
    turn: command.turn,
    thrust: command.thrust,
    brake: command.brake,
    fire: command.fire,
  };
}

export function inputToKeyboard(command) {
  return {
    isDown(code) {
      if (code === 'ArrowLeft' || code === 'KeyA') return command.turn < 0;
      if (code === 'ArrowRight' || code === 'KeyD') return command.turn > 0;
      if (code === 'ArrowUp' || code === 'KeyW') return command.thrust;
      if (code === 'Space') return command.brake;
      if (code === 'KeyF') return command.fire;
      return false;
    },
  };
}
