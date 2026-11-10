import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClientMessage, ProtocolError, serverMessage } from '../src/protocol.ts';

test('protocol validates versioned join and chat messages and normalizes safe text', () => {
  assert.deepEqual(
    parseClientMessage('{"version":0,"type":"join","room":"training-sector","name":" Ace "}'),
    { version: 0, type: 'join', room: 'training-sector', name: 'Ace' },
  );
  assert.deepEqual(parseClientMessage('{"version":0,"type":"chat","text":" hello "}'), {
    version: 0,
    type: 'chat',
    text: 'hello',
  });

  test('protocol validates sequenced movement commands and supports binary codec negotiation', () => {
    assert.deepEqual(
      parseClientMessage(
        JSON.stringify({
          version: 0,
          type: 'join',
          room: 'training-sector',
          name: 'Ace',
          codec: 'binary',
        }),
      ),
      {
        version: 0,
        type: 'join',
        room: 'training-sector',
        name: 'Ace',
        codec: 'binary',
      },
    );
    assert.deepEqual(
      parseClientMessage(
        JSON.stringify({
          version: 0,
          type: 'input',
          seq: 3,
          tick: 5,
          turn: -1,
          thrust: true,
          brake: false,
          fire: false,
        }),
      ),
      {
        version: 0,
        type: 'input',
        seq: 3,
        tick: 5,
        turn: -1,
        thrust: true,
        brake: false,
        fire: false,
      },
    );
    assert.throws(
      () =>
        parseClientMessage(
          JSON.stringify({
            version: 0,
            type: 'input',
            seq: 3,
            tick: 5,
            turn: 1000,
            thrust: true,
            brake: false,
            fire: false,
          }),
        ),
      /turn/,
    );
  });
  assert.deepEqual(
    JSON.parse(
      serverMessage('roster', {
        room: {
          id: 'training-sector',
          name: 'Training sector',
          players: 0,
          maxPlayers: 8,
          arena: { asteroidCount: 0, seed: 1 },
        },
        players: [],
      }),
    ),
    {
      version: 0,
      type: 'roster',
      room: {
        id: 'training-sector',
        name: 'Training sector',
        players: 0,
        maxPlayers: 8,
        arena: { asteroidCount: 0, seed: 1 },
      },
      players: [],
    },
  );
});

test('protocol rejects malformed JSON, binary frames, invalid shapes, unknown versions and types', () => {
  const invalidCases: readonly (readonly [string | Buffer, boolean, number])[] = [
    ['{', false, 1007],
    [Buffer.from('x'), true, 1002],
    ['{"version":1,"type":"chat","text":"x"}', false, 1008],
    ['{"version":0,"type":"unknown"}', false, 1008],
    ['{"version":0,"type":"join","room":"../secret","name":"A"}', false, 1008],
    ['{"version":0,"type":"join","room":"valid","name":"   "}', false, 1008],
    ['{"version":0,"type":"chat","text":"x","extra":true}', false, 1008],
    [`{"version":0,"type":"chat","text":"${'x'.repeat(501)}"}`, false, 1008],
  ];
  for (const [value, binary, code] of invalidCases) {
    assert.throws(
      () => parseClientMessage(value, binary),
      (error) => {
        assert.ok(error instanceof ProtocolError);
        assert.equal(error.closeCode, code);
        return true;
      },
    );
  }
});
