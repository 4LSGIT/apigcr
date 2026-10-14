// services/commsSummaryGround.js
//
/**
 * Comms archive S3 — the STRICT schema validation and the GROUNDING check for
 * an AI call summary (ref/COMMS_ARCHIVE_DESIGN.md §6.4). Pure: model JSON +
 * the transcript in, a clean summary out. No DB, no I/O.
 *
 *   validate(json, { segments, fullText, kind, knownNames })
 *     → { ok: true, summary, summaryText, dropped }
 *     | { ok: false, why }
 *
 * SHAPE (strict): the §6.4 keys only — anything else is dropped; a key of the
 * wrong TYPE fails the whole summary (the caller counts an attempt). Enums are
 * closed (call_type, by, role); flags keep only the known ones.
 *
 * GROUNDING: every evidence item (commitments, dates, documents_requested,
 * amounts, case_refs) must carry a `quote` of at least MIN_QUOTE_WORDS words
 * that occurs in the transcript ON WORD BOUNDARIES after normalising both
 * (NFKC, casefold, zero-width characters removed, every non-letter /
 * non-digit run → one space — so "W-2, and" and "W-2 — and" match, "pay 50"
 * does not match "pay 500"). An item's own claim must be inside its own quote:
 * date_text, amount_text and case_refs[].text, normalised the same way, must
 * occur as whole words in the item's quote ("$50,000" quoting "the" fails). A
 * commitment's quote may span segments only of ONE speaker (a splice across a
 * speaker change is dropped). An item that fails, or is malformed, is DROPPED
 * and counted in `dropped` — never repaired.
 *
 * `t` (seconds, for Listen-jump) is NEVER the model's: it is the start of the
 * segment in which the quote begins. With no segments it is null.
 *
 * parties[].speaker must be a speaker that exists in the segments (A, B… or
 * ch1, ch2…); a party naming none is dropped and counted. A `name` survives
 * only if it occurs in the transcript AS WHOLE WORDS ("Tom" is not in
 * "tomorrow") or equals a known name (the matched contact) — otherwise null.
 *
 * A failed validation returns a FIXED code in `why` (never model text): it
 * lands in comms_summaries.last_error and in alerts.
 *
 * A voicemail's call_type is always 'voicemail' (its caller's role stays in
 * parties[]).
 */

'use strict';

const CALL_TYPES = new Set(['client', 'prospect', 'creditor', 'trustee', 'court', 'opposing_counsel',
  'agency', 'vendor', 'personal', 'spam', 'voicemail', 'other']);
const ROLES = new Set(['firm', 'client', 'other']);
const BY = new Set(['firm', 'other']);
const FLAGS = new Set(['personal', 'sensitive', 'dispute']);

const MAX = { summary: 2000, what: 300, quote: 500, text: 200, why: 500, name: 120 };
const MIN_QUOTE_WORDS = 3;

/**
 * NFKC, casefold, zero-width characters removed, every run of anything that is
 * not a letter or a digit → one space, trimmed. The result is space-separated
 * words, so a whole-word match is a ' '-padded substring test.
 */
function normalise(s) {
  return String(s == null ? '' : s)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[​-‍⁠﻿­]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const words = (n) => (n ? n.split(' ').length : 0);
/** Whole-word containment: does normalised `needle` occur in normalised `hay` on word boundaries? → offset or -1. */
function wordIndex(hay, needle) {
  if (!needle) return -1;
  return (` ${hay} `).indexOf(` ${needle} `);       // the padded index IS the unpadded start offset
}

/**
 * The haystack: segment texts normalised and joined by one space, with each
 * segment's start offset and speaker — so a hit maps back to its segment(s).
 */
function haystackOf(segments, fullText) {
  const segs = Array.isArray(segments) ? segments : [];
  if (!segs.length) return { text: normalise(fullText), starts: [], segs: [] };
  let text = '';
  const starts = [];
  const kept = [];
  for (const s of segs) {
    const t = normalise(s && s.t);
    if (!t) continue;
    if (text) text += ' ';
    starts.push(text.length);
    kept.push(s);
    text += t;
  }
  return { text, starts, segs: kept };
}

/** Index of the segment containing offset `at`; -1 without segments. */
function segAt(hay, at) {
  if (!hay.starts.length) return -1;
  let lo = 0, hi = hay.starts.length - 1, k = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (hay.starts[mid] <= at) { k = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return k;
}

function timeAt(hay, at) {
  const k = segAt(hay, at);
  if (k < 0) return null;
  const a = Number(hay.segs[k].a);
  return Number.isFinite(a) ? a : null;
}

/** Does the span [at, at+len) stay within ONE speaker's segments? (no segments → nothing to check) */
function oneSpeaker(hay, at, len) {
  const k1 = segAt(hay, at);
  if (k1 < 0) return true;
  const k2 = segAt(hay, at + Math.max(len, 1) - 1);
  for (let k = k1 + 1; k <= k2; k++) if (hay.segs[k].s !== hay.segs[k1].s) return false;
  return true;
}

const isStr = (v, max, min = 1) => typeof v === 'string' && v.trim().length >= min && v.length <= max;
const fail = (why) => ({ ok: false, why });

/**
 * One evidence list. Malformed or ungrounded items are dropped (counted);
 * a non-array (when present) fails the summary.
 * spec: { fields: {name: 'by'|'what'|'text'}, claim: <field that must sit inside the quote>, t: bool, oneSpeaker: bool }
 */
function evidence(list, spec, hay, counter) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const it of list) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) { counter.n++; continue; }
    const clean = {};
    let okItem = true;
    for (const [k, kind] of Object.entries(spec.fields)) {
      const v = it[k];
      if (kind === 'by') { if (!BY.has(v)) okItem = false; else clean[k] = v; continue; }
      if (!isStr(v, MAX[kind] || MAX.text)) { okItem = false; continue; }
      clean[k] = v.trim();
    }
    if (!okItem || !isStr(it.quote, MAX.quote)) { counter.n++; continue; }
    const q = normalise(it.quote);
    const at = words(q) >= MIN_QUOTE_WORDS ? wordIndex(hay.text, q) : -1;
    if (at < 0) { counter.n++; continue; }
    if (spec.claim && wordIndex(q, normalise(clean[spec.claim])) < 0) { counter.n++; continue; }
    if (spec.oneSpeaker && !oneSpeaker(hay, at, q.length)) { counter.n++; continue; }
    clean.quote = it.quote.trim();
    if (spec.t) clean.t = timeAt(hay, at);
    out.push(clean);
  }
  return out;
}

function validate(json, { segments = [], fullText = '', kind = 'call_recording', knownNames = [] } = {}) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return fail('not_object');
  const hay = haystackOf(segments, fullText);
  const counter = { n: 0 };

  let callType = json.call_type;
  if (kind === 'voicemail') callType = 'voicemail';
  else if (!CALL_TYPES.has(callType)) return fail('bad_call_type');

  if (!isStr(json.summary, MAX.summary)) return fail('bad_summary');
  const summaryText = json.summary.trim();

  const speakers = new Set((Array.isArray(segments) ? segments : []).map(s => s && s.s).filter(Boolean));
  const known = new Set((knownNames || []).filter(Boolean).map(normalise));
  const parties = [];
  if (json.parties !== undefined && json.parties !== null) {
    if (!Array.isArray(json.parties)) return fail('parties_not_array');
    for (const p of json.parties) {
      if (!p || typeof p !== 'object' || !speakers.has(p.speaker) || !ROLES.has(p.role)) { counter.n++; continue; }
      let name = null;
      if (isStr(p.name, MAX.name)) {
        const n = normalise(p.name);
        if (n && (known.has(n) || wordIndex(hay.text, n) >= 0)) name = p.name.trim();
      }
      parties.push({ speaker: p.speaker, role: p.role, name });
    }
  }

  const commitments = evidence(json.commitments, { fields: { by: 'by', what: 'what' }, t: true, oneSpeaker: true }, hay, counter);
  const dates = evidence(json.dates, { fields: { what: 'what', date_text: 'text' }, claim: 'date_text', t: true }, hay, counter);
  const documents = evidence(json.documents_requested, { fields: { what: 'what' }, t: true }, hay, counter);
  const amounts = evidence(json.amounts, { fields: { what: 'what', amount_text: 'text' }, claim: 'amount_text', t: true }, hay, counter);
  const caseRefs = evidence(json.case_refs, { fields: { text: 'text' }, claim: 'text', t: false }, hay, counter);
  for (const [k, v] of Object.entries({ commitments, dates, documents_requested: documents, amounts, case_refs: caseRefs })) {
    if (v === null) return fail(`${k}_not_array`);
  }

  let followUp = { needed: false, why: '' };
  if (json.follow_up !== undefined && json.follow_up !== null) {
    const f = json.follow_up;
    if (!f || typeof f !== 'object' || typeof f.needed !== 'boolean') return fail('follow_up_malformed');
    followUp = { needed: f.needed, why: typeof f.why === 'string' ? f.why.trim().slice(0, MAX.why) : '' };
  }

  let flags = [];
  if (json.flags !== undefined && json.flags !== null) {
    if (!Array.isArray(json.flags)) return fail('flags_not_array');
    flags = [...new Set(json.flags.filter(f => FLAGS.has(f)))];
  }

  return {
    ok: true,
    summaryText,
    dropped: counter.n,
    summary: {
      call_type: callType, summary: summaryText, parties,
      commitments, dates, documents_requested: documents, amounts, case_refs: caseRefs,
      follow_up: followUp, flags,
    },
  };
}

/** The transcript as the model reads it: "[mm:ss] S: text" per segment (h:mm:ss past an hour). */
function transcriptText(segments, fullText) {
  const segs = Array.isArray(segments) ? segments : [];
  if (!segs.length) return String(fullText || '');
  const ts = (sec) => {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    const mm = String(m).padStart(2, '0'), ss = String(r).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  };
  return segs.map(s => `[${ts(s.a)}] ${s.s}: ${s.t}`).join('\n');
}

module.exports = { validate, normalise, haystackOf, transcriptText, MIN_QUOTE_WORDS, CALL_TYPES, ROLES, FLAGS };
