import {
  CONTROL_PROTOCOL_VERSION,
  parseClientMessage as parseClientMessageResult,
  serverMessage,
} from '@dogfight/shared/protocol';
import type { ClientMessage, ProtocolParseError } from '@dogfight/shared/protocol';

export const PROTOCOL_VERSION = CONTROL_PROTOCOL_VERSION;
export { serverMessage };

export class ProtocolError extends Error {
  readonly closeCode: number;

  constructor(message: string, closeCode = 1008) {
    super(message);
    this.name = 'ProtocolError';
    this.closeCode = closeCode;
  }
}

function closeCode(error: ProtocolParseError, isBinary: boolean): number {
  if (error.code === 'invalid-json') return 1007;
  if (error.code === 'invalid-binary') return error.message.includes('not accepted') ? 1003 : 1002;
  if (!isBinary && error.code === 'invalid-version') return 1008;
  return 1008;
}

export function parseClientMessage(data: unknown, isBinary = false): ClientMessage {
  const result = parseClientMessageResult(data, isBinary);
  if (result.success) return result.data;
  throw new ProtocolError(result.error.message, closeCode(result.error, isBinary));
}
