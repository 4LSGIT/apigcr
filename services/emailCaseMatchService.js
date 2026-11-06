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
 *   E = case ids the client typed: the subject first; the body (the sender's
 *       own text — quoted history cut off) only when the subject has none.
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
 *   |E| = 1, E ∉ S             → no match, flag 'conflict'  (unsorted + flag,
 *                                     ruling Q2 — never trust the id over a
 *                                     known client's own open cases)
 *   no id, |S| = 1             → S
 *   no id, |S| > 1             → the ONE retained case (pipeline_phase 'case')
 *                                if exactly one, else flag 'multiple_open_cases'
 *   no id, S empty             → flag 'no_open_case' (known contact; their
 *                                other cases are candidates) or
 *                                'unknown_sender'
 *
 * ── CASE IDS: NEW-STYLE ONLY (ruling 2026-11-06) ────────────────────────────
 * lib/caseId mints 8 uppercase Crockford Base32 characters, never all digits.
 * The 1,057 legacy mixed-case ids (base62, pre-Aug-2026) are NOT recognized:
 * old cases are rarer every month, and a bare 8-character mixed-case token is
 * far likelier to be an ordinary word or reference than a case id. Two forms:
 *   - "case <id>" (also "case: ", "case #", "case id ", "case no. ") — any
 *     letter case, subject or body (clients type "case pvxc1rmm");
 *   - a bare token — SUBJECT ONLY, uppercase only ("- PVXC1RMM").
 * Every token is checked against the database, and a hit counts only when the
 * STORED case_id is itself new-style: cases.case_id is utf8mb4_general_ci, so
 * "ABCD2345" would otherwise match a legacy "abcD2345".
 *
 * ── SHAPE ───────────────────────────────────────────────────────────────────
 * matchCase() → {
 *   case_id      string|null   the case to file under; null = unsorted
 *   method       'case_id_in_subject' | 'case_id_in_body' |
 *                'sender_open_case' | 'sender_retained_case' | null
 *   flag         null | 'conflict' | 'multiple_case_ids' |
 *                'multiple_open_cases' | 'no_open_case' | 'unknown_sender'
 *   reason       one plain sentence for the staff notice
 *   contact      {contact_id, name, lfm_name} | null — the sender
 *   candidates   [{case_id, case_number, case_type, case_stage, case_status,
 *                  pipeline_phase, from: 'id'|'sender'}]  (≤ CANDIDATES_MAX)
 *   ids_found    the typed ids that exist (canonical case_id)
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

/** Typed tokens looked up per message — a bound on one IN (...). */
const IDS_MAX = 10;

const CROCKFORD = '[0-9A-HJKMNP-TV-Z]';
/** A new-style case id, exactly (lib/caseId.js). */
const NEW_ID_RE = new RegExp(`^${CROCKFORD}{8}$`);
/** Bare uppercase token, word-bounded on alphanumerics. */
const BARE_RE = new RegExp(`(?:^|[^0-9A-Za-z])(${CROCKFORD}{8})(?=$|[^0-9A-Za-z])`, 'g');
/** "case <id>" in any letter case. The id class is checked after uppercasing. */
const PREFIXED_RE = /\bcase\s*(?:(?:id|no\.?|number|#)\s*)?[:#-]?\s*([0-9a-z]{8})(?![0-9a-z])/gi;

/**
 * Where the sender's own words end: the first quoted-history marker (the same
 * patterns the docs@ digest trims on) or the first ">"-quoted line. A marker
 * at offset 0 is ignored — that is a forward with no note, all of it quoted.
 */
const QUOTE_MARKERS = Object.freeze([
  /^\s*On .{4,200}\bwrote:\s*$/m,
  /^-{2,}\s*(?:Original|Forwarded) Message\s*-{2,}/im,
  /^From: .+\n(?:Sent|Date): /m,
  /^_{10,}\s*$/m,
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

function _push(out, tok) {
  const id = String(tok).toUpperCase();
  if (NEW_ID_RE.test(id) && /[A-Z]/.test(id) && !out.includes(id)) out.push(id);
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
  out.subject = out.subject.slice(0, IDS_MAX);
  out.body = out.body.slice(0, IDS_MAX);
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

/** Existing NEW-STYLE cases among the typed tokens, keyed by the uppercase token. */
async function _casesByIds(db, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const [rows] = await db.query(`SELECT ${CASE_COLS} FROM cases ca WHERE ca.case_id IN (?)`, [ids]);
  for (const r of rows) {
    const id = String(r.case_id);
    if (!NEW_ID_RE.test(id)) continue;          // a legacy id that matched case-insensitively
    out.set(id.toUpperCase(), r);
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
  const tokens = extractCaseIds({ subject, text });
  const known = await _casesByIds(db, [...new Set([...tokens.subject, ...tokens.body])]);
  const inSubject = tokens.subject.filter(t => known.has(t)).map(t => known.get(t));
  const inBody = tokens.body.filter(t => known.has(t)).map(t => known.get(t));
  const typed = inSubject.length ? inSubject : inBody;
  const typedMethod = inSubject.length ? 'case_id_in_subject' : 'case_id_in_body';

  const contact = await senderContact(db, fromEmail);
  const all = contact ? await _clientCases(db, contact.contact_id) : [];
  const open = all.filter(r => OPEN_STAGES.includes(r.case_stage));

  const base = {
    contact,
    ids_found: [...inSubject, ...inBody].map(r => r.case_id).filter((v, i, a) => a.indexOf(v) === i),
  };
  const hit = (row, method, reason) => ({
    ...base, case_id: row.case_id, method, flag: null, reason, candidates: [_cand(row, method.startsWith('case_id') ? 'id' : 'sender')],
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
    const where = typedMethod === 'case_id_in_subject' ? 'subject' : 'message';
    if (!open.length) {
      return hit(e, typedMethod, `The ${where} names case ${e.case_id}` +
        (contact ? ', and the sender has no other open case.' : '.'));
    }
    if (open.some(r => r.case_id === e.case_id)) {
      return hit(e, typedMethod, `The ${where} names case ${e.case_id}, one of the sender's open cases.`);
    }
    return miss('conflict',
      `The ${where} names case ${e.case_id}, but the sender is a client on ` +
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
  ownText,
  OPEN_STAGES,
  CLIENT_RELATIONS,
  CANDIDATES_MAX,
  NEW_ID_RE,
};
