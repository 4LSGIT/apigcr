/**
 * tests/token.test.js
 *
 * Tests for lib/token.js — the shared base62 bearer-token mint.
 *
 * Pins down the alphabet (all 62 symbols reachable, none dead), uniformity
 * of the crypto.randomInt mapping, output shape (22 chars, base62-only,
 * never all-digit), the all-digit rejection branch (forced deterministically
 * — at (10/62)^22 random sampling would never hit it), and PUBLIC_TOKEN_RE's
 * contract: it must accept every format ever minted into the token columns
 * (legacy 32-hex, legacy 22-base64url, current 22-base62) and reject the
 * things the hex regexes it replaced also rejected. The alphabet below is a
 * deliberately independent hardcoded copy: an accidental edit to the
 * constant in lib/token.js must FAIL here, not self-validate.
 */

const crypto = require('crypto');
const { generateToken, PUBLIC_TOKEN_RE } = require('../lib/token');

// Independent copy — do NOT import from lib/token.js (see header).
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

describe('generateToken', () => {
  // One shared pool for the statistical tests. 6k tokens = 132k chars;
  // expected count per symbol ≈ 2129, sd ≈ 46, so the ±20% band below sits
  // ~9 standard deviations out — effectively cannot flake.
  const N = 6000;
  let tokens;

  beforeAll(() => {
    tokens = Array.from({ length: N }, () => generateToken());
  });

  test('all 62 symbols appear (no dead symbols from an off-by-one)', () => {
    // Kills the masking/range-bug class at once: randomInt(61) leaves the
    // last symbol dead, a truncated ALPHABET leaves a hole.
    const seen = new Set(tokens.join(''));
    for (const ch of ALPHABET) {
      expect(seen.has(ch)).toBe(true);
    }
    expect(seen.size).toBe(62);
  });

  test('symbol distribution is uniform within ±20% of n/62', () => {
    const counts = {};
    for (const ch of ALPHABET) counts[ch] = 0;
    for (const t of tokens) {
      for (const ch of t) counts[ch]++;
    }
    const expected = (N * 22) / 62;
    for (const ch of ALPHABET) {
      expect(counts[ch]).toBeGreaterThan(expected * 0.8);
      expect(counts[ch]).toBeLessThan(expected * 1.2);
    }
  });

  test('shape: 22 chars, base62-only (no -/_), never all-digit, no repeats', () => {
    const seen = new Set();
    for (const t of tokens) {
      expect(t).toMatch(/^[0-9A-Za-z]{22}$/);
      expect(t).not.toMatch(/^\d+$/);
      seen.add(t);
    }
    expect(seen.size).toBe(N); // 131 bits: a dupe here means a broken RNG
  });

  test('honors a custom length', () => {
    expect(generateToken(10)).toMatch(/^[0-9A-Za-z]{10}$/);
    expect(generateToken(40)).toMatch(/^[0-9A-Za-z]{40}$/);
  });

  test('all-digit rejection branch rerolls (forced deterministically)', () => {
    // Force randomInt to emit digit indices (0-9) for one full token, then
    // real values: the first candidate is all-digit and must be discarded.
    const spy = jest.spyOn(crypto, 'randomInt');
    let calls = 0;
    spy.mockImplementation((max) => {
      calls++;
      if (calls <= 22) return calls % 10; // indices 0-9 → digits only
      return 10 + (calls % 52);           // letters — guaranteed non-digit
    });
    try {
      const t = generateToken();
      expect(calls).toBeGreaterThan(22);  // the reroll actually happened
      expect(t).toMatch(/^[0-9A-Za-z]{22}$/);
      expect(t).not.toMatch(/^\d+$/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('PUBLIC_TOKEN_RE', () => {
  test('accepts every format ever minted into the token columns', () => {
    expect(PUBLIC_TOKEN_RE.test('e65bd111130b7088580e3bc9586a5371')).toBe(true); // legacy 32-hex
    expect(PUBLIC_TOKEN_RE.test('a'.repeat(64))).toBe(false);                    // 64-hex reset > 40 — see note
    expect(PUBLIC_TOKEN_RE.test('0mE53RCiDYjqu9M5uIGwvq')).toBe(true);           // base62 (22)
    expect(PUBLIC_TOKEN_RE.test('Ab3_x-9Zk12Qw45Tt678Uu')).toBe(true);           // legacy base64url (22)
    expect(PUBLIC_TOKEN_RE.test(generateToken())).toBe(true);                    // current mint
  });

  // reset_token is the one column whose LEGACY format (64-hex) exceeds the
  // 40-char cap — and the one lookup that deliberately has NO format gate
  // (routes/auth.password.js queries `reset_token = ?` directly), so the cap
  // never rejects a real reset link. Pin that nobody "helpfully" adds this
  // regex as a reset gate while legacy 64-hex links can still be in inboxes.
  test('rejects garbage the old hex gates also rejected', () => {
    for (const bad of ['', 'short', 'x'.repeat(41), 'has space in it   !!', 'semi;colon?inject=1', '../../etc/passwd']) {
      expect(PUBLIC_TOKEN_RE.test(bad)).toBe(false);
    }
  });
});
