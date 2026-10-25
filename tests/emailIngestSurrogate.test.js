// tests/emailIngestSurrogate.test.js
//
/**
 * emailIngestService — the executions row's JSON columns are always text
 * MySQL accepts (_jsonColumnText). Run: npx jest tests/emailIngestSurrogate.test.js
 *
 * THE DEFECT (live 2026-10-25 13:01Z, mailbox 2, a "Your Task Summary"
 * email): _truncateRawInput cuts an over-16-KB envelope's JSON at a fixed
 * UTF-16 offset. When the cut fell inside an emoji's surrogate pair the
 * preview ended in a LONE high surrogate; JSON.stringify writes that as an
 * escaped \udXXX, and MySQL's JSON parser refuses the whole value:
 *   ER_INVALID_JSON_TEXT … "The surrogate pair in string is invalid."
 * The executions INSERT threw, the mailbox worker retried the emission every
 * tick, and the folder stayed on that message (the Apps Script covered the
 * log). tests/emailIngestSurrogate.mysql.test.js proves the engine side;
 * this file pins the premise and the writer, everywhere.
 *
 * The acceptance test used here — JSON.parse the column text and require
 * every string in it to be well-formed — is MySQL's criterion for this error
 * class: a parsed lone surrogate is exactly what its parser refuses.
 *
 * Mutation-checked:
 *   - _writeExecution back to plain JSON.stringify  → "writes both JSON columns through _jsonColumnText …"
 *                                                     (and, on the engine, the .mysql twin fails with
 *                                                     the production error)
 *   - the replacer drops toWellFormed (x → x)       → "the over-16-KB envelope cut mid-pair …",
 *                                                     "a lone surrogate in an untruncated body …",
 *                                                     "writes both JSON columns …"
 */

'use strict';

const svc = require('../services/emailIngestService');

const EMOJI = '\u{1F4CB}'; // 📋 — astral: two UTF-16 code units
const HIGH = EMOJI.charCodeAt(0);
const CUT = svc.RAW_INPUT_LIMIT - 200; // the preview's length (_truncateRawInput)

/** Every string in a parsed JSON value is well-formed (no lone surrogate). */
function allWellFormed(v) {
  if (typeof v === 'string') return v.isWellFormed();
  if (Array.isArray(v)) return v.every(allWellFormed);
  if (v && typeof v === 'object') return Object.values(v).every(allWellFormed);
  return true;
}

/** An envelope whose JSON is over the limit with the emoji's FIRST half as the preview's last code unit. */
function envelopeCutMidPair() {
  const env = (n) => ({
    kind: 'email',
    from: { email: 'automations@4lsg.com', name: 'Automations' },
    to: [{ email: 'stuart@4lsg.com', name: '' }],
    subject: 'Your Task Summary',
    headers: { message_id: 'task-summary-1@4lsg.com' },
    text: 'a'.repeat(n) + EMOJI + 'b'.repeat(4000),
  });
  const base = JSON.stringify(env(0)).indexOf(EMOJI);
  const e = env(CUT - 1 - base);
  const json = JSON.stringify(e);
  // the premise, asserted where it is built
  if (json.length <= svc.RAW_INPUT_LIMIT || json.charCodeAt(CUT - 1) !== HIGH) throw new Error('fixture does not cut mid-pair');
  return e;
}

describe('the premise (pinned)', () => {
  test('_truncateRawInput leaves a lone high surrogate when the cut falls mid-pair', () => {
    const raw = svc._truncateRawInput(envelopeCutMidPair());
    expect(raw._truncated).toBe(true);
    expect(raw.preview).toHaveLength(CUT);
    expect(raw.preview.charCodeAt(CUT - 1)).toBe(HIGH);
    expect(raw.preview.isWellFormed()).toBe(false);
    // and plain JSON.stringify carries it as an escape MySQL refuses
    expect(JSON.stringify(raw)).toMatch(/\\ud83d"/);
    expect(allWellFormed(JSON.parse(JSON.stringify(raw)))).toBe(false);
  });
});

describe('_jsonColumnText', () => {
  test('the over-16-KB envelope cut mid-pair → text MySQL accepts; only the dangling half becomes U+FFFD', () => {
    const raw = svc._truncateRawInput(envelopeCutMidPair());
    const back = JSON.parse(svc._jsonColumnText(raw));
    expect(allWellFormed(back)).toBe(true);
    expect(back.preview).toHaveLength(CUT);
    expect(back.preview.slice(0, -1)).toBe(raw.preview.slice(0, -1));
    expect(back.preview.slice(-1)).toBe('�');
    expect(back._original_size).toBe(raw._original_size);
  });

  test('a lone surrogate in an untruncated body (malformed mail) is replaced too, nested anywhere', () => {
    const body = { kind: 'email', text: 'x\uD83Dy', to: [{ name: 'z\uDC4Bw' }] };
    expect(svc._truncateRawInput(body)).toBe(body); // under the limit: the object itself
    const back = JSON.parse(svc._jsonColumnText(body));
    expect(allWellFormed(back)).toBe(true);
    expect(back).toEqual({ kind: 'email', text: 'x�y', to: [{ name: 'z�w' }] });
  });

  test('well-formed text is untouched — emoji pairs, other Unicode, non-strings', () => {
    const v = { s: `ok ${EMOJI} ⏰ é`, n: 1, b: true, z: null, a: [EMOJI] };
    expect(svc._jsonColumnText(v)).toBe(JSON.stringify(v));
  });
});

describe('_writeExecution', () => {
  test('writes both JSON columns through _jsonColumnText (raw_input and metadata)', async () => {
    const seen = [];
    const db = { query: async (sql, values) => { seen.push({ sql, values }); return [{ insertId: 77 }]; } };
    const raw = svc._truncateRawInput(envelopeCutMidPair());
    const id = await svc._writeExecution(db, {
      source_id: 1, message_id: 'm', status: 'skipped_firm_to_firm',
      raw_input: raw, metadata: { note: 'half \uD83D' },
    });
    expect(id).toBe(77);
    expect(seen).toHaveLength(1);
    expect(seen[0].sql).toMatch(/^INSERT INTO email_ingest_executions \(source_id, message_id, status, raw_input, metadata\)/);
    const [, , , rawText, metaText] = seen[0].values;
    expect(typeof rawText).toBe('string');
    expect(allWellFormed(JSON.parse(rawText))).toBe(true);
    expect(JSON.parse(metaText)).toEqual({ note: 'half �' });
  });
});
