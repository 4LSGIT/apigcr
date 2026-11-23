// lib/caseyRedact.js — Casey v2 S3b-2: bearer-shaped values never reach the
// model or the ledger (ref/CASEY_V2_DESIGN.md §9 S3b-2).
//
// A route's answer flows to the model twice in v2: `api_get` returns it as a
// tool result, and a card step's answer is stored in casey_card_steps.result
// and read back in the outcome message. Routes answer with capability tokens
// as a matter of course — the tasks routes return `action_token`, the bearer
// behind the task's one-click complete link `/t/<token>` (S3b smoke, card 1),
// the booking routes a `contact_token` — and a token in the model's context is
// a token in the chat transcript, in the ledger and in the ai_calls excerpt.
//
// redact(value) → { value, count }: a deep copy where
//   1. under a BEARER KEY — the key's last word, after `_`, `-`, `.` or a
//      camelCase boundary, is one of BEARER_WORDS (token / secret / password /
//      api_key / authorization / cookie / jwt / otp …); `token` alone is
//      exempt when the words before it name a paging / sync cursor
//      (nextPageToken, page_token, sync_token, continuation_token: useless
//      without the credential, and the model pages with them — `sync_secret`
//      is still a bearer) — every string or number value becomes '[redacted]'
//      (a 6-digit OTP too), an array of them likewise;
//      inside a HEADER MAP (a value under a key named headers / set_cookie /
//      request_headers / response_headers) a value is a bearer when its header
//      NAME smells of a credential (key / auth / token / secret / cookie /
//      signature / password / credential anywhere in it — `x-hook-key`,
//      `Ocp-Apim-Subscription-Key`, `Authorization`; every set_cookie is), while
//      Content-Type and Accept stay; a `{name|key, value}` pair INSIDE a header
//      map follows the same header rule (outside one, a pair is data —
//      `{name:'Author', value:'John Smith'}` is a form answer, not a header);
//   2. every redacted STRING of MIN..MAX_PATTERN characters — and each
//      whitespace-separated part of it of MIN+ ("Bearer <x>") — is then
//      scrubbed from EVERY OTHER string in the answer (`action_url:
//      ".../t/<token>"` carries the token in its path). The scrub is
//      Aho–Corasick: one automaton over the collected values, one pass over
//      each string, O(text + matches) whatever the values share (review B1':
//      a prefix-bucket scan was quadratic when thousands of bearers shared
//      their first 8 characters — 7.6 s at the 256 KB settle cap). The
//      automaton's MEMORY is what the patterns cost (~290 bytes a character of
//      trie), so the set is bounded three ways — MAX_PATTERN per value (a
//      longer one is blanked in its field, not searched for), MAX_PATTERNS
//      values, MAX_PATTERN_CHARS in all (≈ +40 MB worst case) — and past the
//      last two the answer FAILS CLOSED to a marker: nothing is stored that the
//      redactor could not finish (review S1: 1,950 × 512-char values through an
//      autoGet route cost +350 MB on a 1 GiB instance before the budget).
//      Overlapping matches are redacted as their union (a bearer spanning the
//      tail of another and the head of a third leaks nothing).
// Booleans, null, short strings under other keys and look-alike keys
// (`input_tokens`, `token_type`, `report_key`, `idempotency_key`) are
// untouched: the key is the signal — a token-looking string under an ordinary
// key is left alone. `count` is how many values were blanked.
'use strict';

const MIN = 8;
const MAX_PATTERN = 2048;            // a redacted value longer than this is blanked in its field but not searched for elsewhere (an OAuth token in a URL fits)
const MAX_PATTERNS = 4000;           // more distinct bearers than this in one answer: fail closed (the whole value withheld)
const MAX_PATTERN_CHARS = 128 * 1024; // the automaton's total pattern characters: ≈ +40 MB of trie at most; past it, fail closed
const REDACTED = '[redacted]';
const WITHHELD = Object.freeze({ withheld: true, reason: `too many secret-shaped values in one answer (over ${MAX_PATTERNS}, or over ${MAX_PATTERN_CHARS} characters of them); nothing of it is kept` });
const BEARER_WORDS = Object.freeze(['token', 'secret', 'secret_key', 'password', 'passwd', 'passcode', 'apikey', 'api_key', 'access_key', 'private_key',
  'authorization', 'authorization_code', 'cookie', 'jwt', 'bearer', 'otp']);
// A paging / sync cursor is not a bearer: `<cursor word>_token` is exempt (only `token` — `sync_secret` stays a bearer).
const CURSOR_PREFIXES = Object.freeze(['page', 'next_page', 'nextpage', 'next', 'prev', 'previous', 'sync', 'continuation', 'cursor', 'resume']);
const HEADER_MAPS = new Set(['headers', 'set_cookie', 'request_headers', 'response_headers']);
const SECRET_HEADER = /key|auth|token|secret|cookie|signature|password|credential/i;   // a header NAME that carries a credential
const PAIR_FIELDS = new Set(['name', 'key', 'value']);   // the fields of a {name|key, value} pair are not header names themselves

/** `clientSecret` → `client_secret`, `X-Api-Key` → `x_api_key`: words joined by `_`, lower-case. */
function words(k) {
  return String(k).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-.]/g, '_').toLowerCase();
}
function isBearerKey(k) {
  const w = words(k);
  const hit = BEARER_WORDS.find((b) => w === b || w.endsWith(`_${b}`));
  if (!hit) return false;
  if (hit !== 'token') return true;
  const head = w.slice(0, w.length - hit.length).replace(/_$/, '');
  return !CURSOR_PREFIXES.some((p) => head === p || head.endsWith(`_${p}`));
}
function isHeaderMap(k) { return HEADER_MAPS.has(words(k)); }
/** Inside a header map: is this header's value a bearer? Every set_cookie value is. */
function isSecretHeader(name, mapKey) { return words(mapKey || '') === 'set_cookie' || SECRET_HEADER.test(String(name)) || isBearerKey(name); }

const blank = (x, found, tally) => {
  if (typeof x === 'string') {
    tally.blanked++;
    if (x.length >= MIN) {
      if (x.length <= MAX_PATTERN) found.add(x);
      for (const part of x.split(/\s+/)) if (part.length >= MIN && part.length <= MAX_PATTERN && part !== x) found.add(part);
    }
    return REDACTED;
  }
  if (typeof x === 'number') { tally.blanked++; return REDACTED; }
  if (Array.isArray(x)) return x.map((y) => blank(y, found, tally));
  return x;   // booleans, null, objects under a bearer key keep their shape (their own keys decide)
};

/** Pass 1: replace bearer values, collecting the strings to scrub. `headerMap` is the enclosing header map's key, if any. */
function strip(v, found, tally, headerMap = null) {
  if (Array.isArray(v)) return v.map((x) => strip(x, found, tally, headerMap));
  if (v && typeof v === 'object') {
    const out = {};
    const pairName = headerMap ? (typeof v.name === 'string' ? v.name : typeof v.key === 'string' ? v.key : null) : null;   // {name|key, value} inside a header map
    const pair = pairName != null && v.value !== undefined && isSecretHeader(pairName, headerMap);
    for (const [k, x] of Object.entries(v)) {
      const headerHit = headerMap && !PAIR_FIELDS.has(k) && isSecretHeader(k, headerMap);
      if (x && typeof x === 'object' && !Array.isArray(x)) out[k] = strip(x, found, tally, isHeaderMap(k) ? k : (headerMap && !headerHit ? headerMap : null));
      else if (headerHit || (pair && k === 'value') || isBearerKey(k)) out[k] = blank(x, found, tally);
      else out[k] = Array.isArray(x) ? strip(x, found, tally, isHeaderMap(k) ? k : headerMap) : x;
    }
    return out;
  }
  return v;
}

/** Pass 2: an Aho–Corasick automaton over the collected values; each string scanned once; leftmost-longest replacement. */
function automaton(patterns) {
  const next = [new Map()]; const fail = [0]; const out = [0];   // out[n] = the longest pattern length ending at node n (0 = none)
  for (const p of patterns) {
    let n = 0;
    for (let i = 0; i < p.length; i++) { const c = p.charCodeAt(i); let m = next[n].get(c); if (m === undefined) { m = next.length; next.push(new Map()); fail.push(0); out.push(0); next[n].set(c, m); } n = m; }
    out[n] = Math.max(out[n], p.length);
  }
  const queue = [];
  for (const m of next[0].values()) { fail[m] = 0; queue.push(m); }
  for (let qi = 0; qi < queue.length; qi++) {
    const n = queue[qi];
    for (const [c, m] of next[n]) {
      let f = fail[n];
      while (f && !next[f].has(c)) f = fail[f];
      fail[m] = next[f].has(c) && next[f].get(c) !== m ? next[f].get(c) : 0;
      out[m] = Math.max(out[m], out[fail[m]]);
      queue.push(m);
    }
  }
  return (s) => {
    if (s.length < MIN) return s;
    const hits = [];   // [start, end) of every match, by end position (the longest ending there)
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      while (n && !next[n].has(c)) n = fail[n];
      n = next[n].get(c) || 0;
      if (out[n]) hits.push([i + 1 - out[n], i + 1]);
    }
    if (!hits.length) return s;
    hits.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    // The UNION of every match (review S2): a bearer that spans the tail of one hit and the head of another is
    // inside the merged span; the longest match at each end position contains every shorter one ending there.
    let res = ''; let last = 0; let from = -1; let to = -1;
    for (const [a, b] of hits) {
      if (from < 0) { from = a; to = b; continue; }
      if (a <= to) { if (b > to) to = b; continue; }
      res += s.slice(last, from) + REDACTED; last = to; from = a; to = b;
    }
    res += s.slice(last, from) + REDACTED; last = to;
    return res + s.slice(last);
  };
}
function scrub(v, fn) {
  if (typeof v === 'string') return fn(v);
  if (Array.isArray(v)) return v.map((x) => scrub(x, fn));
  if (v && typeof v === 'object') { const out = {}; for (const [k, x] of Object.entries(v)) out[k] = scrub(x, fn); return out; }
  return v;
}

/**
 * @param {*} value  a parsed JSON value (object, array, scalar)
 * @returns {{ value: *, count: number }}  a copy with bearers redacted, and how many distinct values were
 */
function redact(value) {
  const found = new Set();
  const tally = { blanked: 0 };
  const stripped = strip(value, found, tally);
  if (!found.size) return { value: stripped, count: tally.blanked };
  let chars = 0; for (const t of found) chars += t.length;
  if (found.size > MAX_PATTERNS || chars > MAX_PATTERN_CHARS) return { value: { ...WITHHELD }, count: tally.blanked };   // fail closed: never a half-redacted answer, never an unbounded automaton
  return { value: scrub(stripped, automaton(found)), count: tally.blanked };
}

module.exports = { redact, isBearerKey, isHeaderMap, isSecretHeader, MIN, MAX_PATTERN, MAX_PATTERNS, MAX_PATTERN_CHARS, REDACTED, WITHHELD, BEARER_WORDS, CURSOR_PREFIXES };
