import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMeetingCode,
  gridColumns,
  initial,
  avatarColor,
  audioLevel,
  peopleInCallText,
} from '../public/js/lib.js';
import { normalizeCode } from '../server/rooms.js';

describe('client helpers', () => {
  test('parseMeetingCode matches the server normalizer', () => {
    const inputs = ['abc-defg-hij', 'ABCDEFGHIJ', ' https://x.y/abc-defg-hij/ ', 'abc', '', 'abc-defg-hi1', 'x/abc-defg-hij#frag'];
    for (const i of inputs) assert.equal(parseMeetingCode(i), normalizeCode(i), `mismatch for ${i}`);
  });

  test('gridColumns grows with participants', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 9, 10].map((n) => gridColumns(n)), [1, 1, 2, 2, 2, 3, 3, 4]);
    assert.deepEqual([1, 2, 3, 4, 8].map((n) => gridColumns(n, { narrow: true })), [1, 1, 1, 2, 2]);
  });

  test('initial handles names, emoji and empties', () => {
    assert.equal(initial('ada'), 'A');
    assert.equal(initial('  zoe'), 'Z');
    assert.equal(initial('😀 smile'), '😀');
    assert.equal(initial(''), '?');
    assert.equal(initial(undefined), '?');
  });

  test('avatarColor is stable per id', () => {
    assert.equal(avatarColor('abc'), avatarColor('abc'));
    assert.match(avatarColor('xyz'), /^#[0-9a-f]{6}$/);
  });

  test('audioLevel is 0 for silence and grows with amplitude', () => {
    assert.equal(audioLevel(new Uint8Array(64).fill(128)), 0);
    assert.equal(audioLevel(new Uint8Array(0)), 0);
    const loud = Uint8Array.from({ length: 64 }, (_, i) => (i % 2 ? 255 : 0));
    const quiet = Uint8Array.from({ length: 64 }, (_, i) => (i % 2 ? 140 : 116));
    assert.ok(audioLevel(loud) > 0.9);
    assert.ok(audioLevel(quiet) > 0 && audioLevel(quiet) < 0.2);
  });

  test('peopleInCallText pluralizes', () => {
    assert.equal(peopleInCallText(0), 'No one else is here');
    assert.equal(peopleInCallText(1), '1 other person is in this call');
    assert.equal(peopleInCallText(3), '3 other people are in this call');
  });
});
