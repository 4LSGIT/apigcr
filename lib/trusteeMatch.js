// lib/trusteeMatch.js
//
// FIL-1 — pure trustee-roster matcher. ONE implementation, no DB, no
// side-effects; lib/internal_functions/trustee.js is the only production
// caller and tests/trusteeMatch.test.js exercises it directly.
//
// WHY THIS EXISTS ALONGSIDE esignPrefillService._trusteeEntry:
//   _trusteeEntry is deliberately EXACT-only — it runs at document-render
//   time, where a fuzzy hit could put the WRONG trustee's address on a mailed
//   notice (see its McDonald comment). This matcher runs at VALIDATION time,
//   on the court-extracted value, and its entire job is to CANONICALIZE
//   cases.case_trustee to the exact roster spelling so that downstream
//   exact-match consumers (esign prefill, anything else keying on the roster
//   `name`) resolve. Fuzziness on the input side, exactness on the output
//   side — the two are complementary, not duplicates.
//
// MATCH RULES (in order; stated once, here):
//   0. Roster entries whose case_type conflicts with the case's chapter are
//      INELIGIBLE (String compare; entries with no case_type are always
//      eligible; unknown chapter disables the filter). This runs BEFORE the
//      exact pass on purpose: the roster contains both 'Thomas W. McDonald'
//      (case_type 12) and 'Thomas W. Jr. McDonald' (case_type 13) — an
//      unchaptered exact pass would hit the Ch12 entry on a Ch13 case.
//   1. EXACT: whitespace-collapsed, case-insensitive whole-name equality
//      against eligible entries. One hit → matched (method 'exact').
//   2. LNAME: entry.lname as a space-bounded whole word inside the extracted
//      value (ci). Exactly one eligible candidate → require first-token
//      compatibility (equal, or one is the single-letter initial of the
//      other; a surname-only extracted value is compatible with anything)
//      → matched (method 'lname'). Incompatible first token → no_match,
//      with the near-miss reported in candidates.
//   3. >1 candidates at either pass → 'ambiguous' — NEVER guess. Alert.
//   4. 0 eligible candidates but the SAME passes hit chapter-mismatched
//      entries → 'chapter_mismatch' with those candidates. Alert (a Ch7
//      trustee on a Ch13 case is a data problem, not a match).
//   5. Otherwise → 'no_match'.
//
// Return shape: { status, entry?, method?, candidates? }
//   status ∈ matched | ambiguous | chapter_mismatch | no_match
//          | no_trustee | no_roster

'use strict';

function _norm(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Tokens for first-name compatibility: normalized, periods stripped. */
function _tokens(s) {
  return _norm(s).replace(/\./g, '').split(' ').filter(Boolean);
}

function _escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** entry.lname appears as a whole space-bounded word in the extracted name. */
function _lnameHit(extractedNorm, entry) {
  const ln = _norm(entry.lname);
  if (!ln) return false;
  return new RegExp(`(?:^| )${_escRe(ln)}(?: |$)`).test(extractedNorm);
}

/** First tokens equal, or one is the single-letter initial of the other. */
function _firstTokenCompatible(extracted, entryName) {
  const et = _tokens(extracted);
  if (et.length <= 1) return true;                 // surname-only input
  const rt = _tokens(entryName);
  const f = et[0], g = rt[0] || '';
  if (f === g) return true;
  if (f.length === 1 && g.charAt(0) === f) return true;
  if (g.length === 1 && f.charAt(0) === g) return true;
  return false;
}

/**
 * @param {object} args
 * @param {string}  args.extracted  cases.case_trustee as currently stored
 * @param {?string} args.chapter    cases.case_chapter ('7'/'13'/…/''/null)
 * @param {?Array}  args.roster     parsed fe-trustees array
 */
function matchTrustee({ extracted, chapter, roster } = {}) {
  const ex = _norm(extracted);
  if (!ex) return { status: 'no_trustee' };

  const valid = Array.isArray(roster)
    ? roster.filter((e) => e && typeof e === 'object' && _norm(e.name))
    : [];
  if (!valid.length) return { status: 'no_roster' };

  const chap = String(chapter == null ? '' : chapter).trim();
  const eligibleOf = (list) => (chap
    ? list.filter((e) => e.case_type == null || e.case_type === ''
                      || String(e.case_type) === chap)
    : list.slice());

  const eligible   = eligibleOf(valid);
  const ineligible = valid.filter((e) => !eligible.includes(e));

  const run = (pool) => {
    const exact = pool.filter((e) => _norm(e.name) === ex);
    if (exact.length) return { pass: 'exact', hits: exact };
    const lname = pool.filter((e) => _lnameHit(ex, e));
    if (lname.length) return { pass: 'lname', hits: lname };
    return { pass: null, hits: [] };
  };

  const r = run(eligible);
  if (r.pass === 'exact') {
    if (r.hits.length > 1) return { status: 'ambiguous', candidates: r.hits };
    return { status: 'matched', entry: r.hits[0], method: 'exact' };
  }
  if (r.pass === 'lname') {
    if (r.hits.length > 1) return { status: 'ambiguous', candidates: r.hits };
    const hit = r.hits[0];
    if (_firstTokenCompatible(extracted, hit.name)) {
      return { status: 'matched', entry: hit, method: 'lname' };
    }
    return { status: 'no_match', candidates: [hit] };
  }

  // Nothing eligible hit — did a chapter-mismatched entry hit?
  const m = run(ineligible);
  if (m.hits.length) return { status: 'chapter_mismatch', candidates: m.hits };

  return { status: 'no_match', candidates: [] };
}

module.exports = { matchTrustee, _norm, _tokens, _firstTokenCompatible };
