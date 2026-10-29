export const PROTOCOL_VERSION = 0;
export const CLIENT_MESSAGE_TYPES = Object.freeze(['join', 'chat']);

const ROOM_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CONTROL_CHARACTERS = (value) =>
  [...value].some((character) => {
    const code = character.codePointAt(0);
    return code < 0x20 || code === 0x7f;
  });

export class ProtocolError extends Error {
  constructor(message, closeCode = 1008) {
    super(message);
    this.name = 'ProtocolError';
    this.closeCode = closeCode;
  }
}

export function parseClientMessage(data, isBinary = false) {
  if (isBinary) {
    throw new ProtocolError('Only JSON text messages are supported.', 1003);
  }

  let message;
  try {
    message = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
  } catch {
    throw new ProtocolError('Message must contain valid JSON.', 1007);
  }

  if (
    !message ||
    typeof message !== 'object' ||
    Array.isArray(message) ||
    message.version !== PROTOCOL_VERSION ||
    typeof message.type !== 'string'
  ) {
    throw new ProtocolError('Message must include a supported version and type.');
  }

  if (!CLIENT_MESSAGE_TYPES.includes(message.type)) {
    throw new ProtocolError('Message type is not supported.');
  }

  if (message.type === 'join') {
    if (Object.keys(message).some((key) => !['version', 'type', 'room', 'name'].includes(key))) {
      throw new ProtocolError('Join message contains unsupported fields.');
    }
    if (
      typeof message.room !== 'string' ||
      !ROOM_ID_PATTERN.test(message.room) ||
      typeof message.name !== 'string'
    ) {
      throw new ProtocolError('Join message must include a valid room and player name.');
    }
    const name = message.name.trim();
    if (name.length < 1 || name.length > 24 || CONTROL_CHARACTERS(name)) {
      throw new ProtocolError('Player name must contain 1–24 printable characters.');
    }
    return { version: PROTOCOL_VERSION, type: 'join', room: message.room, name };
  }

  if (
    Object.keys(message).some((key) => !['version', 'type', 'text'].includes(key)) ||
    typeof message.text !== 'string'
  ) {
    throw new ProtocolError('Chat message must include text.');
  }
  const text = message.text.trim();
  if (text.length < 1 || text.length > 500 || CONTROL_CHARACTERS(text)) {
    throw new ProtocolError('Chat text must contain 1–500 printable characters.');
  }
  return { version: PROTOCOL_VERSION, type: 'chat', text };
}

export function serverMessage(type, payload = {}) {
  return JSON.stringify({ version: PROTOCOL_VERSION, type, ...payload });
}
