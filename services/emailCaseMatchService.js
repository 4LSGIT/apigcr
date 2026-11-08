// services/emailCaseMatchService.js
//
/**
 * EMAIL → CASE — which case does an inbound email belong to?
 *
 * One question, asked by the email-attachment filing service
 * (services/emailAttachmentFilingService.js) and exposed to automations as the
 * `email_case_match` internal function. Read-only: it never writes anything.
 * Design: ref/EMAIL_ATTACHMENTS_DESIGN.md §3 (rulings Fred 2026-11-06).
 *
 * ── THE RULES, IN ORDER ─────────────────────────────────────────────────────
 *   E = the cases the email NAMES — by case id or by case number (docket:
 *       case_number or case_number_full): the subject first; the body (the
 *       sender's own text — quoted history cut off) only when the subject
 *       names none.
 *   S = the sender's OPEN client cases: the sender's ACTIVE contact_emails row
 *       (one active owner per address, uk_email_active) → case_relate
 *       Primary / Secondary (the Comms related() rule — an attorney or trustee
 *       related as 'Other' on fifty cases is not "their" case) → stage Open,
 *       Pending or Filed.
 *
 *   |E| > 1                    → no match, flag 'multiple_case_ids'
 *   |E| = 1, S empty           → E   (a relative or employer sending with the
 *                                     id; a client with no open case)
 *   |E| = 1, E ∈ S             → E
 *   |E| = 1, E is one of the sender's cases at ANY stage → E
 *   |E| = 1, otherwise         → no match, flag 'conflict'  (unsorted + flag,
 *                                     ruling Q2 — never trust the id over a
 *                                     known client's own cases; the notice
 *                                     offers both as one-click choices)
 *   no id, |S| = 1             → S
 *   no id, |S| > 1             → the ONE retained case (pipeline_phase 'case')
 *                                if exactly one, else flag 'multiple_open_cases'
 *   no id, S empty             → flag 'no_open_case' (known contact; their
 *                                other cases are candidates) or
 *                                'unknown_sender'
 *
 * ── CASE IDS — ANY VINTAGE (Fred, 2026-11-08) ───────────────────────────────
 * lib/caseId mints 8 uppercase Crockford Base32 characters; the ~1,060 legacy
 * ids are 8 base64url characters, mixed case (13 of them happen to be all
 * caps, e.g. MY0PZ04I — the I is not Crockford). Both are recognized. Two
 * forms, each needing at least one letter (no case id is all digits, and a
 * docket like "12-34567" is not an id):
 *   - "case <id>" (also "case: ", "case #", "case id ", "case no. ") — any
 *     letter case, subject or body (clients type "case pvxc1rmm");
 *   - a bare token — SUBJECT ONLY, uppercase letters and digits only
 *     ("- PVXC1RMM", "MY0PZ04I") — never an ordinary mixed-case word.
 * Looked up case-INsensitively, which is exact here: cases.case_id is the
 * PRIMARY KEY under utf8mb4_general_ci, so no two ids differ only in letter
 * case and a token matches at most one case.
 *
 * ── CASE NUMBERS (Fred, 2026-11-08) ─────────────────────────────────────────
 * Dockets are opaque free text (CLAUDE.md): "26-52011", "26-52011-mar",
 * "1:26-cv-00546-JLR", "18-LV02229", "354887". Nothing here parses their
 * shape — a candidate TOKEN is compared for EQUALITY with case_number and
 * case_number_full (trimmed, case-insensitive), so only a docket a case
 * actually carries can match. Candidates: every whitespace-separated token
 * of the subject, and in the body only the token after "case" / "case
 * number" / "case no." / "case #" — punctuation stripped from the ends,
 * 5–40 characters, at least 4 digits, not an address or URL. The digit/length
 * floor only bounds the lookup; it validates nothing.
 *
 * ── SHAPE ───────────────────────────────────────────────────────────────────
 * matchCase() → {
 *   case_id      string|null   the case to file under; null = unsorted
 *   method       'case_id_in_subject' | 'case_number_in_subject' |
 *                'case_id_in_body' | 'case_number_in_body' |
 *                'sender_open_case' | 'sender_retained_case' | null
 *   flag         null | 'conflict' | 'multiple_case_ids' |
 *                'multiple_open_cases' | 'no_open_case' | 'unknown_sender'
 *   reason       one plain sentence for the staff notice
 *   contact      {contact_id, name, lfm_name} | null — the sender
 *   candidates   [{case_id, case_number, case_type, case_stage, case_status,
 *                  pipeline_phase, from: 'id'|'sender'}]  (≤ CANDIDATES_MAX;
 *                  'id' = named in the email, by id or case number)
 *   ids_found    the cases the email names (canonical case_id)
 * }
 */

'use strict';

/** Stages that count as "open" (ruling Q1, 2026-11-06). */
const OPEN_STAGES = Object.freeze(['Open', 'Pending', 'Filed']);

/** case_relate types that make a case the sender's own (mailReadService.CLIENT_RELATIONS). */
const CLIENT_RELATIONS = Object.freeze(['Primary', 'Secondary']);

/** Ordering for candidates: open stages first (mailReadService.STAGE_RANK). */
const STAGE_RANK = Object.freeze({ Open: 0, Pending: 1, Filed: 2, Concluded: 3, Closed: 4 });

/** Cap on candidates returned — request_decision takes ≤ 10 options. */
const CANDIDATES_MAX = 6;

/** Typed tokens looked up per message and per kind — a bound on one IN (...). */
const IDS_MAX = 10;

const CROCKFORD = '[0-9A-HJKMNP-TV-Z]';
/** A new-style case id, exactly (lib/caseId.js). Kept for callers; matching takes any vintage. */
const NEW_ID_RE = new RegExp(`^${CROCKFORD}{8}$`);
/** A case id of any vintage: 8 base64url characters (lib/caseId.js header). */
const ANY_ID_RE = /^[0-9A-Za-z_-]{8}$/;
/** Bare token in the subject: 8 uppercase letters/digits, word-bounded on alphanumerics. */
const BARE_RE = /(?:^|[^0-9A-Za-z])([0-9A-Z]{8})(?=$|[^0-9A-Za-z])/g;
// The "case" prefixes. LINEAR by construction — these run on the body of any
// email anyone sends: every whitespace run is followed by something it cannot
// itself match (a keyword, a separator, the token), so a failed attempt backs
// off one run once. The 2026-11-06 form `\s*(…)?[:#-]?\s*` let two runs meet
// across an optional separator: "case" + 32,000 spaces took 1.9 s, quadratic.
// Whitespace may cross a line ("Case number:\n26-52011"). No \b after "case":
// "casenumber 26-52011" is fine, and a token still has to match a case
// exactly. tests/emailAttachments.unit.test.js pins the worst cases.
const PREFIX = '\\bcase(?:\\s*(?:number|num\\.?|no\\.?|id|#))?(?:\\s*[:#-])?\\s*';   // longest word first
/** "case <id>" in any letter case; the id may carry legacy '-' / '_'. */
const PREFIXED_RE = new RegExp(`${PREFIX}([0-9A-Za-z_-]{8})(?![0-9A-Za-z])`, 'gi');
/** "case <token>" — the body's case-number candidates (the token is cleaned + filtered after). */
const PREFIXED_TOKEN_RE = new RegExp(`${PREFIX}(\\S{1,80})`, 'gi');
/** Case-number candidate bounds (a lookup bound, not docket validation). */
const NUMBER_MIN_LEN = 5;
const NUMBER_MAX_LEN = 40;
const NUMBER_MIN_DIGITS = 4;

/**
 * Where the sender's own words end: the first quoted-history marker (the same
 * patterns the docs@ digest trims on) or the first ">"-quoted line. A marker
 * at offset 0 is ignored — that is a forward with no note, all of it quoted.
 */
const QUOTE_MARKERS = Object.freeze([
  // Same-line whitespace only: `^\s*` crossed newlines, so a body of blank
  // lines rescanned to its end from every line start (quadratic — 32,000
  // newlines took 0.9 s).
  /^[^\S\r\n]*On .{4,200}\bwrote:[^\S\r\n]*$/m,
  /^-{2,}[^\S\r\n]*(?:Original|Forwarded) Message[^\S\r\n]*-{2,}/im,
  /^From: .+\n(?:Sent|Date): /m,
  /^_{10,}[^\S\r\n]*$/m,
  /^>/m,
]);

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/** The text up to the first quoted-history marker (see QUOTE_MARKERS). */
function ownText(text) {
  const s = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  let cut = s.length;
  for (const re of QUOTE_MARKERS) {
    const m = re.exec(s);
    if (m && m.index > 0 && m.index < cut) cut = m.index;
  }
  return s.slice(0, cut);
}

// Both pushers stop at IDS_MAX, so a subject of 100,000 digit runs costs a
// scan, not a quadratic de-duplication.
function _push(out, tok) {
  const id = String(tok).toUpperCase();
  if (out.length < IDS_MAX && ANY_ID_RE.test(id) && /[A-Z]/.test(id) && !out.includes(id)) out.push(id);
}

/**
 * Typed case-id TOKENS (not yet checked against the database).
 * @returns {{subject: string[], body: string[]}} uppercase, de-duplicated, in order
 */
function extractCaseIds({ subject, text } = {}) {
  const subj = String(subject == null ? '' : subject);
  const out = { subject: [], body: [] };
  for (const m of subj.matchAll(PREFIXED_RE)) _push(out.subject, m[1]);
  for (const m of subj.matchAll(BARE_RE)) _push(out.subject, m[1]);
  for (const m of ownText(text).matchAll(PREFIXED_RE)) _push(out.body, m[1]);
  return out;
}

/** One case-number candidate, cleaned, or null (see CASE NUMBERS in the header). */
function _numberToken(raw) {
  const t = String(raw).replace(/^[("'\[{<#]+/, '').replace(/[.,;:!?)"'\]}>]+$/, '');
  if (t.length < NUMBER_MIN_LEN || t.length > NUMBER_MAX_LEN) return null;
  if ((t.match(/\d/g) || []).length < NUMBER_MIN_DIGITS) return null;
  if (t.includes('@') || t.includes('://')) return null;
  return t;
}

function _pushNumber(out, raw) {
  if (out.length >= IDS_MAX) return;
  const t = _numberToken(raw);
  if (t && !out.some(x => x.toLowerCase() === t.toLowerCase())) out.push(t);
}

/**
 * Case-number candidate TOKENS (not yet checked against the database): every
 * subject token, and "case <token>" in the sender's own body text.
 * @returns {{subject: string[], body: string[]}} de-duplicated (case-insensitively), in order
 */
function extractCaseNumbers({ subject, text } = {}) {
  const out = { subject: [], body: [] };
  for (const tok of String(subject == null ? '' : subject).split(/\s+/)) _pushNumber(out.subject, tok);
  for (const m of ownText(text).matchAll(PREFIXED_TOKEN_RE)) _pushNumber(out.body, m[1]);
  return out;
}

function _openTime(r) {
  const d = r.case_open_date instanceof Date ? r.case_open_date : (r.case_open_date ? new Date(r.case_open_date) : null);
  return d && !isNaN(d.getTime()) ? d.getTime() : -Infinity;
}

/** Open stages first, then newest opened, then id — mailReadService.related()'s order. */
function _rank(rows) {
  return rows.slice().sort((a, b) =>
    ((STAGE_RANK[a.case_stage] ?? 9) - (STAGE_RANK[b.case_stage] ?? 9)) ||
    (_openTime(b) - _openTime(a)) ||
    String(a.case_id).localeCompare(String(b.case_id)));
}

function _cand(r, from) {
  return {
    case_id: r.case_id,
    case_number: r.case_number_full || r.case_number || null,
    case_type: r.case_type || null,
    case_stage: r.case_stage || null,
    case_status: r.case_status || null,
    pipeline_phase: r.pipeline_phase || null,
    from,
  };
}

function _uniqueCands(list) {
  const seen = new Set();
  const out = [];
  for (const c of list) {
    if (seen.has(c.case_id)) continue;
    seen.add(c.case_id);
    out.push(c);
  }
  return out.slice(0, CANDIDATES_MAX);
}

// ─────────────────────────────────────────────────────────────────────────────
// Database reads
// ─────────────────────────────────────────────────────────────────────────────

const CASE_COLS = `ca.case_id, ca.case_number, ca.case_number_full, ca.case_type, ca.case_stage,
                   ca.case_status, ca.pipeline_phase, ca.case_open_date`;

/**
 * Existing cases among the typed id tokens, keyed by the uppercase token.
 * case_id is the general_ci PRIMARY KEY, so a token matches at most one row.
 */
async function _casesByIds(db, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const [rows] = await db.query(`SELECT ${CASE_COLS} FROM cases ca WHERE ca.case_id IN (?)`, [ids]);
  for (const r of rows) out.set(String(r.case_id).toUpperCase(), r);
  return out;
}

const _norm = (v) => String(v == null ? '' : v).trim().toLowerCase();

/**
 * Cases carrying one of the tokens as case_number or case_number_full — by
 * EQUALITY (trimmed, case-insensitive). Keyed by the lowercased token; a value
 * is every case carrying it (dockets are not unique by constraint).
 */
async function _casesByNumbers(db, tokens) {
  const out = new Map();
  if (!tokens.length) return out;
  const [rows] = await db.query(
    `SELECT ${CASE_COLS} FROM cases ca WHERE ca.case_number IN (?) OR ca.case_number_full IN (?)`,
    [tokens, tokens]);
  for (const t of tokens) {
    const k = _norm(t);
    const hits = rows.filter(r => _norm(r.case_number) === k || _norm(r.case_number_full) === k);
    if (hits.length) out.set(k, hits);
  }
  return out;
}

/** The ACTIVE owner of an address (uk_email_active: one at a time). */
async function senderContact(db, email) {
  const addr = String(email == null ? '' : email).trim().toLowerCase();
  if (!EMAIL_RE.test(addr)) return null;
  const [rows] = await db.query(
    `SELECT c.contact_id, c.contact_name, c.contact_lfm_name
       FROM contact_emails ce
       JOIN contacts c ON c.contact_id = ce.contact_id
      WHERE ce.email = ? AND ce.end_date IS NULL
      ORDER BY ce.contact_id ASC
      LIMIT 1`,
    [addr]
  );
  const r = rows[0];
  return r ? { contact_id: Number(r.contact_id), name: r.contact_name || null, lfm_name: r.contact_lfm_name || null } : null;
}

/** Every case the contact is a CLIENT on (Primary / Secondary), any stage. */
async function _clientCases(db, contactId) {
  const [rows] = await db.query(
    `SELECT cr.case_relate_type AS relation, ${CASE_COLS}
       FROM case_relate cr
       JOIN cases ca ON ca.case_id = cr.case_relate_case_id
      WHERE cr.case_relate_client_id = ? AND cr.case_relate_type IN (?)`,
    [contactId, [...CLIENT_RELATIONS]]
  );
  // One row per case even when the contact is related twice.
  const byId = new Map();
  for (const r of rows) if (!byId.has(r.case_id)) byId.set(r.case_id, r);
  return _rank([...byId.values()]);
}

// ─────────────────────────────────────────────────────────────────────────────
// The decision
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} db
 * @param {object} o
 * @param {string} o.fromEmail  the sender's bare address
 * @param {string} [o.subject]
 * @param {string} [o.text]     the message text (quoted history is cut here)
 * @returns {Promise<object>}   see SHAPE in the header
 */
async function matchCase(db, { fromEmail, subject, text } = {}) {
  const ids = extractCaseIds({ subject, text });
  const nums = extractCaseNumbers({ subject, text });
  const knownIds = await _casesByIds(db, [...new Set([...ids.subject, ...ids.body])]);
  const knownNums = await _casesByNumbers(db, [...nums.subject, ...nums.body]);
  // Each named case once, its id naming before its number naming.
  const named = (idToks, numToks) => {
    const out = [];
    const add = (row, via, token) => { if (!out.some(n => n.row.case_id === row.case_id)) out.push({ row, via, token }); };
    for (const t of idToks) if (knownIds.has(t)) add(knownIds.get(t), 'id', t);
    for (const t of numToks) for (const row of knownNums.get(_norm(t)) || []) add(row, 'number', t);
    return out;
  };
  const inSubject = named(ids.subject, nums.subject);
  const inBody = named(ids.body, nums.body);
  const typedNamed = inSubject.length ? inSubject : inBody;
  const typed = typedNamed.map(n => n.row);
  const where = inSubject.length ? 'subject' : 'body';
  const typedMethod = typedNamed.length ? `case_${typedNamed[0].via === 'id' ? 'id' : 'number'}_in_${where}` : null;

  const contact = await senderContact(db, fromEmail);
  const all = contact ? await _clientCases(db, contact.contact_id) : [];
  const open = all.filter(r => OPEN_STAGES.includes(r.case_stage));

  const base = {
    contact,
    ids_found: [...inSubject, ...inBody].map(n => n.row.case_id).filter((v, i, a) => a.indexOf(v) === i),
  };
  const hit = (row, method, reason) => ({
    ...base, case_id: row.case_id, method, flag: null, reason, candidates: [_cand(row, method.startsWith('case_') ? 'id' : 'sender')],
  });
  const miss = (flag, reason, cands) => ({
    ...base, case_id: null, method: null, flag, reason, candidates: _uniqueCands(cands),
  });

  // ── a typed id ──
  const typedIds = [...new Set(typed.map(r => r.case_id))];
  if (typedIds.length > 1) {
    return miss('multiple_case_ids',
      `The email names ${typedIds.length} different cases (${typedIds.join(', ')}).`,
      [...typed.map(r => _cand(r, 'id')), ...open.map(r => _cand(r, 'sender'))]);
  }
  if (typedIds.length === 1) {
    const e = typed[0];
    const n = typedNamed[0];
    const names = `The ${where === 'subject' ? 'subject' : 'message'} names ` +
      (n.via === 'id' ? `case ${e.case_id}` : `case number ${n.token} (case ${e.case_id})`);
    if (!open.length) {
      return hit(e, typedMethod, names + (contact ? ', and the sender has no other open case.' : '.'));
    }
    if (open.some(r => r.case_id === e.case_id)) {
      return hit(e, typedMethod, `${names}, one of the sender's open cases.`);
    }
    if (all.some(r => r.case_id === e.case_id)) {
      return hit(e, typedMethod, `${names}, one of the sender's cases (${e.case_stage || 'no stage'}).`);
    }
    return miss('conflict',
      `${names}, but the sender is a client on ` +
      `${open.length === 1 ? 'a different open case' : `${open.length} other open cases`} and not on that one.`,
      [_cand(e, 'id'), ...open.map(r => _cand(r, 'sender'))]);
  }

  // ── no typed id: the sender's open cases ──
  if (open.length === 1) {
    return hit(open[0], 'sender_open_case', `The sender's only open case is ${open[0].case_id}.`);
  }
  if (open.length > 1) {
    const retained = open.filter(r => r.pipeline_phase === 'case');
    if (retained.length === 1) {
      return hit(retained[0], 'sender_retained_case',
        `The sender has ${open.length} open cases; ${retained[0].case_id} is the only retained one.`);
    }
    return miss('multiple_open_cases',
      `The sender has ${open.length} open cases and the email does not say which.`,
      open.map(r => _cand(r, 'sender')));
  }
  if (contact) {
    return miss('no_open_case',
      all.length
        ? `The sender (${contact.name || 'a known contact'}) has no open case.`
        : `The sender (${contact.name || 'a known contact'}) is not a client on any case.`,
      all.map(r => _cand(r, 'sender')));
  }
  return miss('unknown_sender', 'The sender is not a contact in YisraCase, and the email names no case.', []);
}

module.exports = {
  matchCase,
  senderContact,
  extractCaseIds,
  extractCaseNumbers,
  ownText,
  OPEN_STAGES,
  CLIENT_RELATIONS,
  CANDIDATES_MAX,
  NEW_ID_RE,
};
