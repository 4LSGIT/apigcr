/**
 * tests/escapeLike.test.js — lib/escapeLike: user text matches LITERALLY in
 * a LIKE pattern (backslash escaped first, then % and _).
 */
const { escapeLike } = require('../lib/escapeLike');

test('escapes %, _ and backslash; leaves the rest alone', () => {
  expect(escapeLike('50%_off')).toBe('50\\%\\_off');
  expect(escapeLike('a\\b')).toBe('a\\\\b');
  expect(escapeLike('\\%')).toBe('\\\\\\%');   // escape char first, or \% would unescape
  expect(escapeLike('plain text 123')).toBe('plain text 123');
  expect(escapeLike(1146)).toBe('1146');
});
