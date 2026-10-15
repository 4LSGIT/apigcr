// services/phoneCommsService.js
//
/**
 * Phone comms — mailbox-system arc, slice S-PH (ref/MAILBOX_SYSTEM_DESIGN.md
 * §4.4 "Phone tab", D6 as amended 2026-10-11). The comms hub's Phone tab and
 * the grant seat for interactive SMS sends.
 *
 * READS phone_event_log — the complete phone store, BOTH providers, written
 * only by services/phoneIngestService.js (webhook-driven). Nothing here
 * writes it: an outbound SMS reaches it through the provider's webhook echo
 * (both providers echo outbound SMS), so the pane re-reads after a send.
 *
 * LINE ATTRIBUTION. An event belongs to the firm line on its firm side:
 * incoming → to_number, otherwise from_number — the generated column
 * phone_event_log.line_number (migration 2026-10-12_phone_sph.sql), indexed
 * (line_number, processed_at). Verified live 2026-10-12: equal to the
 * provider's own raw_extra.line on every row. Joined to phone_lines by plain
 * equality (both 10 digits). A number that is not a phone_lines row is an
 * ORPHAN — invisible here (976 live rows; registering the number as a line,
 * even inactive, makes its events readable). A line-to-line SMS is TWO rows
 * (one per line's webhook); each line shows its own — never de-duplicated.
 *
 * WHY line_number AND NOT THE BASE EXPRESSION. MySQL substitutes a generated
 * column for a matching expression only when the literal's collation matches
 * the definition's (measured on 8.0.46: the same IF(...) under a
 * utf8mb4_general_ci session did NOT use the index; under the definition's
 * collation it did). Naming the column is exact; the cost is ordering — this
 * file's reads need the migration first (house order: SQL first).
 *
 * PLANS. The per-line walks (conversations, the call log) FORCE
 * idx_phone_event_line — the mailbox list's lesson: left alone, the optimizer
 * walked idx_phone_event_processed_at backward once one line held most rows
 * (measured on the twin), reading every other line's rows on the way. One
 * conversation is NOT forced: idx_phone_event_other_party is the selective
 * key there and the optimizer takes it. tests/phoneSPH.mysql.test.js
 * EXPLAINs the exact statements this file issues.
 *
 * SUPPRESSED EVENTS (phone_event_log.suppressed = 1: spam / noise the
 * suppression layer kept off the log) are excluded from every read.
 *
 * ACCESS is resolved by the ROUTE through mailboxService (getAccess /
 * listReadable / listSendable — D6 enforcement seat); this service takes an
 * already-authorized line. The one exception is staffSendGate, the grant
 * check the /internal SMS/MMS routes run for staff-JWT callers, kept here so
 * both send seats share one rule.
 *
 * PAGINATION (the mailbox list idiom, mailReadService): keyset, limit+1,
 * next_cursor from the last row shown. Messages and calls: "<epoch ms>.<id>"
 * on (processed_at, id) — processed_at is NOT NULL, so no NULL tail.
 * Conversations: "<last id>" (a conversation's newest row id; ids follow
 * ingest order, so MAX(id) orders conversations by latest activity and is
 * unique across them).
 *
 * TIMES. processed_at is the ingest instant (UTC, the pool's timezone) and is
 * what ordering and cursors use. Each row also carries the provider's own
 * instant where it has one — raw_extra.ts (SMS) / started_at + ended_at
 * (calls) — and `at` prefers it (live: every SMS has ts, every call
 * started_at). An SMS lands seconds after its ts; a call is ingested when it
 * ENDS (live 2026-10-12: 2–190 s after ended_at), so its processed_at trails
 * its `at` by the call's length. A conversation mixes both (listMessages):
 * the page boundary is processed_at, the PANE orders what it holds by `at`.
 */

'use strict';

const mbx = require('./mailboxService');
const phoneService = require('./phoneService');
const { utcToLocal } = require('./timezoneService');
const { escapeLike } = require('../lib/escapeLike');

const PAGE_DEFAULT = 50;
const PAGE_MAX = 100;
// RingCentral's documented SMS body limit (lib/internal_functions/forwarding.js
// clamps to the same number; nothing below this file clamps).
const SMS_MAX_CHARS = 1000;
const SNIPPET_CHARS = 140;

const CURSOR_RE = /^(\d{1,15})\.(\d{1,19})$/;
const CONVO_CURSOR_RE = /^\d{1,19}$/;
// other_party as stored (live: 10 digits, 5-6 digit shortcodes, one 12-digit
// international) — digits only.
const PARTY_RE = /^\d{3,15}$/;
// Call outcomes that mean nobody picked up — `unanswered`; on an INCOMING
// call that is `missed` (live: Quo 'no-answer'; RingCentral reports only
// 'Accepted' / 'Call connected' / '', so an unanswered RingCentral call
// reads as answered — no signal to go on).
const MISSED_STATUSES = new Set(['no-answer', 'missed']);

function httpError(status, message, extra) {
  const err = new Error(message);
  err.status = status;
  if (extra) Object.assign(err, extra);
  return err;
}

function toId(v, label) {
  const s = String(v == null ? '' : v).trim();
  if (!/^\d+$/.test(s) || Number(s) <= 0 || !Number.isSafeInteger(Number(s))) {
    throw httpError(400, `${label} must be a positive integer`);
  }
  return Number(s);
}

function pageLimit(v) {
  if (v === undefined || v === null || v === '') return PAGE_DEFAULT;
  const n = toId(v, 'limit');
  return n > PAGE_MAX ? PAGE_MAX : n;
}

/** "<epoch ms>.<id>" → {at: Date, id} | null. */
function parseCursor(v) {
  if (v === undefined || v === null || v === '') return null;
  const m = CURSOR_RE.exec(String(v));
  const bad = () => httpError(400, 'cursor is malformed — pass back next_cursor unchanged');
  if (!m) throw bad();
  const id = Number(m[2]);
  const at = new Date(Number(m[1]));
  if (!Number.isSafeInteger(id) || id <= 0 || Number.isNaN(at.getTime())) throw bad();
  return { at, id };
}

function toDate(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(typeof v === 'string' && !/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? `${v.replace(' ', 'T')}Z` : v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A DATETIME param in UTC, independent of the pool's timezone option. */
function sqlUtc(d) {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function cursorOf(row) {
  return `${toDate(row.processed_at).getTime()}.${row.id}`;
}

/** A JSON_EXTRACT/UNQUOTE'd provider field: JSON null / '' → null. */
function jsonText(v) {
  if (v == null) return null;
  const s = String(v);
  return s === '' || s === 'null' ? null : s;
}

/** ISO instant of the provider's own time, else processed_at. */
function eventAt(providerIso, processedAt) {
  const p = toDate(jsonText(providerIso));
  const d = p || toDate(processedAt);
  return d ? d.toISOString() : null;
}

/** 10-digit NANP from a typed number, or null. Formatting is stripped; a leading 1 dropped. */
function tenDigits(raw) {
  const digits = String(raw == null ? '' : raw).replace(/[\s().+-]/g, '');
  if (!/^\d+$/.test(digits)) return null;
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  return /^\d{10}$/.test(ten) ? ten : null;
}

/**
 * The SMS recipient (S-PH send route). STRICTER than
 * phoneService.normalizeE164, which passes any '+…' through unchanged: a
 * staff send goes to a US 10-digit number (optionally +1 / 1 / formatted).
 * Shortcodes and international numbers are refused with a 400.
 */
function normalizeTo(raw) {
  const ten = tenDigits(raw);
  if (!ten) throw httpError(400, 'to must be a US phone number — 10 digits, optionally with +1 / 1');
  return { ten, e164: `+1${ten}` };
}

function validateMessage(raw) {
  if (typeof raw !== 'string') throw httpError(400, 'message must be text');
  const message = raw.trim();
  if (!message) throw httpError(400, 'message is empty');
  if (message.length > SMS_MAX_CHARS) {
    throw httpError(400, `message is ${message.length} characters — the limit is ${SMS_MAX_CHARS}`);
  }
  return message;
}

/**
 * The call half of a row — the call log and a conversation's call items share
 * it. Duration from the provider's started_at / ended_at (null when either is
 * missing or they run backwards).
 */
function callFields(r) {
  const start = toDate(jsonText(r.started_at));
  const end = toDate(jsonText(r.ended_at));
  const status = jsonText(r.provider_status);
  const dur = start && end ? Math.round((end.getTime() - start.getTime()) / 1000) : null;
  const unanswered = status != null && MISSED_STATUSES.has(status.toLowerCase());
  return {
    duration_s: dur != null && dur >= 0 ? dur : null,
    status,
    unanswered,
    missed: r.direction === 'incoming' && unanswered,
  };
}

function snippet(body) {
  if (body == null) return '';
  const s = String(body).replace(/\s+/g, ' ').trim();
  return s.length > SNIPPET_CHARS ? `${s.slice(0, SNIPPET_CHARS - 1)}…` : s;
}


// ─────────────────────────────────────────────────────────────────────────────
// Lines + access
// ─────────────────────────────────────────────────────────────────────────────

const LINE_SELECT = 'SELECT id, phone_number, display_name, provider, active, mms_capable FROM phone_lines';

function shapeLine(r) {
  return {
    id: Number(r.id),
    phone_number: r.phone_number,
    display_name: r.display_name ?? null,
    provider: r.provider,
    active: !!Number(r.active),
    mms_capable: !!Number(r.mms_capable),
  };
}

/** One phone_lines row (public projection — never credential/provider ids), or null. */
async function loadLine(db, lineId) {
  const id = toId(lineId, 'phone line id');
  const [[row]] = await db.query(`${LINE_SELECT} WHERE id = ? LIMIT 1`, [id]);
  return row ? shapeLine(row) : null;
}

/**
 * The read seat for one line: {line, access} or a status-bearing error.
 *   no access at all → 404 (no existence oracle — the mailbox rule);
 *   a grant without read → 403; a missing line → 404 for everyone (the SU
 *   and attorney bypasses answer for any id, so existence is checked here).
 */
async function resolveRead(db, userId, lineId) {
  const id = toId(lineId, 'phone line id');
  const access = await mbx.getAccess(db, userId, 'phone_line', id);
  if (!access.can_read) {
    if (!access.can_send && !access.can_manage) throw httpError(404, 'Phone line not found');
    throw httpError(403, 'Read permission required on this phone line');
  }
  const line = await loadLine(db, id);
  if (!line) throw httpError(404, 'Phone line not found');
  return { line, access };
}

/**
 * The grant check the /internal SMS/MMS routes run for STAFF-JWT callers
 * (S-PH ruling 1, 2026-10-12). API-key callers (automations, the internal
 * key) never come here — D6. `from` is the line's number as the pickers send
 * it (any formatting; resolved to 10 digits like phoneService.resolveLine).
 * Returns {ok:true, line} or {ok:false, status, message}.
 */
async function staffSendGate(db, userId, from) {
  const ten = tenDigits(from);
  if (!ten) return { ok: false, status: 400, message: `from must be one of the firm's phone lines (got ${String(from).slice(0, 20)})` };
  const [[row]] = await db.query(`${LINE_SELECT} WHERE phone_number = ? LIMIT 1`, [ten]);
  if (!row) return { ok: false, status: 400, message: `No phone line is set up for ${ten}` };
  const access = await mbx.getAccess(db, userId, 'phone_line', row.id);
  if (!access.can_send) {
    return {
      ok: false, status: 403,
      message: `You don't have send permission on the ${row.display_name || ten} line — ask whoever manages it (or IT) to grant it`,
    };
  }
  return { ok: true, line: shapeLine(row) };
}


// ─────────────────────────────────────────────────────────────────────────────
// Contact names
// ─────────────────────────────────────────────────────────────────────────────

/**
 * phone → {contact_id, name} for the 10-digit numbers given, through the
 * ACTIVE owner of each number (contact_phones.phone_active_uniq — unique, so
 * at most one contact per number; the uk_phone_active probe). Display only.
 */
async function contactsFor(db, phones) {
  const list = [...new Set((phones || []).filter(p => typeof p === 'string' && /^\d{10}$/.test(p)))];
  const out = new Map();
  if (!list.length) return out;
  const [rows] = await db.query(
    `SELECT cp.phone, c.contact_id, c.contact_name
       FROM contact_phones cp
       JOIN contacts c ON c.contact_id = cp.contact_id
      WHERE cp.phone_active_uniq IN (?)`,
    [list]
  );
  for (const r of rows) out.set(String(r.phone), { contact_id: Number(r.contact_id), name: r.contact_name || null });
  return out;
}


// ─────────────────────────────────────────────────────────────────────────────
// Item shapes — one per kind, shared by the per-line reads and All numbers
// ─────────────────────────────────────────────────────────────────────────────

const LATEST_SQL =
  `SELECT id, event_type, direction, body, processed_at, line_number,
          JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.ts')) AS ts,
          JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.started_at')) AS started_at,
          JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.ended_at')) AS ended_at,
          JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.provider_status')) AS provider_status
     FROM phone_event_log
    WHERE id IN (?)`;

/** A conversation's newest item, for the list row. */
function lastItem(r) {
  return r.event_type === 'call'
    ? { id: Number(r.id), kind: 'call', direction: r.direction, at: eventAt(r.started_at, r.processed_at), ...callFields(r) }
    : { id: Number(r.id), kind: 'sms', direction: r.direction, snippet: snippet(r.body), at: eventAt(r.ts, r.processed_at) };
}

/** One item of a conversation thread. */
function threadItem(r) {
  return r.event_type === 'call'
    ? {
      id: Number(r.id),
      kind: 'call',
      direction: r.direction,
      at: eventAt(r.started_at, r.processed_at),
      logged: r.log_id != null,
      ...callFields(r),
    }
    : {
      id: Number(r.id),
      kind: 'sms',
      direction: r.direction,
      body: r.body == null ? '' : String(r.body),
      at: eventAt(r.ts, r.processed_at),
      logged: r.log_id != null,
    };
}

/** One row of a call log. */
function callLogItem(r, names) {
  return {
    id: Number(r.id),
    direction: r.direction,
    other_party: r.other_party == null ? null : String(r.other_party),
    at: eventAt(r.started_at, r.processed_at),
    ...callFields(r),
    logged: r.log_id != null,
    contact: r.other_party == null ? null : (names.get(String(r.other_party)) || null),
  };
}



// ─────────────────────────────────────────────────────────────────────────────
// Search — ?q= on the four list reads (conversations / calls, per line and All)
// ─────────────────────────────────────────────────────────────────────────────
//
// Mailbox arc slice PS (Fred, 2026-10-14). One box, four matchers, UNIONED —
// never a guess at which one the user meant (a docket like 24-41234 is
// digit-shaped too):
//   number  — every non-digit stripped; a leading country 1 dropped when the
//             input began with +1 or is 11 digits starting with 1; ≥3 digits
//             → other_party LIKE '%<digits>%' (other_party is digits only).
//   contact — contacts.contact_name LIKE (escaped) → that contact's ACTIVE
//             numbers (phone_active_uniq, the contactsFor key). ≥2 chars.
//   case    — case_number / case_number_full / case_caption LIKE (escaped,
//             OPAQUE — docket shape is never parsed server-side) → the case's
//             Primary + Secondary clients → their active numbers. ≥2 chars.
//             The phone log carries no case link, so cases reach it only
//             through contacts.
//   ref     — the bubble's reference number (Fred, 2026-10-15): exactly
//             phone_event_log.id = n. "#<digits>" ("# 123" too) is a ref ONLY
//             (no other matcher runs); bare digits are a number AND a ref.
//             One PK lookup (REF_MATCH_SQL), held to the read: the lines being
//             read, unsuppressed, and an item the list can hold — a list of
//             conversations needs an other party (not a firm line in All
//             numbers; a text under ?kind=sms), a call log needs a call. A
//             conversation list then shows that event's conversation (its
//             other party joins the name matchers' numbers); a call log shows
//             that one call row (`id = ?`). A match puts `search.ref` = {id,
//             kind, other_party, line_id} on the answer so the pane can jump to
//             the bubble; anything else (another line, suppressed, no such id,
//             outside the list) gives no `ref` and no other difference.
// The name matchers resolve to a number list, pruned to numbers with an
// unsuppressed event on the lines being read (so the cap counts numbers that
// can show) and capped at SEARCH_PARTY_CAP each; a capped matcher is named in
// `search.capped` and the pane says so. The list read then adds ONE predicate
// (SEARCH_SQL) before its GROUP BY / keyset — paging and order are unchanged.
// Scope never widens: the matchers only pick numbers (or the one ref id);
// which lines are read is the route's (resolveRead) or readableScope's, as
// without q.
// COST: live 2026-10-14 every search statement 9–42 ms; the slowest is the
// merged call log with a rare match (walks idx_phone_event_processed_at to
// the end) — ref/plans.md "Phone search query cost" has the threshold note.
// The ref matcher adds one PRIMARY-key lookup (a const read); a ref-only call
// log read is that same rare-match walk.

const SEARCH_MAX_CHARS = 100;
const SEARCH_PARTY_CAP = 200;
// The number matcher's LIKE, else NULL (matches nothing); the name matchers'
// numbers (+ a ref's other party on a conversation list), else [NULL]
// (matches nothing); a ref's id on a call log, else NULL (matches nothing) —
// one statement shape for every mix.
const SEARCH_SQL = ' AND (other_party LIKE ? OR other_party IN (?) OR id = ?)';
// "#123" / "# 123" → a ref only; bare digits → a number and a ref. An id past
// the column (int unsigned) can be no event: a "#…" one matches nothing, a
// bare one is left to the number matcher.
const REF_ONLY_RE = /^#\s*(\d+)$/;
const REF_BARE_RE = /^\d+$/;
const REF_MAX = 4294967295;
const REF_MATCH_SQL =
  `SELECT e.id, e.event_type, e.other_party, e.line_number,
          EXISTS (SELECT 1 FROM phone_lines pl WHERE pl.phone_number = e.other_party) AS firm_party
     FROM phone_event_log e
    WHERE e.id = ? AND e.line_number IN (?) AND e.suppressed = 0`;
const IN_LINES_LOGGED =
  'EXISTS (SELECT 1 FROM phone_event_log e WHERE e.other_party = cp.phone_active_uniq AND e.line_number IN (?) AND e.suppressed = 0)';
const CONTACT_MATCH_SQL =
  `SELECT cp.phone_active_uniq AS phone
     FROM contacts c
     JOIN contact_phones cp ON cp.contact_id = c.contact_id
    WHERE c.contact_name LIKE ? AND cp.phone_active_uniq IS NOT NULL
      AND ${IN_LINES_LOGGED}
    ORDER BY c.contact_id DESC, cp.phone_active_uniq
    LIMIT ?`;
const CASE_MATCH_SQL =
  `SELECT DISTINCT cp.phone_active_uniq AS phone, cs.case_id, cs.case_number, cs.case_number_full, cs.case_caption
     FROM cases cs
     JOIN case_relate cr ON cr.case_relate_case_id = cs.case_id
     JOIN contact_phones cp ON cp.contact_id = cr.case_relate_client_id
    WHERE (cs.case_number LIKE ? OR cs.case_number_full LIKE ? OR cs.case_caption LIKE ?)
      AND cr.case_relate_type IN ('Primary', 'Secondary')
      AND cp.phone_active_uniq IS NOT NULL
      AND ${IN_LINES_LOGGED}
    ORDER BY cs.case_id DESC, cp.phone_active_uniq
    LIMIT ?`;

/** ?q= → trimmed text ('' = no search); a 400 when it is not one short string. */
function searchText(query) {
  const v = query.q;
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw httpError(400, 'q must be one piece of text');
  const q = v.trim();
  if (q.length > SEARCH_MAX_CHARS) throw httpError(400, `q is ${q.length} characters — the limit is ${SEARCH_MAX_CHARS}`);
  return q;
}

/** The number matcher's digits, or null (fewer than 3). */
function searchDigits(q) {
  let d = String(q).replace(/\D/g, '');
  if (/^\+\s*1/.test(String(q).trim()) || (d.length === 11 && d.startsWith('1'))) d = d.slice(1);
  return d.length >= 3 ? d : null;
}

/** ?q='s ref: {only, id} — `id` null when the digits can be no event; null when q is no ref. */
function searchRef(q) {
  const m = REF_ONLY_RE.exec(String(q));
  const digits = m ? m[1] : (REF_BARE_RE.test(String(q)) ? String(q) : null);
  if (digits == null) return null;
  const n = Number(digits);
  return { only: !!m, id: n >= 1 && n <= REF_MAX ? n : null };
}

/**
 * The ref matcher: the event `id` when the read can show it, else null.
 * `read` = {list: 'conversations'|'calls', kind ('' | the ?kind= clause),
 * all (All numbers: firm-line parties are not listed), lineIdOf(number)}.
 */
async function refOf(db, id, lineNumbers, read) {
  const [rows] = await db.query(REF_MATCH_SQL, [id, lineNumbers]);
  const r = rows[0];
  if (!r) return null;
  const party = r.other_party == null ? null : String(r.other_party);
  if (read.list === 'calls') {
    if (r.event_type !== 'call') return null;
  } else if (party == null || (read.kind && r.event_type !== 'sms') || (read.all && Number(r.firm_party))) {
    return null;
  }
  return { id: Number(r.id), kind: r.event_type, other_party: party, line_id: read.lineIdOf(String(r.line_number)) };
}

/**
 * Resolve ?q= against the lines being read (`lineNumbers`) for one list read
 * (`read`, see refOf). null = no search. Otherwise {q, digits, contact:Set,
 * cases:Map(phone → [{case_id, number, caption}]), ref, list, capped:[],
 * too_short, none} — `none` when no matcher can match (the caller answers
 * empty without reading the log).
 */
async function searchOf(db, q, lineNumbers, read) {
  if (!q) return null;
  const ref = searchRef(q);
  const s = { q, digits: ref && ref.only ? null : searchDigits(q), contact: new Set(), cases: new Map(), ref: null, list: read.list, capped: [], too_short: false, none: false };
  if (ref && ref.id != null && lineNumbers.length) s.ref = await refOf(db, ref.id, lineNumbers, read);
  if (ref && ref.only) {
    // a ref and nothing else
  } else if (q.length >= 2 && lineNumbers.length) {
    const like = `%${escapeLike(q)}%`;
    const [people] = await db.query(CONTACT_MATCH_SQL, [like, lineNumbers, SEARCH_PARTY_CAP + 1]);
    if (people.length > SEARCH_PARTY_CAP) s.capped.push('contact');
    for (const r of people.slice(0, SEARCH_PARTY_CAP)) s.contact.add(String(r.phone));
    const [hits] = await db.query(CASE_MATCH_SQL, [like, like, like, lineNumbers, SEARCH_PARTY_CAP + 1]);
    if (hits.length > SEARCH_PARTY_CAP) s.capped.push('case');
    for (const r of hits.slice(0, SEARCH_PARTY_CAP)) {
      const list = s.cases.get(String(r.phone)) || [];
      list.push({ case_id: String(r.case_id), number: r.case_number_full || r.case_number || null, caption: r.case_caption || null });
      s.cases.set(String(r.phone), list);
    }
  } else if (!s.digits && !ref) {
    s.too_short = q.length < 2;
  }
  s.none = !s.digits && !s.contact.size && !s.cases.size && !s.ref;
  return s;
}

/** SEARCH_SQL's text + params (appended to `params`), '' without a search. */
function searchClause(s, params) {
  if (!s) return '';
  const byId = s.ref && s.list === 'calls';
  const parties = [...new Set([...s.contact, ...s.cases.keys(), ...(s.ref && !byId ? [s.ref.other_party] : [])])];
  params.push(s.digits ? `%${s.digits}%` : null, parties.length ? parties : [null], byId ? s.ref.id : null);
  return SEARCH_SQL;
}

/** A row's `matched_by` (+ `matched_cases` on a case hit); nothing without a search. `id` = the call-log row's. */
function matchOf(s, party, id = null) {
  if (!s) return {};
  const refHit = !!s.ref && (s.list === 'calls' ? id != null && Number(id) === s.ref.id : party != null && String(party) === s.ref.other_party);
  if (party == null) return refHit ? { matched_by: ['ref'] } : {};
  const p = String(party);
  const by = [];
  if (s.digits && p.includes(s.digits)) by.push('number');
  if (s.contact.has(p)) by.push('contact');
  if (s.cases.has(p)) by.push('case');
  if (refHit) by.push('ref');
  return by.includes('case') ? { matched_by: by, matched_cases: s.cases.get(p) } : { matched_by: by };
}

/** The response's `search` block (+ `ref` when the ref matcher found an event the read shows); nothing without a search. */
const searchMeta = (s) => (s ? { search: { q: s.q, too_short: s.too_short, capped: s.capped, ...(s.ref ? { ref: s.ref } : {}) } } : {});

function convoCursor(query) {
  if (query.cursor === undefined || query.cursor === null || query.cursor === '') return null;
  if (!CONVO_CURSOR_RE.test(String(query.cursor))) throw httpError(400, 'cursor is malformed — pass back next_cursor unchanged');
  return Number(query.cursor);
}

/** ?kind= on the conversation lists: absent = texts AND calls; 'sms' = texts only (the pane's Texts view; MMS is event_type 'sms'). */
function convoKind(query) {
  if (query.kind === undefined || query.kind === null || query.kind === '') return '';
  if (query.kind === 'sms') return " AND event_type = 'sms'";
  throw httpError(400, "kind must be 'sms', or absent for texts and calls");
}

function keysetOf(query, params) {
  const cursor = parseCursor(query.cursor);
  if (!cursor) return '';
  params.push(sqlUtc(cursor.at), sqlUtc(cursor.at), cursor.id);
  return ' AND (processed_at < ? OR (processed_at = ? AND id < ?))';
}


// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Conversations on a line — one per other_party, texts AND calls (a number
 * that only ever called has one too; calls joined the list 2026-10-12, after
 * S-PH), newest activity first. `count` counts both. `last` is the newest
 * item, shaped by kind. ?kind=sms keeps texts only (a number that only
 * called has no row; `count` and `last` are its texts):
 *   {id, kind:'sms',  direction, snippet, at}
 *   {id, kind:'call', direction, at, duration_s, status, unanswered, missed}
 * COST: each page reads every row of the line through idx_phone_event_line
 * (forced) and groups them — live 2026-10-12 line 1: 6.6K rows, ~16 ms;
 * ref/plans.md has the threshold note.
 * @returns {{conversations:[{other_party, count, last_id, last, contact}], next_cursor}}
 */
async function listConversations(db, line, query = {}) {
  const limit = pageLimit(query.limit);
  const before = convoCursor(query);
  const kind = convoKind(query);
  const s = await searchOf(db, searchText(query), [line.phone_number], { list: 'conversations', kind, all: false, lineIdOf: () => Number(line.id) });
  if (s && s.none) return { conversations: [], next_cursor: null, ...searchMeta(s) };
  const params = [line.phone_number];
  const search = searchClause(s, params);
  if (before != null) params.push(before);
  params.push(limit + 1);
  const [groups] = await db.query(
    `SELECT other_party, MAX(id) AS last_id, COUNT(*) AS n
       FROM phone_event_log FORCE INDEX (idx_phone_event_line)
      WHERE line_number = ? AND suppressed = 0 AND other_party IS NOT NULL${search}${kind}
      GROUP BY other_party
     ${before != null ? 'HAVING MAX(id) < ?' : ''}
      ORDER BY last_id DESC
      LIMIT ?`,
    params
  );
  const page = groups.slice(0, limit);
  const lastIds = page.map(g => Number(g.last_id));
  const latest = new Map();
  if (lastIds.length) {
    const [rows] = await db.query(LATEST_SQL, [lastIds]);
    for (const r of rows) latest.set(Number(r.id), r);
  }
  const names = await contactsFor(db, page.map(g => String(g.other_party)));
  return {
    conversations: page.map((g) => {
      const r = latest.get(Number(g.last_id));
      return {
        other_party: String(g.other_party),
        count: Number(g.n),
        last_id: Number(g.last_id),
        last: r ? lastItem(r) : null,
        contact: names.get(String(g.other_party)) || null,
        ...matchOf(s, g.other_party),
      };
    }),
    next_cursor: groups.length > limit && page.length ? String(page[page.length - 1].last_id) : null,
    ...searchMeta(s),
  };
}

/**
 * One conversation — the line's texts AND calls with one number, interleaved
 * (calls joined the thread 2026-10-12, after S-PH): the NEWEST page (or the
 * page before `cursor`), returned OLDEST FIRST by processed_at for a chat
 * view; next_cursor reaches further back. Each item says what it is:
 *   {id, kind:'sms',  direction, body, at, logged}
 *   {id, kind:'call', direction, at, logged, duration_s, status, unanswered, missed}
 * A call's `at` is its START and it is ingested at its END (see TIMES), so
 * within a page a call can come after texts that were sent while it ran —
 * the pane orders by `at`. The comms archive hangs a call's recording /
 * voicemail / transcript / summary and a text's MMS files on the items AFTER
 * this returns — routes/api.phoneComms.js runs services/commsArchiveView.js
 * on the page (ref/COMMS_ARCHIVE_DESIGN.md §9 S4).
 */
async function listMessages(db, line, party, query = {}) {
  if (!PARTY_RE.test(String(party || ''))) throw httpError(400, 'conversation must be a phone number (digits)');
  const limit = pageLimit(query.limit);
  const params = [line.phone_number, String(party)];
  const keyset = keysetOf(query, params);
  params.push(limit + 1);
  const [rows] = await db.query(
    `SELECT id, event_type, direction, body, processed_at, log_id,
            JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.ts')) AS ts,
            JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.started_at')) AS started_at,
            JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.ended_at')) AS ended_at,
            JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.provider_status')) AS provider_status
       FROM phone_event_log
      WHERE line_number = ? AND other_party = ? AND suppressed = 0${keyset}
      ORDER BY processed_at DESC, id DESC
      LIMIT ?`,
    params
  );
  const page = rows.slice(0, limit);
  const names = await contactsFor(db, [String(party)]);
  return {
    other_party: String(party),
    contact: names.get(String(party)) || null,
    messages: page.map(threadItem).reverse(),
    next_cursor: rows.length > limit && page.length ? cursorOf(page[page.length - 1]) : null,
  };
}

/** The call log of a line, newest first. */
async function listCalls(db, line, query = {}) {
  const limit = pageLimit(query.limit);
  parseCursor(query.cursor); // a malformed cursor is a 400 before any search read
  const s = await searchOf(db, searchText(query), [line.phone_number], { list: 'calls', kind: '', all: false, lineIdOf: () => Number(line.id) });
  if (s && s.none) return { calls: [], next_cursor: null, ...searchMeta(s) };
  const params = [line.phone_number];
  const search = searchClause(s, params);
  const keyset = keysetOf(query, params);
  params.push(limit + 1);
  const [rows] = await db.query(
    `SELECT id, direction, other_party, processed_at, log_id,
            JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.started_at')) AS started_at,
            JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.ended_at')) AS ended_at,
            JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.provider_status')) AS provider_status
       FROM phone_event_log FORCE INDEX (idx_phone_event_line)
      WHERE line_number = ? AND event_type = 'call' AND suppressed = 0${search}${keyset}
      ORDER BY processed_at DESC, id DESC
      LIMIT ?`,
    params
  );
  const page = rows.slice(0, limit);
  const names = await contactsFor(db, page.map(r => (r.other_party == null ? null : String(r.other_party))));
  return {
    calls: page.map(r => ({ ...callLogItem(r, names), ...matchOf(s, r.other_party, r.id) })),
    next_cursor: rows.length > limit && page.length ? cursorOf(page[page.length - 1]) : null,
    ...searchMeta(s),
  };
}


// ─────────────────────────────────────────────────────────────────────────────
// All numbers — every line the caller can READ at once (Fred, 2026-10-12,
// option B: one row per OUTSIDE number, its thread merged across lines)
// ─────────────────────────────────────────────────────────────────────────────
//
// SCOPE is mailboxService.listReadable('phone_line') — SU and attorneys every
// line (inactive too), others their can_read grants; no readable line → empty
// answers, never an error. Every item carries `line_id` (which line it was
// on). The LIST leaves out numbers that are themselves firm lines (a text
// between two firm lines is TWO rows, one per line — merged it would show
// twice); those stay in each line's own view. The thread and the call log do
// not filter them: a firm line's thread opened from All shows both copies,
// each tagged with its line. Sending from All picks a line in the pane and
// posts to that line's POST /api/phone-lines/:id/sms — no new send path.
// COST: the list groups every row of every readable line on each page (live
// 2026-10-12, SU: ≈10.5K rows) — ref/plans.md has the threshold note.

/** The caller's readable lines: {numbers, idOf: Map(number → line id)}. */
async function readableScope(db, userId) {
  const lines = await mbx.listReadable(db, userId, 'phone_line');
  const idOf = new Map();
  for (const l of lines) if (l.phone_number) idOf.set(String(l.phone_number), Number(l.id));
  return { numbers: [...idOf.keys()], idOf };
}

const lineIdsOf = (csv, idOf) => [...new Set(String(csv || '').split(',').map(n => idOf.get(n)).filter(Boolean))].sort((a, b) => a - b);

/**
 * All-numbers conversations: one per OUTSIDE number across the readable
 * lines, newest activity first; `line_ids` = the lines it used; `last`
 * carries its `line_id`. Paged by MAX(id) like the per-line list; ?kind=sms
 * the same as the per-line list's.
 */
async function listAllConversations(db, userId, query = {}) {
  const limit = pageLimit(query.limit);
  const before = convoCursor(query);
  const kind = convoKind(query);
  const q = searchText(query);
  const { numbers, idOf } = await readableScope(db, userId);
  const s = await searchOf(db, q, numbers, { list: 'conversations', kind, all: true, lineIdOf: n => idOf.get(n) || null });
  if (!numbers.length || (s && s.none)) return { conversations: [], next_cursor: null, ...searchMeta(s) };
  const params = [numbers];
  const search = searchClause(s, params);
  if (before != null) params.push(before);
  params.push(limit + 1);
  const [groups] = await db.query(
    `SELECT other_party, MAX(id) AS last_id, COUNT(*) AS n,
            GROUP_CONCAT(DISTINCT line_number ORDER BY line_number SEPARATOR ',') AS line_numbers
       FROM phone_event_log e
      WHERE line_number IN (?) AND suppressed = 0 AND other_party IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM phone_lines pl WHERE pl.phone_number = e.other_party)${search}${kind}
      GROUP BY other_party
     ${before != null ? 'HAVING MAX(id) < ?' : ''}
      ORDER BY last_id DESC
      LIMIT ?`,
    params
  );
  const page = groups.slice(0, limit);
  const lastIds = page.map(g => Number(g.last_id));
  const latest = new Map();
  if (lastIds.length) {
    const [rows] = await db.query(LATEST_SQL, [lastIds]);
    for (const r of rows) latest.set(Number(r.id), r);
  }
  const names = await contactsFor(db, page.map(g => String(g.other_party)));
  return {
    conversations: page.map((g) => {
      const r = latest.get(Number(g.last_id));
      return {
        other_party: String(g.other_party),
        count: Number(g.n),
        last_id: Number(g.last_id),
        line_ids: lineIdsOf(g.line_numbers, idOf),
        last: r ? { ...lastItem(r), line_id: idOf.get(String(r.line_number)) || null } : null,
        contact: names.get(String(g.other_party)) || null,
        ...matchOf(s, g.other_party),
      };
    }),
    next_cursor: groups.length > limit && page.length ? String(page[page.length - 1].last_id) : null,
    ...searchMeta(s),
  };
}

/**
 * One number across the readable lines: its texts and calls on every line,
 * merged (same page / order / cursor contract as listMessages), each item
 * with its `line_id`; `line_ids` = every readable line it ever used.
 */
async function listAllMessages(db, userId, party, query = {}) {
  if (!PARTY_RE.test(String(party || ''))) throw httpError(400, 'conversation must be a phone number (digits)');
  const limit = pageLimit(query.limit);
  parseCursor(query.cursor); // a malformed cursor is a 400 even with nothing readable
  const { numbers, idOf } = await readableScope(db, userId);
  const names = await contactsFor(db, [String(party)]);
  const empty = { other_party: String(party), contact: names.get(String(party)) || null, line_ids: [], messages: [], next_cursor: null };
  if (!numbers.length) return empty;
  const params = [String(party), numbers];
  const keyset = keysetOf(query, params);
  params.push(limit + 1);
  const [rows] = await db.query(
    `SELECT id, event_type, direction, body, processed_at, log_id, line_number,
            JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.ts')) AS ts,
            JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.started_at')) AS started_at,
            JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.ended_at')) AS ended_at,
            JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.provider_status')) AS provider_status
       FROM phone_event_log
      WHERE other_party = ? AND line_number IN (?) AND suppressed = 0${keyset}
      ORDER BY processed_at DESC, id DESC
      LIMIT ?`,
    params
  );
  const [used] = await db.query(
    `SELECT DISTINCT line_number FROM phone_event_log
      WHERE other_party = ? AND line_number IN (?) AND suppressed = 0`,
    [String(party), numbers]
  );
  const page = rows.slice(0, limit);
  return {
    ...empty,
    line_ids: lineIdsOf(used.map(u => u.line_number).join(','), idOf),
    messages: page.map(r => ({ ...threadItem(r), line_id: idOf.get(String(r.line_number)) || null })).reverse(),
    next_cursor: rows.length > limit && page.length ? cursorOf(page[page.length - 1]) : null,
  };
}

/** Every readable line's call log, merged, newest first; each row with its `line_id`. */
async function listAllCalls(db, userId, query = {}) {
  const limit = pageLimit(query.limit);
  parseCursor(query.cursor); // a malformed cursor is a 400 even with nothing readable
  const q = searchText(query);
  const { numbers, idOf } = await readableScope(db, userId);
  const s = await searchOf(db, q, numbers, { list: 'calls', kind: '', all: true, lineIdOf: n => idOf.get(n) || null });
  if (!numbers.length || (s && s.none)) return { calls: [], next_cursor: null, ...searchMeta(s) };
  const params = [numbers];
  const search = searchClause(s, params);
  const keyset = keysetOf(query, params);
  params.push(limit + 1);
  const [rows] = await db.query(
    `SELECT id, direction, other_party, processed_at, log_id, line_number,
            JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.started_at')) AS started_at,
            JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.ended_at')) AS ended_at,
            JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.provider_status')) AS provider_status
       FROM phone_event_log
      WHERE line_number IN (?) AND event_type = 'call' AND suppressed = 0${search}${keyset}
      ORDER BY processed_at DESC, id DESC
      LIMIT ?`,
    params
  );
  const page = rows.slice(0, limit);
  const names = await contactsFor(db, page.map(r => (r.other_party == null ? null : String(r.other_party))));
  return {
    calls: page.map(r => ({ ...callLogItem(r, names), line_id: idOf.get(String(r.line_number)) || null, ...matchOf(s, r.other_party, r.id) })),
    next_cursor: rows.length > limit && page.length ? cursorOf(page[page.length - 1]) : null,
    ...searchMeta(s),
  };
}


/**
 * The firm-local day ('YYYY-MM-DD') of the earliest event (text or call, not
 * suppressed) with `party` on ANY line the caller can read — the "Add to
 * contact" dialog's start-date default (the phone twin of mailReadService
 * .firstSeen; scripts.js OrphanAdoptDialog takes the earlier of it and the
 * log's own earliest row). Day from processed_at: a call's ingest instant is
 * its end, at most minutes from its start. Null when there is none.
 * idx_phone_event_other_party narrows; line_number IN filters.
 */
async function firstSeen(db, userId, party) {
  if (!PARTY_RE.test(String(party || ''))) throw httpError(400, 'number must be a phone number (digits)');
  const lines = await mbx.listReadable(db, userId, 'phone_line');
  const numbers = lines.map(l => l.phone_number).filter(Boolean);
  if (!numbers.length) return { number: String(party), first_seen: null };
  const [[row]] = await db.query(
    `SELECT MIN(processed_at) AS first_at
       FROM phone_event_log
      WHERE other_party = ? AND line_number IN (?) AND suppressed = 0`,
    [String(party), numbers]
  );
  const d = toDate(row && row.first_at);
  return { number: String(party), first_seen: d ? utcToLocal(d).toISODate() : null };
}


// ─────────────────────────────────────────────────────────────────────────────
// Send
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send one text-only SMS from an AUTHORIZED line (the route checked
 * can_send). Text only — MMS is out of S-PH scope even on mms_capable lines.
 * No phone_event_log write (the provider's webhook echo records it); the
 * caller re-reads the conversation. phoneService stays grant-blind (D6).
 * Provider/adapter failures come back as a 502 whose message the sender sees.
 */
async function sendSms(db, line, body = {}) {
  if (!line.active) throw httpError(409, 'This phone line is inactive — it cannot send');
  const to = normalizeTo(body.to);
  const message = validateMessage(body.message);
  let result;
  try {
    result = await phoneService.sendSms(db, line.phone_number, to.e164, message);
  } catch (err) {
    throw httpError(502, `The message was not sent: ${err && err.message ? err.message : 'provider error'}`, { expose: true });
  }
  return { to: to.ten, length: message.length, result: result ?? null };
}


module.exports = {
  loadLine,
  resolveRead,
  staffSendGate,
  listConversations,
  listMessages,
  listCalls,
  listAllConversations,
  listAllMessages,
  listAllCalls,
  firstSeen,
  sendSms,
  contactsFor,
  // helpers (routes + tests)
  normalizeTo,
  validateMessage,
  tenDigits,
  searchDigits,
  searchRef,
  parseCursor,
  cursorOf,
  httpError,
  PAGE_DEFAULT,
  PAGE_MAX,
  SMS_MAX_CHARS,
  MISSED_STATUSES,
  SEARCH_MAX_CHARS,
  SEARCH_PARTY_CAP,
};
