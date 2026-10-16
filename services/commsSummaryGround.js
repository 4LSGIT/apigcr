// services/commsSummaryGround.js
//
/**
 * Comms archive S3 — the STRICT schema validation and the GROUNDING check for
 * an AI call summary (ref/COMMS_ARCHIVE_DESIGN.md §6.4). Pure: model JSON +
 * the transcript in, a clean summary out. No DB, no I/O.
 *
 *   validate(json, { segments, fullText, kind, knownNames })
 *     → { ok: true, summary, summaryText, dropped, coerced, selfAddressed }
 *     | { ok: false, why }
 *
 * SHAPE (strict): the §6.4 keys only — anything else is dropped; a key of the
 * wrong TYPE fails the whole summary (the caller counts an attempt). Enums are
 * closed (call_type, by, role); flags keep only the known ones.
 *
 * GROUNDING: every evidence item (commitments, dates, documents_requested,
 * amounts, case_refs) must carry a `quote` that occurs in the transcript ON
 * WORD BOUNDARIES after normalising both: NFKC, casefold, zero-width
 * characters removed, thousands commas dropped ("$1,200.50" = "1200.50"),
 * ordinal suffixes dropped ("3rd" = "3"), then split into tokens — a NUMBER
 * keeps its inner . / : - ("3/15", "1200.50", "10:30" are one token each),
 * everything else breaks on any non-letter / non-digit ("W-2, and" = "W-2 —
 * and" = "w 2 and"). So "$50" never grounds in "$50,000", "$1,200" not in
 * "$1,200.50", "3" not in "3/15", "pay 50" not in "pay 500".
 *
 * Quote length: documents_requested needs ≥ MIN_QUOTE_WORDS (3) words. A
 * date / amount / case ref may quote 1–2 words — its claim-in-quote check ties
 * it — but a claim that is a BARE number (only digits once normalised: no
 * currency word, month or case-number shape) needs a quote of ≥ 2 words unless
 * the quote itself carries a currency sign ("$50,000" stands alone), so a lone
 * "50" from "I'm 50 years old" cannot ground "$50". A commitment needs 3
 * words, unless its quote is a WHOLE segment ("Yes.", "Will do."): then EVERY
 * For EVERY commitment (v3) every occurrence of its quote is tried, and the
 * first that is ONE speaker's words AND whose speaker's role from parties[]
 * agrees with `by` (firm ↔ firm; other ↔ client / other; a speaker with no
 * role given cannot contradict it) — and, for a short quote, a whole segment —
 * is taken (t is that occurrence's). So a firm commitment quoted from the
 * other party's request is dropped, and a phrase said by both sides is kept
 * at the right speaker's turn. An item's own claim must be inside its own quote:
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
 * SELF-ADDRESS (v4): a name said TO someone names the OTHER speaker, so a party
 * whose OWN segments greet, thank, answer or bid goodbye to its assigned name
 * ("hey Stuart", "thanks so much Stuart", "yes, Stuart Sandweiss" in reply,
 * "bye Mr. Sandweiss") has that name contradicted by its own words — the v3
 * QA's top fault, roles swapped by address on the attorney's outgoing calls.
 * Its `name` becomes null and its speaker is listed in `selfAddressed` (the
 * sweep lists the transcript in the tick output). Here it only FLAGS, never
 * repairs: the role stays as given, and nothing is counted in `dropped`; the
 * sweep's guided retry (v4.1, commsSummarizeSweep) acts on it. The name must
 * follow the opener (hi / hey / hello / yes / thanks / thank you / bye /
 * goodbye / good morning…) in the same clause — fillers ("so much", "there")
 * and a title aside, a sentence break ends it — so a self-introduction never
 * matches: "hi, this is Stuart", "hello, it's Stuart"; an opener + name
 * followed by "calling" / "here" / "speaking" / "from" is one too. Read on the
 * RAW words: the name must be capitalised ("Yes, will do." is no address to
 * Will) and must not run on into a lowercase word ("Thanks, Mark it down.").
 * The FULL name (the assigned surname next, or any capitalised word run
 * straight on — the surname unassigned or misheard) after a GREETING (hi /
 * hey / hello / good morning…) is a self-introduction in any segment ("Hello,
 * Stuart Sandweiss.", "Hi, Stuart Sandweiss again"); after a REPLY (yes /
 * thanks / thank you / bye / goodbye) it is an address — outside the speaker's
 * own first segment ("Yes, Stuart Sandweiss." after "you know who it is?").
 * A last name alone counts only after a title. v4.2 (the v4.1 QA: every call
 * still flagged after the retry had correct roles): a segment that ALSO plainly
 * addresses a different name is not counted — a reply + the full name there is
 * the speaker's own (a split pickup: "Hello, Maria. Yes, Stuart Sandweiss."),
 * and two plain addresses are merged turns ("Hey, Stuart. Hi, Maria.") —
 * ambiguous (a near-variant of the assigned name — "Stewart", "Stu" — is the
 * same name, and "I", "Ma'am", "Absolutely"… are no names); and thanks /
 * thank you + the FULL name ENDING a segment (only digits or punctuation after
 * it; "… Stuart Sandweiss. Bye." does not end with the name) with ≥ SIGNOFF_MIN_WORDS (20) words before it
 * is a sign-off ("… Thank you, Stuart Sandweiss." closing a letter read aloud).
 * Not handled: on-screen text read aloud that holds the reader's own name.
 *
 * A failed validation returns a FIXED code in `why` (never model text): it
 * lands in comms_summaries.last_error and in alerts.
 *
 * call_type (v3) is the counterparty / purpose and never 'voicemail': an
 * output saying so is COERCED to call_type 'other' + reached_voicemail true
 * and reported as coerced: 'call_type' (a label is not an ungrounded claim, so
 * it costs no attempt); reached_voicemail is a boolean (missing = false; any
 * other type fails), forced true for a voicemail.
 *
 * dates[].resolved_date (v3) is DERIVED — the model's reading of date_text
 * against the call day — so it is not grounded: it survives only as a real
 * calendar date YYYY-MM-DD within [callDay − 400, callDay + 800] days, and is
 * otherwise null (the item, grounded by date_text + quote, stays). Any surface
 * shows it as resolved, never as said.
 */

'use strict';

// v3: call_type is the counterparty / purpose — "it went to voicemail" is reached_voicemail, not a type.
const CALL_TYPES = new Set(['client', 'prospect', 'creditor', 'trustee', 'court', 'opposing_counsel',
  'agency', 'vendor', 'personal', 'spam', 'other']);
/** resolved_date must fall within this many days of the call (firm-local calendar day) — else null. */
const RESOLVED_RANGE = Object.freeze({ before: 400, after: 800 });
const ROLES = new Set(['firm', 'client', 'other']);
const BY = new Set(['firm', 'other']);
const FLAGS = new Set(['personal', 'sensitive', 'dispute']);

const MAX = { summary: 2000, what: 300, quote: 500, text: 200, why: 500, name: 120 };
/** v4 self-address (see the header): normalised word patterns. */
const ADDRESS = Object.freeze({
  greetings: ['hi', 'hey', 'hello', 'good morning', 'good afternoon', 'good evening'],   // + a FULL name: a self-introduction
  replies: ['yes', 'thanks', 'thank you', 'bye', 'goodbye'],                              // + a FULL name: an address
  fillers: ['so much', 'very much', 'a lot', 'again', 'there'],
  titles: ['mr', 'mrs', 'ms', 'miss', 'dr'],
  selfTails: ['calling', 'here', 'speaking', 'from'],
  signOffs: ['thanks', 'thank you'],                                                      // + a FULL name ending a long segment: a sign-off
  // compared with apostrophes removed ("Ma'am" → maam, "I'll" → ill): pronouns, forms of address, and the reply words a
  // transcriber may capitalise after a comma ("Yes, Absolutely.") — none of them a name
  notNames: ['i', 'im', 'ill', 'ive', 'id', 'sir', 'maam', 'madam', 'mister', 'everyone', 'everybody', 'guys', 'all', 'god',
    'absolutely', 'sure', 'great', 'perfect', 'right', 'correct', 'exactly', 'definitely', 'certainly', 'fine', 'cool',
    'awesome', 'wonderful', 'excellent', 'good', 'welcome', 'please', 'no', 'nope', 'of', 'so', 'well', 'now', 'again',
    'too', 'also', 'anyway', 'that', 'this', 'it', 'we', 'you', 'he', 'she', 'they', 'the', 'and', 'but'],
});
/** v4.2: a reply + the FULL name that ENDS a segment with at least this many words before it is a sign-off, not an address. */
const SIGNOFF_MIN_WORDS = 20;
/**
 * v4.2: words that carry no content on their own — greetings, fillers, goodbyes, the stock "thank you for calling" /
 * "have a nice day", and the dead-air phrases of a call that never connected ("Hello? Hello? Can you hear me?").
 * Normalised forms ("can't" → "can t"). contentWords() scans the tokens once, dropping the longest phrase that starts at
 * each token, then the single words; what is left is content (the no-speech gate, commsSummarizeSweep.speechGate).
 */
const FILLER = Object.freeze({
  phrases: ['can you hear me', 'can t hear you', 'cannot hear you', 'i can t hear you', 'are you there', 'is anybody there',
    'is anyone there', 'anybody there', 'anyone there', 'hello there', 'hi there', 'thank you', 'good morning',
    'good afternoon', 'good evening', 'one moment', 'one second', 'just a second', 'hold on', 'excuse me', 'bye bye', 'uh huh',
    'thank you for calling', 'thank you very much for calling', 'thanks for calling', 'have a nice day', 'have a good day',
    'have a great day'],
  words: ['hello', 'hi', 'hey', 'hiya', 'yes', 'yeah', 'yep', 'yup', 'ya', 'ok', 'okay', 'oh', 'um', 'uh', 'umm', 'uhh',
    'hmm', 'hm', 'mm', 'mhm', 'mmhmm', 'ah', 'er', 'erm', 'alright', 'bye', 'goodbye', 'thanks', 'sorry', 'pardon', 'huh'],
});
const MIN_QUOTE_WORDS = 3;

/**
 * NFKC, casefold, zero-width characters removed, every run of anything that is
 * not a letter or a digit → one space, trimmed. The result is space-separated
 * words, so a whole-word match is a ' '-padded substring test.
 */
function normalise(s) {
  const t = String(s == null ? '' : s)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[​-‍⁠﻿­]/g, '')
    .replace(/(\d),(?=\d{3}(?!\d))/g, '$1')                   // thousands separators: 1,200,000 → 1200000
    .replace(/(\d)(?:st|nd|rd|th)(?![\p{L}\p{N}])/gu, '$1');   // ordinals: 3rd → 3
  // A number keeps its inner . / : - (3/15, 1200.50, 10:30); anything else breaks on non-letters / non-digits.
  return (t.match(/\d+(?:[.\/:\-]\d+)*|[\p{L}\p{N}]+/gu) || []).join(' ');
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

/** Every occurrence of `q` (on word boundaries); the first that is a whole segment whose test passes → its offset, else -1. */
function firstHit(hay, q, accept) {
  const padded = ` ${hay.text} `;
  for (let i = padded.indexOf(` ${q} `); i >= 0; i = padded.indexOf(` ${q} `, i + 1)) {
    if (accept(i)) return i;
  }
  return -1;
}

/** Does the speaker of the segment a hit at `at` starts in agree with `by`? (No segments / no role → no objection.) */
function speakerAgrees(hay, roles, at, by) {
  const k = segAt(hay, at);
  return k < 0 || roleAgrees(roles, hay.segs[k].s, by);
}

/** A commitment's `by` against its speaker's role (parties[]): firm ↔ firm, other ↔ client / other. No role → no objection. */
function roleAgrees(roles, speaker, by) {
  const role = roles.get(speaker);
  if (!role) return true;
  return by === 'firm' ? role === 'firm' : role !== 'firm';
}

/** Is the hit at `at` exactly one whole (normalised) segment? */
function wholeSegment(hay, at, q) {
  const k = segAt(hay, at);
  return k >= 0 && hay.starts[k] === at && normalise(hay.segs[k].t) === q;
}

/** Does the span [at, at+len) stay within ONE speaker's segments? (no segments → nothing to check) */
function oneSpeaker(hay, at, len) {
  const k1 = segAt(hay, at);
  if (k1 < 0) return true;
  const k2 = segAt(hay, at + Math.max(len, 1) - 1);
  for (let k = k1 + 1; k <= k2; k++) if (hay.segs[k].s !== hay.segs[k1].s) return false;
  return true;
}

/** v4.2: the words of `text` that carry content — normalised, the FILLER phrases and words removed (see FILLER). */
const FILLER_PHRASE_TOKENS = FILLER.phrases.map(p => p.split(' ')).sort((a, b) => b.length - a.length);   // longest first
function contentWords(text) {
  // One left-to-right token scan (a repeated string replace was quadratic: 1.3 s on 50k repeats).
  const t = normalise(text).split(' ').filter(Boolean);
  const out = [];
  for (let i = 0; i < t.length;) {
    const ph = FILLER_PHRASE_TOKENS.find(p => p.every((w, j) => t[i + j] === w));
    if (ph) { i += ph.length; continue; }
    if (!FILLER.words.includes(t[i])) out.push(t[i]);
    i++;
  }
  return out;
}

/**
 * v4 / v4.2: do `speaker`'s own segments greet / thank / answer / bid goodbye to `name` (its assigned name)? See the
 * header. One segment at a time: an address to the assigned name counts unless the SAME segment also plainly addresses
 * a DIFFERENT name (v4.2) — then a reply + the full name is the speaker's own (a split pickup: "Hello, Maria. Yes,
 * Stuart Sandweiss."), and two plain addresses are two people's turns merged by diarization ("Hey, Stuart. Hi, Maria.")
 * — ambiguous, so not counted either way.
 */
function addressesOwnName(hay, speaker, name) {
  const toks = normalise(name).split(' ').filter(t => t && !ADDRESS.titles.includes(t));
  if (!toks.length) return false;
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');
  const SEP = '[\\s,;:—–-]+';                       // inside one clause: a sentence break (. ! ?) ends the greeting
  const alt = (xs) => xs.map(x => x.split(' ').map(esc).join(SEP)).join('|');
  const title = `(?:${alt(ADDRESS.titles)})\\.?${SEP}`;
  const first = esc(toks[0]), last = toks[toks.length - 1];
  const who = toks.length > 1 ? `(?:${title})?(${first})|${title}(${esc(last)})` : `(?:${title})?(${first})`;
  const opener = `(?:^|[^\\p{L}\\p{N}])(${alt([...ADDRESS.greetings, ...ADDRESS.replies])})(?:${SEP}(?:${alt(ADDRESS.fillers)}))?${SEP}`;
  // Read on the RAW words: a name is capitalised by the transcriber, a common word ("yes, will do") is not.
  const re = new RegExp(`${opener}(?:${who})(?![\\p{L}\\p{N}])`, 'giu');
  // v4.2: any word after an opener (a title allowed) — a candidate address to SOMEONE; classified below.
  const reAny = new RegExp(`${opener}(?:${title})?([\\p{L}][\\p{L}'’]*)(?![\\p{L}\\p{N}])`, 'giu');
  const nonName = new Set([...ADDRESS.notNames, ...ADDRESS.titles, ...FILLER.words,
    ...[...ADDRESS.greetings, ...ADDRESS.replies].map(x => x.split(' ')[0])]);
  /**
   * v4.2: the same name, misspelled or shortened by the transcriber ("Stewart" / "Stu" for Stuart): a token sharing its
   * first 3 letters with an assigned name token, or its first 2 letters and within 2 edits of it.
   */
  const sameName = (w) => toks.some(t => t === w || (w.length >= 3 && t.length >= 3 && w.slice(0, 3) === t.slice(0, 3))
    || (w.slice(0, 2) === t.slice(0, 2) && editDistance(w, t) <= 2));
  /** v4.2: a PLAIN address to a name that is not the assigned one: capitalised, alone (no capitalised word run on), not run on into its clause, no self-tail. */
  const addressesAnother = (raw) => {
    for (const m of raw.matchAll(reAny)) {
      const w = normalise(m[2].replace(/['’]/g, '')).split(' ')[0] || '';
      if (!/^\p{Lu}/u.test(m[2]) || sameName(w) || nonName.has(w)) continue;
      const rest = raw.slice(m.index + m[0].length);
      if (/^\s+\p{L}/u.test(rest)) continue;                         // "Thanks, Mark it down" / "Hello, Maria Lopez" (a full name: no plain address)
      if (ADDRESS.selfTails.includes(normalise(rest).split(' ')[0] || '')) continue;
      return true;
    }
    return false;
  };
  const own = hay.segs.filter(s => s && s.s === speaker);
  return own.some((s, i) => {
    const raw = String(s.t).normalize('NFKC').replace(/[​-‍⁠﻿­]/g, '');
    let hit = false;
    for (const m of raw.matchAll(re)) {
      if (!/^\p{Lu}/u.test(m[2] || m[3])) continue;                 // "Yes, will do." — not a name
      const rest = raw.slice(m.index + m[0].length);
      if (/^\s+\p{Ll}/u.test(rest)) continue;                       // "Thanks, Mark it down." — the word runs on into its clause
      const next = normalise(rest).split(' ')[0] || '';
      if (ADDRESS.selfTails.includes(next)) continue;               // "Hi, Stuart here" / "… calling" / "… speaking" / "… from"
      // The FULL name (the assigned surname next, or any capitalised word run straight on: unassigned or misheard).
      const full = !!m[2] && ((toks.length > 1 && next === last) || /^\s+\p{Lu}/u.test(rest));
      if (!full) { hit = true; break; }                             // a first name (or a title + surname) alone: an address
      const op = normalise(m[1]);
      if (ADDRESS.greetings.includes(op)) continue;                 // "Hello, Stuart Sandweiss." — a self-introduction, anywhere
      if (i === 0) continue;                                        // "Yes, Stuart Sandweiss." as the opening line — a self-ID
      if (ADDRESS.signOffs.includes(op)) {
        // v4.2: "… Thank you, Stuart Sandweiss." ENDING a long segment (a letter read aloud, a message) is a sign-off:
        // after the full name only digits (a call-back number) or punctuation, and SIGNOFF_MIN_WORDS words before it.
        // the rest of the name: capitalised words, an initial may keep its period ("J."); a sentence after it is not the name
        const after = rest.replace(/^(?:[\s,;:—–-]+\p{Lu}(?:\.|[\p{L}'’\-]*))+/u, '');
        const before = raw.slice(0, /^[\p{L}\p{N}]/u.test(m[0]) ? m.index : m.index + 1);   // the words ahead of the opener
        if (!/\p{L}/u.test(after) && words(normalise(before)) >= SIGNOFF_MIN_WORDS) continue;
      }
      hit = true; break;                                            // "Yes, Stuart Sandweiss." after the opening line — an address
    }
    return hit && !addressesAnother(raw);
  });
}

/** Levenshtein distance, for two short name tokens. */
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

const isStr = (v, max, min = 1) => typeof v === 'string' && v.trim().length >= min && v.length <= max;
const fail = (why) => ({ ok: false, why });

/**
 * One evidence list. Malformed or ungrounded items are dropped (counted);
 * a non-array (when present) fails the summary.
 * spec: { fields: {name: 'by'|'what'|'text'}, claim: <field that must sit inside the quote>, t: bool, oneSpeaker: bool }
 */
function evidence(list, spec, hay, counter, roles = new Map()) {
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
    let at = wordIndex(hay.text, q);
    if (at < 0) { counter.n++; continue; }
    if (spec.claim) {
      // A bare number binds nothing on its own: it needs a quote of 2+ words, or a currency sign IN the quote.
      const bare = /^\d+( \d+)*$/.test(normalise(clean[spec.claim])) && !/[$€£]/.test(it.quote);
      if (words(q) < (bare ? 2 : 1)) { counter.n++; continue; }
    } else if (!spec.oneSpeaker && words(q) < MIN_QUOTE_WORDS) { counter.n++; continue; }
    if (spec.oneSpeaker) {
      // A promise is quoted from the one who makes it. EVERY occurrence is tried (a phrase said by both sides,
      // or a short "Yes." said mid-sentence first): the first that is ONE speaker's words, by someone whose role
      // agrees with `by` — and, for a quote under MIN_QUOTE_WORDS, a WHOLE segment — is taken, with its t.
      const short = words(q) < MIN_QUOTE_WORDS;
      at = firstHit(hay, q, (i) => (!short || wholeSegment(hay, i, q)) && oneSpeaker(hay, i, q.length)
        && speakerAgrees(hay, roles, i, clean.by));
      if (at < 0) { counter.n++; continue; }
    }
    if (spec.claim && wordIndex(q, normalise(clean[spec.claim])) < 0) { counter.n++; continue; }
    clean.quote = it.quote.trim();
    if (spec.t) clean.t = timeAt(hay, at);
    if (spec.resolveDay !== undefined) clean.resolved_date = resolvedDate(it.resolved_date, spec.resolveDay);
    out.push(clean);
  }
  return out;
}

/** A model's resolved_date → 'YYYY-MM-DD' when it is a real date within RESOLVED_RANGE of callDay, else null. */
function resolvedDate(v, callDay) {
  const day = (x) => {
    if (typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x)) return null;
    const [y, m, d] = x.split('-').map(Number);
    const ms = Date.UTC(y, m - 1, d);
    const back = new Date(ms);
    return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d ? ms : null;
  };
  const at = day(v), base = day(callDay);
  if (at == null || base == null) return null;
  const diff = (at - base) / 86_400_000;
  return diff >= -RESOLVED_RANGE.before && diff <= RESOLVED_RANGE.after ? v : null;
}

function validate(json, { segments = [], fullText = '', kind = 'call_recording', knownNames = [], callDay = null } = {}) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return fail('not_object');
  const hay = haystackOf(segments, fullText);
  const counter = { n: 0 };

  let callType = json.call_type;
  let coerced = null;
  // v2's habit: "voicemail" as a TYPE. A label is not an ungrounded claim — coerce it (counted), never burn an attempt.
  if (callType === 'voicemail') { callType = 'other'; coerced = 'call_type'; }
  if (!CALL_TYPES.has(callType)) return fail('bad_call_type');
  let reachedVoicemail = coerced === 'call_type';
  if (json.reached_voicemail !== undefined && json.reached_voicemail !== null) {
    if (typeof json.reached_voicemail !== 'boolean') return fail('bad_reached_voicemail');
    reachedVoicemail = json.reached_voicemail || coerced === 'call_type';
  }
  if (kind === 'voicemail') reachedVoicemail = true;

  if (!isStr(json.summary, MAX.summary)) return fail('bad_summary');
  const summaryText = json.summary.trim();

  const speakers = new Set((Array.isArray(segments) ? segments : []).map(s => s && s.s).filter(Boolean));
  const known = new Set((knownNames || []).filter(Boolean).map(normalise));
  const parties = [];
  const selfAddressed = [];
  if (json.parties !== undefined && json.parties !== null) {
    if (!Array.isArray(json.parties)) return fail('parties_not_array');
    for (const p of json.parties) {
      if (!p || typeof p !== 'object' || !speakers.has(p.speaker) || !ROLES.has(p.role)) { counter.n++; continue; }
      let name = null;
      if (isStr(p.name, MAX.name)) {
        const n = normalise(p.name);
        if (n && (known.has(n) || wordIndex(hay.text, n) >= 0)) name = p.name.trim();
      }
      // v4: a name the party greets in its OWN words is the other speaker's — contradicted, so null (counted apart).
      if (name && addressesOwnName(hay, p.speaker, name)) { name = null; selfAddressed.push(p.speaker); }
      parties.push({ speaker: p.speaker, role: p.role, name });
    }
  }

  const roles = new Map(parties.map(p => [p.speaker, p.role]));
  const commitments = evidence(json.commitments, { fields: { by: 'by', what: 'what' }, t: true, oneSpeaker: true }, hay, counter, roles);
  const dates = evidence(json.dates, { fields: { what: 'what', date_text: 'text' }, claim: 'date_text', t: true, resolveDay: callDay }, hay, counter);
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
    coerced,
    selfAddressed,
    summary: {
      call_type: callType, reached_voicemail: reachedVoicemail, summary: summaryText, parties,
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

module.exports = { validate, normalise, haystackOf, transcriptText, resolvedDate, contentWords, MIN_QUOTE_WORDS, CALL_TYPES, ROLES, FLAGS,
  RESOLVED_RANGE, ADDRESS, FILLER, SIGNOFF_MIN_WORDS };
