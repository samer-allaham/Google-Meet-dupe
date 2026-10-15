import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  RoomManager,
  RoomError,
  LIMITS,
  CODE_PATTERN,
  generateCode,
  normalizeCode,
  sanitizeName,
  sanitizeMessage,
} from '../server/rooms.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

describe('meeting codes', () => {
  test('generateCode produces Meet-style codes', () => {
    for (let i = 0; i < 200; i++) assert.match(generateCode(), CODE_PATTERN);
  });

  test('generateCode is not trivially repetitive', () => {
    const codes = new Set(Array.from({ length: 500 }, generateCode));
    assert.equal(codes.size, 500);
  });

  test('normalizeCode accepts several input forms', () => {
    assert.equal(normalizeCode('abc-defg-hij'), 'abc-defg-hij');
    assert.equal(normalizeCode('  ABC-DEFG-HIJ  '), 'abc-defg-hij');
    assert.equal(normalizeCode('abcdefghij'), 'abc-defg-hij');
    assert.equal(normalizeCode('https://meet.example.com/abc-defg-hij'), 'abc-defg-hij');
    assert.equal(normalizeCode('http://localhost:3000/abc-defg-hij?x=1'), 'abc-defg-hij');
  });

  test('normalizeCode rejects invalid input', () => {
    for (const bad of ['', 'abc', 'abc-def-hij', 'abc-defg-hi1', '123-4567-890', null, undefined, 42, {}]) {
      assert.equal(normalizeCode(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
    }
  });
});

describe('sanitizers', () => {
  test('sanitizeName trims, collapses whitespace and strips control chars', () => {
    assert.equal(sanitizeName('  Ada   Lovelace \n'), 'Ada Lovelace');
    assert.equal(sanitizeName('A\u0000B\u0007C'), 'ABC');
    assert.equal(sanitizeName('x'.repeat(100)).length, LIMITS.maxNameLength);
    assert.equal(sanitizeName('   '), null);
    assert.equal(sanitizeName(123), null);
  });

  test('sanitizeMessage keeps newlines but drops other control chars and limits length', () => {
    assert.equal(sanitizeMessage(' hi\nthere '), 'hi\nthere');
    assert.equal(sanitizeMessage('a\u0000b'), 'ab');
    assert.equal(sanitizeMessage('y'.repeat(5000)).length, LIMITS.maxMessageLength);
    assert.equal(sanitizeMessage(''), null);
    assert.equal(sanitizeMessage({}), null);
  });
});

describe('RoomManager', () => {
  let rooms;
  afterEach(() => rooms?.dispose());

  test('create, join and list participants', () => {
    rooms = new RoomManager();
    const code = rooms.createRoom();
    assert.match(code, CODE_PATTERN);
    assert.ok(rooms.hasRoom(code));

    const a = rooms.join(code, 'a', { name: 'Alice', audio: false, video: true });
    assert.deepEqual(
      { id: a.id, name: a.name, audio: a.audio, video: a.video, screen: a.screen, hand: a.hand },
      { id: 'a', name: 'Alice', audio: false, video: true, screen: false, hand: false },
    );
    rooms.join(code, 'b', { name: 'Bob' });
    assert.deepEqual(rooms.participants(code).map((p) => p.name), ['Alice', 'Bob']);
    assert.ok(rooms.isMember(code, 'a'));
    assert.ok(!rooms.isMember(code, 'zzz'));
  });

  test('join errors', () => {
    rooms = new RoomManager();
    const code = rooms.createRoom();
    const err = (fn, c) => assert.throws(fn, (e) => e instanceof RoomError && e.code === c);

    err(() => rooms.join('nop-nope-nop', 'x', { name: 'X' }), 'not_found');
    err(() => rooms.join(code, 'x', { name: '   ' }), 'invalid_name');
    rooms.join(code, 'x', { name: 'X' });
    err(() => rooms.join(code, 'x', { name: 'X' }), 'already_joined');
  });

  test('rooms are capped at maxParticipants', () => {
    rooms = new RoomManager();
    const code = rooms.createRoom();
    for (let i = 0; i < LIMITS.maxParticipants; i++) rooms.join(code, `p${i}`, { name: `P${i}` });
    assert.throws(() => rooms.join(code, 'extra', { name: 'Extra' }), (e) => e.code === 'full');
    rooms.leave(code, 'p0');
    assert.doesNotThrow(() => rooms.join(code, 'extra', { name: 'Extra' }));
  });

  test('leave returns the participant and is idempotent', () => {
    rooms = new RoomManager();
    const code = rooms.createRoom();
    rooms.join(code, 'a', { name: 'A' });
    assert.equal(rooms.leave(code, 'a').name, 'A');
    assert.equal(rooms.leave(code, 'a'), null);
    assert.equal(rooms.leave('nop-nope-nop', 'a'), null);
  });

  test('updateState only accepts known boolean flags and reports changes', () => {
    rooms = new RoomManager();
    const code = rooms.createRoom();
    rooms.join(code, 'a', { name: 'A' });

    const u = rooms.updateState(code, 'a', { audio: false, hand: true, name: 'Hacker', admin: true, video: 'no' });
    assert.equal(u.audio, false);
    assert.equal(u.hand, true);
    assert.equal(u.name, 'A');
    assert.equal(u.video, true);
    assert.equal('admin' in u, false);

    assert.equal(rooms.updateState(code, 'a', { audio: false }), null, 'no-op update returns null');
    assert.equal(rooms.updateState(code, 'ghost', { audio: false }), null);
    assert.equal(rooms.updateState(code, 'a', null), null);
  });

  test('chat messages are stored, sanitized and capped', () => {
    rooms = new RoomManager();
    const code = rooms.createRoom();
    rooms.join(code, 'a', { name: 'A' });

    const m = rooms.addMessage(code, 'a', '  hello  ');
    assert.equal(m.text, 'hello');
    assert.equal(m.name, 'A');
    assert.equal(m.from, 'a');
    assert.ok(m.id && typeof m.at === 'number');
    assert.equal(rooms.addMessage(code, 'a', '   '), null);
    assert.equal(rooms.addMessage(code, 'stranger', 'hi'), null);

    for (let i = 0; i < LIMITS.maxChatHistory + 10; i++) rooms.addMessage(code, 'a', `m${i}`);
    const chat = rooms.getRoom(code).chat;
    assert.equal(chat.length, LIMITS.maxChatHistory);
    assert.equal(chat.at(-1).text, `m${LIMITS.maxChatHistory + 9}`);
  });

  test('empty rooms expire after the TTL; occupied rooms do not', async () => {
    rooms = new RoomManager({ emptyTtlMs: 40 });
    const never = rooms.createRoom();
    const occupied = rooms.createRoom();
    rooms.join(occupied, 'a', { name: 'A' });

    await delay(80);
    assert.equal(rooms.hasRoom(never), false, 'unused room expired');
    assert.equal(rooms.hasRoom(occupied), true, 'occupied room kept');

    rooms.leave(occupied, 'a');
    await delay(20);
    assert.equal(rooms.hasRoom(occupied), true, 'kept during grace period');
    rooms.join(occupied, 'b', { name: 'B' });
    await delay(60);
    assert.equal(rooms.hasRoom(occupied), true, 'rejoining cancels expiry');

    rooms.leave(occupied, 'b');
    await delay(80);
    assert.equal(rooms.hasRoom(occupied), false);
  });

  test('participants() returns copies, not internal state', () => {
    rooms = new RoomManager();
    const code = rooms.createRoom();
    rooms.join(code, 'a', { name: 'A' });
    rooms.participants(code)[0].name = 'Mutated';
    assert.equal(rooms.participants(code)[0].name, 'A');
  });
});
