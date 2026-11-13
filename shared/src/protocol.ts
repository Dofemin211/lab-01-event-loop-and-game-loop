import { z } from 'zod';
import { decodeBinary } from './codec.ts';
import { CONTROL_PROTOCOL_VERSION } from './protocol-constants.ts';
import { inputCommandSchema } from './input.ts';

export {
  BINARY_PROTOCOL_VERSION,
  CONTROL_PROTOCOL_VERSION,
  MESSAGE_KIND,
} from './protocol-constants.ts';
export { inputCommandSchema, inputToKeyboard, validateInputCommand } from './input.ts';

const uint32Schema = z.number().int().min(0).max(0xffff_ffff);
const float32Schema = z.number().finite().min(-3.4028234663852886e38).max(3.4028234663852886e38);
const printableText = (value: string): boolean =>
  ![...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code < 0x20 || code === 0x7f);
  });

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    version: z.literal(CONTROL_PROTOCOL_VERSION),
    type: z.literal('join'),
    room: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    name: z.string().trim().min(1).max(24).refine(printableText),
    codec: z.enum(['binary', 'json']).optional(),
  }),
  z.strictObject({
    version: z.literal(CONTROL_PROTOCOL_VERSION),
    type: z.literal('chat'),
    text: z.string().trim().min(1).max(500).refine(printableText),
  }),
  z.strictObject({
    version: z.literal(CONTROL_PROTOCOL_VERSION),
    type: z.literal('input'),
    ...inputCommandSchema.shape,
  }),
  z.strictObject({
    version: z.literal(CONTROL_PROTOCOL_VERSION),
    type: z.literal('ping'),
    sentAt: z.number().finite(),
  }),
]);

const roomSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  name: z.string().min(1).max(48),
  players: z.number().int().min(0).max(64),
  maxPlayers: z.number().int().min(1).max(64),
  arena: z.strictObject({
    asteroidCount: z.number().int().min(0).max(100),
    seed: z.number().int(),
  }),
});

const playerSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1).max(24),
  entityId: uint32Schema.optional(),
});

const snapshotEntityCommonSchema = {
  id: uint32Schema,
  x: float32Schema,
  y: float32Schema,
  vx: float32Schema,
  vy: float32Schema,
  angle: float32Schema,
  radius: float32Schema.min(0),
  thrust: z.number().finite(),
  hp: z.number().int().min(0).max(255),
  shield: z.boolean(),
  invulnerableTime: float32Schema.min(0),
  ownerId: uint32Schema,
  commandSeq: uint32Schema,
  ttl: float32Schema.min(0),
  score: uint32Schema,
};

export const snapshotEntitySchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...snapshotEntityCommonSchema, kind: z.literal('ship') }),
  z.strictObject({ ...snapshotEntityCommonSchema, kind: z.literal('asteroid') }),
  z.strictObject({ ...snapshotEntityCommonSchema, kind: z.literal('bullet') }),
  z.strictObject({
    ...snapshotEntityCommonSchema,
    kind: z.literal('pickup'),
    effect: z.enum(['shield', 'rapid-fire', 'repair']),
  }),
  z.strictObject({ ...snapshotEntityCommonSchema, kind: z.literal('explosion') }),
]);

const snapshotSchema = z.strictObject({
  version: z.literal(CONTROL_PROTOCOL_VERSION),
  type: z.literal('snapshot'),
  tick: uint32Schema,
  entities: z.array(snapshotEntitySchema).max(1000),
  acks: z.array(z.strictObject({ entityId: uint32Schema, seq: uint32Schema })).max(64),
});

const chatMessageSchema = z.strictObject({
  id: z.string().min(1),
  playerId: z.string().min(1),
  name: z.string().min(1).max(24),
  text: z.string().min(1).max(500),
  timestamp: z.number().finite(),
});

export const serverMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    version: z.literal(CONTROL_PROTOCOL_VERSION),
    type: z.literal('joined'),
    room: roomSchema,
    player: playerSchema,
  }),
  z.strictObject({
    version: z.literal(CONTROL_PROTOCOL_VERSION),
    type: z.literal('roster'),
    room: roomSchema,
    players: z.array(playerSchema).max(64),
  }),
  z.strictObject({
    version: z.literal(CONTROL_PROTOCOL_VERSION),
    type: z.literal('chat'),
    message: chatMessageSchema,
  }),
  snapshotSchema,
  z.strictObject({
    version: z.literal(CONTROL_PROTOCOL_VERSION),
    type: z.literal('pong'),
    tick: uint32Schema,
    sentAt: z.number().finite(),
  }),
  z.strictObject({
    version: z.literal(CONTROL_PROTOCOL_VERSION),
    type: z.literal('error'),
    message: z.string().min(1),
  }),
  z.strictObject({
    version: z.literal(CONTROL_PROTOCOL_VERSION),
    type: z.literal('shutdown'),
    message: z.string().min(1),
  }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type InputMessage = Extract<ClientMessage, { type: 'input' }>;
export type JoinMessage = Extract<ClientMessage, { type: 'join' }>;
export type ChatMessage = Extract<ClientMessage, { type: 'chat' }>;
export type PingMessage = Extract<ClientMessage, { type: 'ping' }>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type SnapshotEntity = z.infer<typeof snapshotEntitySchema>;
export type SnapshotMessage = Extract<ServerMessage, { type: 'snapshot' }>;
export type ServerMessageType = ServerMessage['type'];
export type ServerMessagePayload<Type extends ServerMessageType> = Omit<
  Extract<ServerMessage, { type: Type }>,
  'version' | 'type'
>;
export type { InputCommand } from './input.ts';

export interface ProtocolParseError {
  readonly code: 'invalid-json' | 'invalid-version' | 'invalid-message' | 'invalid-binary';
  readonly message: string;
  readonly issues?: readonly z.ZodIssue[];
}

export type ParseResult<Value, Error = ProtocolParseError> =
  | { readonly success: true; readonly data: Value }
  | { readonly success: false; readonly error: Error };

function parseJson(data: unknown): ParseResult<unknown> {
  let text: string;
  if (typeof data === 'string') {
    text = data;
  } else {
    if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
      return {
        success: false,
        error: { code: 'invalid-json', message: 'Message must contain valid JSON.' },
      };
    }
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error: unknown) {
      return {
        success: false,
        error: {
          code: 'invalid-json',
          message: error instanceof Error ? error.message : 'Message must contain valid UTF-8.',
        },
      };
    }
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return { success: true, data: parsed };
  } catch (error: unknown) {
    return {
      success: false,
      error: {
        code: 'invalid-json',
        message: error instanceof Error ? error.message : 'Message must contain valid JSON.',
      },
    };
  }
}

function formatValidationError(
  issues: readonly { readonly path: PropertyKey[]; readonly message: string }[],
  fallback: string,
): string {
  const issue = issues[0];
  if (!issue) {
    return fallback;
  }
  const path = issue.path.map(String).join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

export function parseClientMessage(data: unknown, isBinary = false): ParseResult<ClientMessage> {
  if (isBinary) {
    try {
      const message = decodeBinary(data);
      if (message.type !== 'input' && message.type !== 'ping') {
        return {
          success: false,
          error: {
            code: 'invalid-binary',
            message: 'Binary message type is not accepted from clients.',
          },
        };
      }
      const result = clientMessageSchema.safeParse({
        version: CONTROL_PROTOCOL_VERSION,
        ...message,
      });
      return result.success
        ? { success: true, data: result.data }
        : {
            success: false,
            error: {
              code: 'invalid-message',
              message: result.error.issues[0]?.message ?? 'Client message is invalid.',
              issues: result.error.issues,
            },
          };
    } catch (error: unknown) {
      return {
        success: false,
        error: {
          code: 'invalid-binary',
          message: error instanceof Error ? error.message : 'Binary message is invalid.',
        },
      };
    }
  }

  const parsed = parseJson(data);
  if (!parsed.success) return parsed;
  const result = clientMessageSchema.safeParse(parsed.data);
  if (result.success) return { success: true, data: result.data };
  const isVersionMismatch =
    typeof parsed.data === 'object' &&
    parsed.data !== null &&
    'version' in parsed.data &&
    parsed.data.version !== CONTROL_PROTOCOL_VERSION;
  return {
    success: false,
    error: {
      code: isVersionMismatch ? 'invalid-version' : 'invalid-message',
      message: isVersionMismatch
        ? 'Message must include a supported protocol version.'
        : formatValidationError(result.error.issues, 'Client message is invalid.'),
      issues: result.error.issues,
    },
  };
}

export function parseServerMessage(data: unknown): ParseResult<ServerMessage> {
  const parsed = parseJson(data);
  if (!parsed.success) return parsed;
  const result = serverMessageSchema.safeParse(parsed.data);
  return result.success
    ? { success: true, data: result.data }
    : {
        success: false,
        error: {
          code: 'invalid-message',
          message: formatValidationError(result.error.issues, 'Server message is invalid.'),
          issues: result.error.issues,
        },
      };
}

export function serverMessage<Type extends ServerMessageType>(
  type: Type,
  payload: ServerMessagePayload<Type>,
): string {
  const parsed = serverMessageSchema.safeParse({
    version: CONTROL_PROTOCOL_VERSION,
    type,
    ...payload,
  });
  if (!parsed.success) {
    throw new TypeError(parsed.error.issues[0]?.message ?? 'Server message is invalid.');
  }
  return JSON.stringify(parsed.data);
}
