// lib/auditShape.js
//
// Value SHAPES for jwt_api_audit_log (SEC-2). The audit row keeps the
// request's KEYS — enough to see what a call carried — and replaces every
// VALUE with a type/length tag, so no request content (names, phone
// numbers, message text, search terms, credentials) is stored:
//
//   "Jane"          → "[str 4]"        42 / 4.2 / NaN → "[num]"
//   true            → "[bool]"         null           → "[null]"
//   [1, 2, 3]       → "[arr 3]"        {a: 1, b: 2}   → "[obj 2]"
//   Buffer(10)      → "[buf 10]"       undefined      → "[undefined]"
//   anything else   → "[other]"
//
// ONE LEVEL: a nested object or array is counted, never descended into —
// its keys and values are not stored. A value under a CREDENTIAL-shaped key
// (password, smtp_pass, client_secret, api_key, token, …) is "[secret]": no
// type, no length (a password's length is still a fact about the password).
// At most MAX_KEYS keys are kept; the rest are counted under TRUNCATED_KEY.
//
// Used by lib/auth.jwtOrApiKey (every new row) and
// scripts/sec2ScrubAuditShapes.js (history) — one definition, so a scrubbed
// row and a new row can never disagree.

'use strict';

const MAX_KEYS = 200;
const TRUNCATED_KEY = '__more_keys';

// Exact names, plus *_password / *_pass / *_secret / *_token / *_api_key style
// suffixes. A bare "key" or "auth" counts; "form_key" / "item_key" do not
// (they are identifiers, and their shape is useful).
const CREDENTIAL_KEY_RE =
  /^(?:key|auth|password|passwd|pass|pwd|secret|token|api_?key|apikey)$|_(?:password|passwd|pass|pwd|secret|token|api_?key)$/i;

// What every shaped value looks like — used to recognize an already-shaped
// row (the scrub's no-op test).
const SHAPE_RE = /^\[(?:str \d+|num|bool|null|arr \d+|obj \d+|buf \d+|undefined|other|secret|\+\d+ keys)\]$/;

/** The tag for one value. Total: never throws, always a SHAPE_RE string. */
function shapeValue(v) {
  if (v === null) return '[null]';
  if (v === undefined) return '[undefined]';
  const t = typeof v;
  if (t === 'string') return `[str ${v.length}]`;
  if (t === 'number' || t === 'bigint') return '[num]';
  if (t === 'boolean') return '[bool]';
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return `[buf ${v.length}]`;
  if (Array.isArray(v)) return `[arr ${v.length}]`;
  if (t === 'object') {
    let n;
    try { n = Object.keys(v).length; } catch (_) { return '[other]'; }
    return `[obj ${n}]`;
  }
  return '[other]';   // function, symbol
}

/**
 * The stored shape of a request body or query object. A plain object keeps
 * its (first MAX_KEYS) keys with shaped values; anything else (a raw string
 * body, a top-level array, a Buffer) becomes the single tag for that value.
 * A missing body is {}.
 */
function shapeTop(x) {
  if (x === undefined || x === null) return {};
  if (typeof x !== 'object' || Array.isArray(x) || Buffer.isBuffer(x) || x instanceof Uint8Array) {
    return shapeValue(x);
  }
  let keys;
  try { keys = Object.keys(x); } catch (_) { return '[other]'; }
  const out = {};
  for (const k of keys.slice(0, MAX_KEYS)) {
    let v;
    try { v = x[k]; } catch (_) { v = undefined; }
    out[k] = CREDENTIAL_KEY_RE.test(k) ? '[secret]' : shapeValue(v);
  }
  if (keys.length > MAX_KEYS) out[TRUNCATED_KEY] = `[+${keys.length - MAX_KEYS} keys]`;
  return out;
}

/** Is a stored body/query value already in shape form? (scrub no-op test) */
function isShaped(stored) {
  if (stored === null || stored === undefined) return true;
  if (typeof stored === 'string') return SHAPE_RE.test(stored);
  if (typeof stored !== 'object' || Array.isArray(stored)) return false;
  return Object.values(stored).every((v) => typeof v === 'string' && SHAPE_RE.test(v));
}

module.exports = { shapeValue, shapeTop, isShaped, SHAPE_RE, CREDENTIAL_KEY_RE, MAX_KEYS, TRUNCATED_KEY };
