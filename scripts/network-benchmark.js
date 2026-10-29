import { performance } from 'node:perf_hooks';
import {
  decodeBinary,
  decodeJson,
  encodeBinary,
  encodeJson,
  measureJsonBytes,
} from '@dogfight/shared/codec';

const ENTITY_COUNT = 24;
const ACK_COUNT = 4;
const ITERATIONS = 10_000;

const snapshot = {
  type: 'snapshot',
  tick: 90_000,
  acks: Array.from({ length: ACK_COUNT }, (_, index) => ({
    entityId: index + 1,
    seq: 2_500,
  })),
  entities: Array.from({ length: ENTITY_COUNT }, (_, index) => ({
    id: index + 1,
    kind: index < ACK_COUNT ? 'ship' : index < 18 ? 'asteroid' : 'bullet',
    x: (index * 37.125) % 960,
    y: (index * 19.875) % 600,
    vx: 42.125 - index,
    vy: -11.75 + index,
    angle: -Math.PI + index * 0.17,
    radius: index < ACK_COUNT ? 13 : 20,
    hp: index < ACK_COUNT ? 3 : 1,
    thrust: index % 2,
    invulnerableTime: index < ACK_COUNT ? 0.25 : 0,
    shield: index === 0,
    ownerId: index >= 18 ? 1 : 0,
    ttl: index >= 18 ? 1.4 : 0,
    commandSeq: index >= 18 ? index * 3 : 0,
    score: index < ACK_COUNT ? index * 100 : 0,
  })),
};
const jsonSnapshot = { version: 0, ...snapshot };
const input = {
  type: 'input',
  seq: 2_500,
  tick: 90_000,
  turn: 1,
  thrust: true,
  brake: false,
  fire: false,
};
const ping = { type: 'ping', sentAt: 12.5 };
const jsonBytes = measureJsonBytes(jsonSnapshot);
const binaryBytes = encodeBinary(snapshot).byteLength;
const jsonInputBytes = Buffer.byteLength(encodeJson({ version: 0, ...input }));
const binaryInputBytes = encodeBinary(input).byteLength;
const jsonPingBytes = Buffer.byteLength(encodeJson({ version: 0, ...ping }));
const binaryPingBytes = encodeBinary(ping).byteLength;

function measure(operation) {
  const started = performance.now();
  for (let index = 0; index < ITERATIONS; index += 1) operation();
  return ((performance.now() - started) * 1_000) / ITERATIONS;
}

const encodedJson = encodeJson(jsonSnapshot);
const encodedBinary = encodeBinary(snapshot);
const jsonEncodeDecodeUs = measure(() => {
  decodeJson(encodedJson);
  encodeJson(jsonSnapshot);
});
const binaryEncodeDecodeUs = measure(() => {
  decodeBinary(encodedBinary);
  encodeBinary(snapshot);
});

console.log(
  JSON.stringify(
    {
      runtime: process.version,
      entities: ENTITY_COUNT,
      acknowledgements: ACK_COUNT,
      iterations: ITERATIONS,
      snapshot: {
        jsonBytes: jsonBytes,
        binaryBytes,
        jsonDownKBpsAt30Hz: Number(((jsonBytes * 30) / 1024).toFixed(2)),
        binaryDownKBpsAt30Hz: Number(((binaryBytes * 30) / 1024).toFixed(2)),
      },
      clientToServer: {
        jsonInputBytes: jsonInputBytes,
        binaryInputBytes,
        jsonPingBytes,
        binaryPingBytes,
        jsonUpKBpsAt30Hz: Number(((jsonInputBytes * 30 + jsonPingBytes) / 1024).toFixed(2)),
        binaryUpKBpsAt30Hz: Number(((binaryInputBytes * 30 + binaryPingBytes) / 1024).toFixed(2)),
      },
      encodeDecodeMicrosecondsPerSnapshot: {
        json: Number(jsonEncodeDecodeUs.toFixed(2)),
        binary: Number(binaryEncodeDecodeUs.toFixed(2)),
      },
    },
    null,
    2,
  ),
);
