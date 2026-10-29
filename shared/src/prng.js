export function mulberry32(seed) {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  random.getState = () => state;
  random.setState = (nextState) => {
    if (!Number.isInteger(nextState) || nextState < 0 || nextState > 0xffffffff) {
      throw new RangeError('PRNG state must be an unsigned 32-bit integer.');
    }
    state = nextState >>> 0;
  };
  return random;
}
