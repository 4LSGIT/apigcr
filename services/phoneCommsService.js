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
// Reads
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Conversations on a line — one per other_party, texts AND calls (a number
 * that only ever called has one too; calls joined the list 2026-10-12, after
 * S-PH), newest activity first. `count` counts both. `last` is the newest
 * item, shaped by kind:
 *   {id, kind:'sms',  direction, snippet, at}
 *   {id, kind:'call', direction, at, duration_s, status, unanswered, missed}
 * COST: each page reads every row of the line through idx_phone_event_line
 * (forced) and groups them — live 2026-10-12 line 1: 6.6K rows, ~16 ms;
 * ref/plans.md has the threshold note.
 * @returns {{conversations:[{other_party, count, last_id, last, contact}], next_cursor}}
 */
async function listConversations(db, line, query = {}) {
  const limit = pageLimit(query.limit);
  let before = null;
  if (query.cursor !== undefined && query.cursor !== null && query.cursor !== '') {
    if (!CONVO_CURSOR_RE.test(String(query.cursor))) throw httpError(400, 'cursor is malformed — pass back next_cursor unchanged');
    before = Number(query.cursor);
  }
  const params = [line.phone_number];
  if (before != null) params.push(before);
  params.push(limit + 1);
  const [groups] = await db.query(
    `SELECT other_party, MAX(id) AS last_id, COUNT(*) AS n
       FROM phone_event_log FORCE INDEX (idx_phone_event_line)
      WHERE line_number = ? AND suppressed = 0 AND other_party IS NOT NULL
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
    const [rows] = await db.query(
      `SELECT id, event_type, direction, body, processed_at,
              JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.ts')) AS ts,
              JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.started_at')) AS started_at,
              JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.ended_at')) AS ended_at,
              JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.provider_status')) AS provider_status
         FROM phone_event_log
        WHERE id IN (?)`,
      [lastIds]
    );
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
        last: !r ? null : (r.event_type === 'call'
          ? { id: Number(r.id), kind: 'call', direction: r.direction, at: eventAt(r.started_at, r.processed_at), ...callFields(r) }
          : { id: Number(r.id), kind: 'sms', direction: r.direction, snippet: snippet(r.body), at: eventAt(r.ts, r.processed_at) }),
        contact: names.get(String(g.other_party)) || null,
      };
    }),
    next_cursor: groups.length > limit && page.length ? String(page[page.length - 1].last_id) : null,
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
 * the pane orders by `at`. The recordings arc hangs a call's recording /
 * transcript / summary on its call item (raw_extra.recording_id is on every
 * live call row).
 */
async function listMessages(db, line, party, query = {}) {
  if (!PARTY_RE.test(String(party || ''))) throw httpError(400, 'conversation must be a phone number (digits)');
  const limit = pageLimit(query.limit);
  const cursor = parseCursor(query.cursor);
  const params = [line.phone_number, String(party)];
  let keyset = '';
  if (cursor) {
    keyset = ' AND (processed_at < ? OR (processed_at = ? AND id < ?))';
    params.push(sqlUtc(cursor.at), sqlUtc(cursor.at), cursor.id);
  }
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
    messages: page.map(r => (r.event_type === 'call'
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
      })).reverse(),
    next_cursor: rows.length > limit && page.length ? cursorOf(page[page.length - 1]) : null,
  };
}

/** The call log of a line, newest first. */
async function listCalls(db, line, query = {}) {
  const limit = pageLimit(query.limit);
  const cursor = parseCursor(query.cursor);
  const params = [line.phone_number];
  let keyset = '';
  if (cursor) {
    keyset = ' AND (processed_at < ? OR (processed_at = ? AND id < ?))';
    params.push(sqlUtc(cursor.at), sqlUtc(cursor.at), cursor.id);
  }
  params.push(limit + 1);
  const [rows] = await db.query(
    `SELECT id, direction, other_party, processed_at, log_id,
            JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.started_at')) AS started_at,
            JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.ended_at')) AS ended_at,
            JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.provider_status')) AS provider_status
       FROM phone_event_log FORCE INDEX (idx_phone_event_line)
      WHERE line_number = ? AND event_type = 'call' AND suppressed = 0${keyset}
      ORDER BY processed_at DESC, id DESC
      LIMIT ?`,
    params
  );
  const page = rows.slice(0, limit);
  const names = await contactsFor(db, page.map(r => (r.other_party == null ? null : String(r.other_party))));
  return {
    calls: page.map(r => ({
      id: Number(r.id),
      direction: r.direction,
      other_party: r.other_party == null ? null : String(r.other_party),
      at: eventAt(r.started_at, r.processed_at),
      ...callFields(r),
      logged: r.log_id != null,
      contact: r.other_party == null ? null : (names.get(String(r.other_party)) || null),
    })),
    next_cursor: rows.length > limit && page.length ? cursorOf(page[page.length - 1]) : null,
  };
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
  sendSms,
  contactsFor,
  // helpers (routes + tests)
  normalizeTo,
  validateMessage,
  tenDigits,
  parseCursor,
  cursorOf,
  httpError,
  PAGE_DEFAULT,
  PAGE_MAX,
  SMS_MAX_CHARS,
  MISSED_STATUSES,
};
