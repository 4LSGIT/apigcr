/**
 * tests/caseId.test.js
 *
 * Tests for lib/caseId.js — the Crockford Base32 case ID generator.
 *
 * Pins down the alphabet (all 32 symbols reachable, none dead), uniformity
 * of the `byte & 31` mapping, output shape (8 chars, uppercase, no ILOU,
 * no base64url leftovers, never all-digit), and the all-digit rejection
 * branch (forced deterministically — random sampling would hit it ~2 times
 * in 20k). The alphabet below is a deliberately independent hardcoded copy:
 * an accidental edit to the constant in lib/caseId.js must FAIL here, not
 * self-validate.
 *
 * Run:
 *   npm install --save-dev jest
 *   npx jest tests/caseId.test.js
 *   npm uninstall --save-dev jest
 */

const crypto = require("crypto");
const { generateCaseId } = require("../lib/caseId");

// Independent copy — do NOT import from lib/caseId.js (see header).
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

describe("generateCaseId", () => {
  // One shared pool for the statistical tests. 20k ids = 160k chars;
  // expected count per symbol = 5000, sd ≈ 70, so the ±20% band below
  // sits ~14 standard deviations out — effectively cannot flake.
  const N = 20000;
  let ids;

  beforeAll(() => {
    ids = Array.from({ length: N }, () => generateCaseId());
  });

  test("all 32 symbols appear (no dead symbols from a masking bug)", () => {
    // Kills the whole masking-bug class at once: `b & 15` leaves 16 symbols
    // dead, `b % 31` leaves symbol 31 dead, a truncated ALPHABET leaves a hole.
    const seen = new Set(ids.join(""));
    for (const ch of ALPHABET) {
      expect(seen.has(ch)).toBe(true);
    }
    expect(seen.size).toBe(32);
  });

  test("symbol distribution is uniform within ±20% of n/32", () => {
    const counts = {};
    for (const ch of ALPHABET) counts[ch] = 0;
    for (const id of ids) {
      for (const ch of id) counts[ch]++;
    }
    const expected = (N * 8) / 32;
    for (const ch of ALPHABET) {
      expect(counts[ch]).toBeGreaterThan(expected * 0.8);
      expect(counts[ch]).toBeLessThan(expected * 1.2);
    }
  });

  test("shape: 8 chars, alphabet-only, no ILOU/lowercase/-/_, never all-digit", () => {
    for (const id of ids) {
      expect(id).toHaveLength(8);
      for (const ch of id) expect(ALPHABET.includes(ch)).toBe(true);
      expect(id).not.toMatch(/[ILOU]/);
      expect(id).not.toMatch(/[a-z]/);
      expect(id).not.toMatch(/[-_]/);
      expect(id).not.toMatch(/^\d+$/);
    }
  });

  test("all-digit ids are rejected and regenerated (deterministic)", () => {
    // Bytes 0..7 map to ALPHABET[0..7] = "01234567" (all-digit → rejected);
    // then byte 10 maps to "A" → "A1234567" (accepted).
    const spy = jest
      .spyOn(crypto, "randomBytes")
      .mockReturnValueOnce(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]))
      .mockReturnValueOnce(Buffer.from([10, 1, 2, 3, 4, 5, 6, 7]));

    const id = generateCaseId();

    expect(id).toBe("A1234567");
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  test("uniqueness smoke — 5,000 ids yield 5,000 distinct values", () => {
    // Real job: catch a generator frozen to a constant. Genuine collisions
    // at 40 bits over 5k draws are ~1e-5 — a failure here means broken RNG
    // plumbing, not bad luck.
    const set = new Set(ids.slice(0, 5000));
    expect(set.size).toBe(5000);
  });
});
