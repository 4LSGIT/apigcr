// services/mailbox/mailReadService.js
//
/**
 * Mail read service — mailbox-system arc, slice S2 (comms hub, Email tab)
 * services/mailbox/mailReadService.js
 *
 *   summary(db, userId)                      readable mailboxes (+ colour) + INBOX unread/total counts
 *   related(db, userId, messageId)           contacts the conversation's outside addresses belong
 *                                            to, with their client cases (open the file from mail)
 *   listImageSenders / trustImageSender / untrustImageSender
 *                                            the caller's "always show images from" senders
 *   listMessages(db, userId, query)          the mixed-inbox list (keyset-paginated, NO bodies)
 *   getThread(db, userId, threadKey)         one thread, merged across readable mailboxes (bodies)
 *   getMessage(db, userId, id)               one message (bodies) — threadless mail
 *   setRead(db, userId, id, read)            per-user read state, idempotent
 *   markRead(db, userId, body)               bulk: {ids} or {all, mailbox_ids?, filters?}
 *   listViews / createView / updateView / deleteView   inbox_views, caller-owned
 *   caseLink(db, userId, id, body)           attach the message's log row to a case
 *
 * Spec: ref/MAILBOX_SYSTEM_DESIGN.md §4.3 (read state), §4.4 (hub), D6, OQ1
 * (answered: group by the stored thread_key). HTTP layer: routes/api.mail.js.
 * Errors carry an HTTP `.status` (mailboxService.httpError).
 *
 * ── ACCESS (D6) ──────────────────────────────────────────────────────────────
 * Every read is scoped by mailboxService — listReadable for set queries,
 * getAccess for one message — never by channel_grants directly. A message is
 * visible iff its mailbox is readable (grant ∪ SU ∪ the attorney READ bypass).
 * A message that exists but is not readable answers exactly like one that
 * does not exist (404) — no existence oracle on ids or thread keys. A saved
 * view NEVER grants: its mailbox_ids are intersected with the readable set at
 * read time, and rejected at write time when not readable.
 *
 * ── BODIES ───────────────────────────────────────────────────────────────────
 * body_html / body_text leave this module ONLY from getThread / getMessage —
 * never from the list. body_html is attacker-controlled mail; the client
 * renders it sanitized inside an empty-sandbox srcdoc iframe
 * (public/js/mailRender.js). Nothing here interprets it.
 *
 * ── READ STATE (§4.3) ────────────────────────────────────────────────────────
 * Per user in mail_read_state (row present = read). The server's \Seen is
 * never written. Writes are idempotent (INSERT … ON DUPLICATE KEY UPDATE /
 * DELETE no-op).
 *
 * ── THE LIST (keyset) ────────────────────────────────────────────────────────
 * One statement: a UNION ALL of one branch per mailbox in scope, each a
 * backward walk of idx_mail_messages_mailbox_date (mailbox_id, date [, id] —
 * InnoDB appends the PK; FORCE INDEX, see the branch) stopping at its own
 * LIMIT, merged and cut again. No
 * OFFSET: the cursor is the last row's (date, id). NULL dates (no Date header
 * AND no INTERNALDATE — the worker almost never stores one) sort last, as
 * they do in the index walked backwards. Default scope is the INBOX folder;
 * `all_folders` adds Sent etc. (the thread view always merges every folder).
 *
 * ── CASE LINK ────────────────────────────────────────────────────────────────
 * Reuses the about-link machinery (logService.setLogAbout, about_type 'case')
 * on the message's log row. A message with no stamped log_id first looks for
 * a log row that ALREADY carries this email: a copy's stamp, else any ingest
 * source's execution row keyed by the RFC Message-ID or by a provider id —
 * the Apps Script source (gmail-firm) logs Workspace mail under Gmail's id,
 * which the worker stores as provider_id, while that mailbox is store-only
 * (design §2: no cross-source dedupe exists anywhere else). Only when none
 * exists is a log row created, via logService.createLogEntry in the shape the
 * email pipeline writes (type/link 'email', the other party, From/To/Subject/
 * Message), dated when the mail was sent (never later than it was stored — a
 * Date header is sender-supplied) — the two-tier valve opening for one
 * message. Refused (409) while another writer may still log it: the ingest
 * worker's own emission (its stamp would lose the race and the pipeline's row
 * would orphan), or — for a store-only folder — STORE_ONLY_GRACE_MIN after
 * the worker stored it, the window in which another source (the ~5-min Apps
 * Script cadence) can still post the same email.
 *
 * NO MODULE-SCOPE STATE (design §2): every call reads the DB.
 */

'use strict';

const mbx = require('../mailboxService');
const logService = require('../logService');
const { inferDirection, firmDomains } = require('../emailIngestService');
const { emitText, folderConfig } = require('./mailboxIngestService');
const { escapeLike } = require('../../lib/escapeLike');
const { withTransaction } = require('../../lib/withTransaction');
const mailboxColor = require('../../public/js/mailboxColor');

const { httpError } = mbx;

const PAGE_DEFAULT = 50;
const PAGE_MAX = 100;
const THREAD_MAX = 100;
const BULK_READ_MAX = 500;
const VIEWS_MAX = 50;
const VIEW_IDS_MAX = 50;
const Q_MAX = 200;
const LOG_MESSAGE_SOFT_CAP = 50000; // emailIngestService._bodyForLog
const INBOX = 'INBOX';
// Case-link on a store-only folder waits this long after the worker stored the
// message: two ~5-min pollers (the worker, the Apps Script source) plus margin.
const STORE_ONLY_GRACE_MIN = 10;
const RELATED_ADDR_MAX = 50;             // outside addresses looked up per conversation
const RELATED_CASES_PER_CONTACT = 10;
const CLIENT_RELATIONS = Object.freeze(['Primary', 'Secondary']); // case_relate types that make a "client file"
const STAGE_RANK = Object.freeze({ Open: 0, Pending: 1, Filed: 2, Concluded: 3, Closed: 4 });

// The saved-view filter vocabulary (inbox_views.filters) = the list's query
// filters. Unknown keys are refused on write and ignored on read.
const FILTER_KEYS = Object.freeze({
  unread_only: 'bool',
  has_case: 'bool',
  all_folders: 'bool',
  from_domain: 'domain',
  q: 'text',
});

const DOMAIN_RE = /^(?=.{1,128}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const CASE_ID_RE = /^[A-Za-z0-9_-]{1,20}$/;
const CURSOR_RE = /^(\d{1,15}|n)\.(\d{1,19})$/;
const EMAIL_IN_RE = /[^\s<>,;:"()[\]\\]+@[^\s<>,;:"()[\]\\]+\.[^\s<>,;:"()[\]\\]+/g;


// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function has(obj, k) {
  return Object.prototype.hasOwnProperty.call(obj, k);
}

function parseJson(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return null; }
}

function toId(v, label) {
  const s = typeof v === 'number' ? String(v) : String(v == null ? '' : v).trim();
  if (!/^\d+$/.test(s) || Number(s) <= 0 || !Number.isSafeInteger(Number(s))) {
    throw httpError(400, `${label} must be a positive integer`);
  }
  return Number(s);
}

/** Query-string / JSON boolean: true/false/1/0/'true'/'false'/'1'/'0'/'' (false). */
function toFlag(v, label) {
  if (v === undefined || v === null || v === '' || v === false || v === 0 || v === '0' || v === 'false') return false;
  if (v === true || v === 1 || v === '1' || v === 'true') return true;
  throw httpError(400, `${label} must be true or false`);
}

/** Strict JSON boolean (views). */
function toBool(v, label) {
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  throw httpError(400, `${label} must be a boolean`);
}

function cleanDomain(v, label = 'from_domain') {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw httpError(400, `${label} must be a string`);
  const d = v.trim().replace(/^@/, '').toLowerCase();
  if (!d) return null;
  if (!DOMAIN_RE.test(d)) throw httpError(400, `${label} must be a domain like example.com`);
  return d;
}

function cleanQ(v, label = 'q') {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw httpError(400, `${label} must be a string`);
  const q = v.trim();
  if (!q) return null;
  if (q.length > Q_MAX) throw httpError(400, `${label} must be at most ${Q_MAX} characters`);
  return q;
}

/** "1,2,3" | [1,2,3] → unique positive ints (or null when absent/empty). */
function idList(v, label, max) {
  if (v === undefined || v === null || v === '') return null;
  const raw = Array.isArray(v) ? v : String(v).split(',');
  const out = [];
  for (const x of raw) {
    if (typeof x === 'string' && x.trim() === '') continue;
    const id = toId(x, label);
    if (!out.includes(id)) out.push(id);
  }
  if (out.length > max) throw httpError(400, `${label} allows at most ${max} ids`);
  return out;
}

/** Cursor = "<epoch ms>.<id>" or "n.<id>" (the NULL-date tail). */
function parseCursor(v) {
  if (v === undefined || v === null || v === '') return null;
  const m = CURSOR_RE.exec(String(v));
  if (!m) throw httpError(400, 'cursor is malformed — pass back next_cursor unchanged');
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) throw httpError(400, 'cursor is malformed — pass back next_cursor unchanged');
  if (m[1] === 'n') return { date: null, id };
  const d = new Date(Number(m[1]));
  if (Number.isNaN(d.getTime())) throw httpError(400, 'cursor is malformed — pass back next_cursor unchanged');
  return { date: d, id };
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
  const d = toDate(row.date);
  return `${d ? d.getTime() : 'n'}.${row.id}`;
}

/** Display-form address list → bare lowercase emails, in order. */
function emailsIn(s) {
  if (!s) return [];
  return (String(s).match(EMAIL_IN_RE) || []).map(e => e.toLowerCase());
}

/**
 * The sender's bare address from a display From. The <angle> address wins:
 * a display name can itself look like an address ("x@y.com via List
 * <list@z.org>"), and the angle part is the one the mail was sent as.
 */
function senderOf(fromAddr) {
  if (!fromAddr) return null;
  const angle = /<([^<>]+)>\s*$/.exec(String(fromAddr));
  const inAngle = angle ? emailsIn(angle[1])[0] : null;
  return inAngle || emailsIn(fromAddr)[0] || null;
}

function attachmentParts(v) {
  const list = parseJson(v);
  if (!Array.isArray(list)) return [];
  return list.filter(a => a && a.part != null).map(a => ({
    part: String(a.part),
    filename: a.filename == null ? null : String(a.filename),
    size: a.size == null ? null : Number(a.size),
    mime: a.mime == null ? null : String(a.mime).toLowerCase(),
    cid: a.cid == null || a.cid === '' ? null : String(a.cid),
  }));
}

/*
 * INLINE vs ATTACHED. A part is INLINE — drawn inside the HTML body, not
 * listed as a file — only when it is an image that the body actually
 * references as `cid:<Content-ID>` (RFC 2392: the URL is the URL-encoded
 * Content-ID; mailRender.cidKey reads it the same way). Having a Content-ID
 * is NOT enough: Gmail gives EVERY attachment one (X-Attachment-Id), so the
 * old "has a cid = inline" rule hid every Gmail PDF from the list count and
 * the thread. The stored structure carries no disposition (and Apple Mail
 * marks plain PDFs `inline` anyway), so the body reference is the test.
 */
const CID_REF_RE = /cid:([^\s"'()<>]+)/gi;

/** Lowercased Content-IDs the HTML references as cid: URLs. */
function referencedCids(html) {
  const out = new Set();
  if (html == null || html === '') return out;
  for (const m of String(html).matchAll(CID_REF_RE)) {
    let k = m[1];
    try { k = decodeURIComponent(k); } catch (_) { /* keep it as written */ }
    out.add(k.replace(/^<|>$/g, '').toLowerCase());
  }
  return out;
}

/** attachmentParts() rows + `inline` (see INLINE vs ATTACHED). */
function markInline(parts, html) {
  const refs = parts.some(p => p.cid) ? referencedCids(html) : new Set();
  return parts.map(p => ({
    ...p,
    inline: !!(p.cid && p.mime && p.mime.startsWith('image/') && refs.has(p.cid.replace(/^<|>$/g, '').toLowerCase())),
  }));
}

function caseOf(r) {
  if (r.case_id == null) return null;
  return { case_id: r.case_id, case_number: r.case_number_full || r.case_number || null };
}

/** Readable mailboxes as Map(id → row). */
async function readableScope(db, userId) {
  const rows = await mbx.listReadable(db, userId, 'mailbox');
  return new Map(rows.map(r => [Number(r.id), r]));
}


// ─────────────────────────────────────────────────────────────────────────────
// Shared SQL
// ─────────────────────────────────────────────────────────────────────────────

// unread / case come from the caller's read state and the log row's
// about-link. The about-link join copies logService.getLogEntry's (gated on
// log_about_type in ON, PK probes).
const JOINS = `
  LEFT JOIN mail_read_state rs ON rs.user = ? AND rs.message_fk = m.id
  LEFT JOIN log l ON l.log_id = m.log_id
  LEFT JOIN cases c ON l.log_about_type = 'case' AND c.case_id = l.log_about_id`;

// NEVER add body_text / body_html here: this is the list projection.
const LIST_COLS = `m.id, m.mailbox_id, m.folder, m.thread_key, m.from_addr, m.to_addrs, m.cc_addrs,
  m.subject, m.date, m.snippet, m.attachments, m.log_id,
  (rs.message_fk IS NULL) AS unread,
  c.case_id AS case_id, c.case_number AS case_number, c.case_number_full AS case_number_full`;

const FULL_COLS = `m.id, m.mailbox_id, m.folder, m.message_id, m.in_reply_to, m.thread_key,
  m.from_addr, m.to_addrs, m.cc_addrs, m.subject, m.date, m.snippet, m.body_text, m.body_html,
  m.attachments, m.flags, m.log_id,
  (rs.message_fk IS NULL) AS unread,
  c.case_id AS case_id, c.case_number AS case_number, c.case_number_full AS case_number_full`;


// ─────────────────────────────────────────────────────────────────────────────
// Summary (view switcher)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Readable mailboxes with the caller's INBOX counts — one grouped query, not
 * one per mailbox. Unread counts the INBOX only: the hub's default scope, and
 * a Sent copy is mail the mailbox itself sent.
 */
async function summary(db, userId) {
  const scope = await readableScope(db, userId);
  const ids = [...scope.keys()];
  const counts = new Map();
  if (ids.length) {
    const [rows] = await db.query(
      `SELECT m.mailbox_id, COUNT(*) AS total, SUM(rs.message_fk IS NULL) AS unread
         FROM mail_messages m
         LEFT JOIN mail_read_state rs ON rs.user = ? AND rs.message_fk = m.id
        WHERE m.mailbox_id IN (?) AND m.folder = ?
        GROUP BY m.mailbox_id`,
      [Number(userId), ids, INBOX]
    );
    for (const r of rows) counts.set(Number(r.mailbox_id), { total: Number(r.total) || 0, unread: Number(r.unread) || 0 });
  }
  const viewer = { su: await mbx.isSuperuser(db, userId), role: null };
  const mailboxes = [...scope.values()].map(r => {
    if (r.role) viewer.role = r.role;
    const c = counts.get(Number(r.id)) || { total: 0, unread: 0 };
    return {
      id: Number(r.id),
      address: r.address,
      display_name: r.display_name || null,
      color: mailboxColor.normalize(r.color), // stored '#rrggbb' (null = none chosen)
      active: !!r.active,
      can_send: !!r.can_send,
      can_manage: !!r.can_manage,
      inbox_total: c.total,
      inbox_unread: c.unread,
    };
  });
  return { viewer, mailboxes };
}


// ─────────────────────────────────────────────────────────────────────────────
// List
// ─────────────────────────────────────────────────────────────────────────────

/** Normalized filters from a query/view object. Unknown keys are ignored here. */
function readFilters(src, { strict } = { strict: false }) {
  const f = {};
  if (!src || typeof src !== 'object') return f;
  if (has(src, 'unread_only')) f.unread_only = strict ? toBool(src.unread_only, 'unread_only') : toFlag(src.unread_only, 'unread_only');
  if (has(src, 'has_case')) f.has_case = strict ? toBool(src.has_case, 'has_case') : toFlag(src.has_case, 'has_case');
  if (has(src, 'all_folders')) f.all_folders = strict ? toBool(src.all_folders, 'all_folders') : toFlag(src.all_folders, 'all_folders');
  if (has(src, 'from_domain')) f.from_domain = cleanDomain(src.from_domain);
  if (has(src, 'q')) f.q = cleanQ(src.q);
  return f;
}

/**
 * A JSON filters object (views, bulk mark-read): unknown keys refused, values
 * strict, and empty / false entries dropped — the stored shape is "what narrows".
 */
function strictFilters(f, label = 'filters') {
  if (f === null || f === undefined) return {};
  if (typeof f !== 'object' || Array.isArray(f)) throw httpError(400, `${label} must be an object`);
  for (const k of Object.keys(f)) {
    if (!has(FILTER_KEYS, k)) throw httpError(400, `${label}: unknown key "${k}" (allowed: ${Object.keys(FILTER_KEYS).join(', ')})`);
  }
  const clean = readFilters(f, { strict: true });
  for (const k of Object.keys(clean)) if (clean[k] === null || clean[k] === false) delete clean[k];
  return clean;
}

/**
 * The list's predicates beyond the mailbox, as exact SQL fragments + params
 * (tests/helpers/mailboxS2World.js parses these texts — keep them verbatim).
 * Shared by listMessages (with its cursor) and markRead {all} (without), so
 * "Mark all read" clears exactly what the list shows, every page of it.
 * Needs JOINS in the statement (rs / c are referenced).
 */
function scopeWhere(filters, cursor) {
  const where = [];
  const params = [];
  if (!filters.all_folders) { where.push('m.folder = ?'); params.push(INBOX); }
  if (cursor && cursor.date) {
    where.push('(m.date < ? OR (m.date = ? AND m.id < ?) OR m.date IS NULL)');
    params.push(sqlUtc(cursor.date), sqlUtc(cursor.date), cursor.id);
  } else if (cursor) {
    where.push('m.date IS NULL AND m.id < ?');
    params.push(cursor.id);
  }
  if (filters.unread_only) where.push('rs.message_fk IS NULL');
  if (filters.has_case) where.push('c.case_id IS NOT NULL');
  if (filters.from_domain) {
    // from_addr is the display form: "Name <a@b>" or bare "a@b".
    const e = escapeLike(filters.from_domain);
    where.push('(m.from_addr LIKE ? OR m.from_addr LIKE ?)');
    params.push(`%@${e}`, `%@${e}>`);
  }
  if (filters.q) {
    const like = `%${escapeLike(filters.q)}%`;
    where.push('(m.from_addr LIKE ? OR m.subject LIKE ?)');
    params.push(like, like);
  }
  return { extra: where.length ? ` AND ${where.join(' AND ')}` : '', params };
}

/**
 * The mixed-inbox list.
 * query: { view?, mailbox_ids?, unread_only?, has_case?, all_folders?,
 *          from_domain?, q?, cursor?, limit? }
 * A `view` (the caller's own) supplies mailbox_ids + filters; explicit params
 * override its filters. Scope = readable ∩ (view or param mailbox_ids).
 * @returns {{messages, next_cursor, scope_ids, view_id}}
 */
async function listMessages(db, userId, query = {}) {
  const uid = Number(userId);
  let limit = PAGE_DEFAULT;
  if (query.limit !== undefined && query.limit !== '') {
    limit = toId(query.limit, 'limit');
    if (limit > PAGE_MAX) limit = PAGE_MAX;
  }
  const cursor = parseCursor(query.cursor);

  let view = null;
  if (query.view !== undefined && query.view !== '' && query.view !== null) {
    view = await getOwnView(db, uid, toId(query.view, 'view'));
  }
  const filters = { ...(view ? readFilters(view.filters || {}) : {}), ...readFilters(query) };

  const scope = await readableScope(db, uid);
  let wanted = idList(query.mailbox_ids, 'mailbox_ids', VIEW_IDS_MAX);
  if (!wanted && view && Array.isArray(view.mailbox_ids) && view.mailbox_ids.length) wanted = view.mailbox_ids.map(Number);
  // Never an error: a stale view id / a probe for another box just narrows.
  const ids = (wanted ? wanted.filter(id => scope.has(id)) : [...scope.keys()]).sort((a, b) => a - b);
  if (!ids.length) return { messages: [], next_cursor: null, scope_ids: [], view_id: view ? view.id : null };

  // Per-branch WHERE beyond the mailbox (identical for every branch).
  const { extra, params: wParams } = scopeWhere(filters, cursor);

  const branches = [];
  const params = [];
  for (const id of ids) {
    // FORCE INDEX: the walk is the point. Left to itself the optimizer picks
    // the UNIQUE (mailbox_id, folder, uid) key + a filesort of the whole
    // mailbox once the INBOX filter is on and a box is a few thousand rows
    // (measured, MySQL 8.0 — tests/mailboxS2.mysql.test.js pins the plan).
    branches.push(
      `(SELECT ${LIST_COLS} FROM mail_messages m FORCE INDEX (idx_mail_messages_mailbox_date)${JOINS}
         WHERE m.mailbox_id = ?${extra}
         ORDER BY m.date DESC, m.id DESC LIMIT ?)`
    );
    params.push(uid, id, ...wParams, limit + 1);
  }
  params.push(limit + 1);
  const [rows] = await db.query(
    `${branches.join(' UNION ALL ')} ORDER BY \`date\` DESC, id DESC LIMIT ?`,
    params
  );

  const page = rows.slice(0, limit);
  // Whether a cid part is inline depends on the HTML body, which the list
  // projection never carries: read it server-side for just the rows on this
  // (already grant-scoped) page that HAVE a cid part — used for the count,
  // never sent.
  const htmlFor = new Map();
  const needHtml = page.filter(r => attachmentParts(r.attachments).some(p => p.cid)).map(r => Number(r.id));
  if (needHtml.length) {
    const [hrows] = await db.query('SELECT id, body_html FROM mail_messages WHERE id IN (?)', [needHtml]);
    for (const h of hrows) htmlFor.set(Number(h.id), h.body_html);
  }
  const messages = page.map(r => {
    const mb = scope.get(Number(r.mailbox_id)) || {};
    const parts = markInline(attachmentParts(r.attachments), htmlFor.get(Number(r.id)));
    return {
      id: Number(r.id),
      mailbox_id: Number(r.mailbox_id),
      mailbox_address: mb.address || null,
      folder: r.folder,
      thread_key: r.thread_key || null,
      from_addr: r.from_addr || null,
      to_addrs: r.to_addrs || null,
      cc_addrs: r.cc_addrs || null,
      subject: r.subject == null ? null : String(r.subject),
      date: toDate(r.date),
      snippet: r.snippet || null,
      unread: !!Number(r.unread),
      attachment_count: parts.filter(p => !p.inline).length,
      log_id: r.log_id == null ? null : Number(r.log_id),
      case: caseOf(r),
    };
  });
  return {
    messages,
    next_cursor: rows.length > limit && page.length ? cursorOf(page[page.length - 1]) : null,
    scope_ids: ids,
    view_id: view ? view.id : null,
  };
}


// ─────────────────────────────────────────────────────────────────────────────
// Thread / message
// ─────────────────────────────────────────────────────────────────────────────

function shapeFull(r, scope) {
  const mb = scope.get(Number(r.mailbox_id)) || {};
  return {
    id: Number(r.id),
    mailbox_id: Number(r.mailbox_id),
    mailbox_address: mb.address || null,
    folder: r.folder,
    message_id: r.message_id || null,
    thread_key: r.thread_key || null,
    from_addr: r.from_addr || null,
    to_addrs: r.to_addrs || null,
    cc_addrs: r.cc_addrs || null,
    subject: r.subject == null ? null : String(r.subject),
    date: toDate(r.date),
    snippet: r.snippet || null,
    body_text: r.body_text == null ? null : String(r.body_text),
    body_html: r.body_html == null ? null : String(r.body_html),
    attachments: markInline(attachmentParts(r.attachments), r.body_html),
    unread: !!Number(r.unread),
    log_id: r.log_id == null ? null : Number(r.log_id),
    case: caseOf(r),
  };
}

/**
 * Collapse copies of one message (the same mail stored in two readable
 * mailboxes, or in INBOX and Sent) into one entry. The primary is the copy
 * with a log row if any, else the first; `copies` lists every row so the
 * client can mark them all read; unread = any copy unread; case from any copy.
 */
function collapse(list) {
  const groups = new Map();
  for (const m of list) {
    const key = m.message_id ? `mid:${m.message_id.toLowerCase()}` : `id:${m.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  const out = [];
  for (const copies of groups.values()) {
    const primary = copies.find(c => c.log_id != null) || copies[0];
    out.push({
      ...primary,
      unread: copies.some(c => c.unread),
      case: primary.case || (copies.find(c => c.case) || {}).case || null,
      copies: copies.map(c => ({ id: c.id, mailbox_id: c.mailbox_id, mailbox_address: c.mailbox_address, folder: c.folder, unread: c.unread })),
    });
  }
  out.sort((a, b) => {
    const da = a.date ? a.date.getTime() : Infinity;
    const dbb = b.date ? b.date.getTime() : Infinity;
    return da - dbb || a.id - b.id;
  });
  return out;
}

/**
 * One thread by its stored thread_key, merged across every readable mailbox.
 * Over THREAD_MAX stored rows (copies count), the NEWEST window is returned —
 * the message the reader just clicked is almost always the latest one, and an
 * oldest-first cut would drop exactly it. collapse() puts them back in order.
 */
async function getThread(db, userId, threadKey) {
  const key = typeof threadKey === 'string' ? threadKey.trim() : '';
  if (!key || key.length > 512) throw httpError(400, 'thread key must be 1-512 characters');
  const scope = await readableScope(db, userId);
  if (!scope.size) throw httpError(404, 'Thread not found');
  const [rows] = await db.query(
    `SELECT ${FULL_COLS} FROM mail_messages m${JOINS}
      WHERE m.thread_key = ? AND m.mailbox_id IN (?)
      ORDER BY m.date DESC, m.id DESC LIMIT ?`,
    [Number(userId), key, [...scope.keys()], THREAD_MAX + 1]
  );
  if (!rows.length) throw httpError(404, 'Thread not found');
  // Back to oldest-first (date, id) — the order collapse() picks primaries in.
  const list = rows.slice(0, THREAD_MAX).reverse().map(r => shapeFull(r, scope));
  const messages = await markTrust(db, userId, collapse(list));
  return {
    thread_key: key,
    subject: (messages.find(m => m.subject) || {}).subject || null,
    truncated: rows.length > THREAD_MAX,
    messages,
  };
}

/** Message row (any columns) if the caller can read its mailbox, else 404. */
async function loadVisible(db, userId, messageId) {
  const id = toId(messageId, 'message id');
  const [[row]] = await db.query('SELECT id, mailbox_id FROM mail_messages WHERE id = ? LIMIT 1', [id]);
  if (!row) throw httpError(404, 'Message not found');
  const access = await mbx.getAccess(db, userId, 'mailbox', row.mailbox_id);
  if (!access.can_read) throw httpError(404, 'Message not found');
  return { id, mailbox_id: Number(row.mailbox_id) };
}

/** One message with bodies (threadless mail, or a direct open). */
async function getMessage(db, userId, messageId) {
  const v = await loadVisible(db, userId, messageId);
  const scope = await readableScope(db, userId);
  const [[row]] = await db.query(
    `SELECT ${FULL_COLS} FROM mail_messages m${JOINS} WHERE m.id = ? LIMIT 1`,
    [Number(userId), v.id]
  );
  if (!row) throw httpError(404, 'Message not found');
  const m = shapeFull(row, scope);
  return {
    thread_key: m.thread_key,
    subject: m.subject,
    truncated: false,
    messages: await markTrust(db, userId, [{ ...m, copies: [{ id: m.id, mailbox_id: m.mailbox_id, mailbox_address: m.mailbox_address, folder: m.folder, unread: m.unread }] }]),
  };
}


// ─────────────────────────────────────────────────────────────────────────────
// Images: "always show images from this sender" (per user)
// ─────────────────────────────────────────────────────────────────────────────
//
// Remote images stay blocked by default (a tracking pixel is a read receipt).
// A reader may trust a SENDER ADDRESS for themselves: messages from it then
// render with remote images allowed and inline images fetched, exactly as if
// "Show images" had been clicked. Per user (privacy is personal; read state is
// too), per exact address (never a whole domain). The From header is the
// sender's own claim, so a forged From from a trusted address can at most
// learn that the message was opened — the sanitizer, the sandbox and the CSP
// are unchanged whatever the trust (mailRender only widens img-src).

const SENDER_RE = /^[^\s@<>"(),;:[\]\\]+@[^\s@<>"(),;:[\]\\]+\.[^\s@<>"(),;:[\]\\]+$/;

function cleanSender(v) {
  if (typeof v !== 'string') throw httpError(400, 'address must be an email address');
  const a = v.trim().toLowerCase();
  if (!a || a.length > 255 || !SENDER_RE.test(a)) throw httpError(400, 'address must be an email address');
  return a;
}

/** `from_email` + `images_trusted` (the CALLER's list) on every message. */
async function markTrust(db, userId, messages) {
  for (const m of messages) m.from_email = senderOf(m.from_addr);
  const senders = [...new Set(messages.map(m => m.from_email).filter(Boolean))];
  let trusted = new Set();
  if (senders.length) {
    const [rows] = await db.query(
      'SELECT address FROM mail_image_senders WHERE user = ? AND address IN (?)',
      [Number(userId), senders]
    );
    trusted = new Set(rows.map(r => String(r.address).toLowerCase()));
  }
  for (const m of messages) m.images_trusted = !!(m.from_email && trusted.has(m.from_email));
  return messages;
}

async function listImageSenders(db, userId) {
  const [rows] = await db.query(
    'SELECT address, created_at FROM mail_image_senders WHERE user = ? ORDER BY address ASC',
    [Number(userId)]
  );
  return { senders: rows.map(r => ({ address: String(r.address), created_at: toDate(r.created_at) })) };
}

async function trustImageSender(db, userId, body) {
  const address = cleanSender(body && body.address);
  await db.query(
    'INSERT INTO mail_image_senders (user, address) VALUES (?, ?) ON DUPLICATE KEY UPDATE address = address',
    [Number(userId), address]
  );
  return { address };
}

async function untrustImageSender(db, userId, address) {
  const a = cleanSender(address);
  const [r] = await db.query('DELETE FROM mail_image_senders WHERE user = ? AND address = ?', [Number(userId), a]);
  return { address: a, removed: Number(r.affectedRows) || 0 };
}


// ─────────────────────────────────────────────────────────────────────────────
// Related: open the client's file from the mail
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Contacts behind the conversation's OUTSIDE addresses (firm domains and the
 * firm's own mailboxes left out), each with the cases they are a CLIENT on
 * (case_relate Primary / Secondary — an attorney or trustee "Other" on fifty
 * cases is a contact chip, not fifty case chips). Senders before recipients,
 * then first appearance; a contact's cases open stages first, then newest.
 * Only ACTIVE contact_emails rows match (one active owner per address,
 * uk_email_active). Scope: the conversation as the caller can read it.
 */
async function related(db, userId, messageId) {
  const v = await loadVisible(db, userId, messageId);
  const scope = await readableScope(db, userId);
  const [[anchor]] = await db.query('SELECT thread_key FROM mail_messages WHERE id = ? LIMIT 1', [v.id]);
  const [rows] = anchor && anchor.thread_key
    ? await db.query(
      `SELECT from_addr, to_addrs, cc_addrs FROM mail_messages
        WHERE thread_key = ? AND mailbox_id IN (?)
        ORDER BY date DESC, id DESC LIMIT ?`,
      [anchor.thread_key, [...scope.keys()], THREAD_MAX])
    : await db.query('SELECT from_addr, to_addrs, cc_addrs FROM mail_messages WHERE id = ? LIMIT 1', [v.id]);

  const [boxes] = await db.query('SELECT address FROM mailboxes');
  const own = new Set(boxes.map(b => String(b.address).toLowerCase()));
  const firm = firmDomains();
  const outside = (a) => {
    const d = a.slice(a.lastIndexOf('@') + 1);
    return !own.has(a) && !firm.has(d) && ![...firm].some(f => d.endsWith(`.${f}`));
  };
  const role = new Map(); // address → 'from' | 'to', in first-seen order (senders first)
  for (const r of rows) { const f = senderOf(r.from_addr); if (f && outside(f) && !role.has(f)) role.set(f, 'from'); }
  for (const r of rows) {
    for (const a of [...emailsIn(r.to_addrs), ...emailsIn(r.cc_addrs)]) if (outside(a) && !role.has(a)) role.set(a, 'to');
  }
  const addrs = [...role.keys()].slice(0, RELATED_ADDR_MAX);
  if (!addrs.length) return { contacts: [] };

  const [hits] = await db.query(
    `SELECT ce.email, c.contact_id, c.contact_name, c.contact_kind
       FROM contact_emails ce
       JOIN contacts c ON c.contact_id = ce.contact_id
      WHERE ce.email IN (?) AND ce.end_date IS NULL`,
    [addrs]
  );
  const order = new Map(addrs.map((a, i) => [a, i]));
  const byContact = new Map();
  for (const h of hits) {
    const email = String(h.email).toLowerCase();
    const id = Number(h.contact_id);
    if (!byContact.has(id)) {
      byContact.set(id, { contact_id: id, name: h.contact_name || null, kind: h.contact_kind || 'person', emails: [], role: 'to', rank: Infinity, cases: [] });
    }
    const c = byContact.get(id);
    c.emails.push(email);
    if (role.get(email) === 'from') c.role = 'from';
    c.rank = Math.min(c.rank, order.has(email) ? order.get(email) : Infinity);
  }
  if (!byContact.size) return { contacts: [] };

  const [caseRows] = await db.query(
    `SELECT cr.case_relate_client_id AS contact_id, cr.case_relate_type AS relation,
            ca.case_id, ca.case_number, ca.case_number_full, ca.case_type, ca.case_stage, ca.case_status, ca.case_open_date
       FROM case_relate cr
       JOIN cases ca ON ca.case_id = cr.case_relate_case_id
      WHERE cr.case_relate_client_id IN (?) AND cr.case_relate_type IN (?)`,
    [[...byContact.keys()], [...CLIENT_RELATIONS]]
  );
  const openTime = (r) => { const d = toDate(r.case_open_date); return d ? d.getTime() : -Infinity; };
  caseRows.sort((a, b) =>
    ((STAGE_RANK[a.case_stage] ?? 9) - (STAGE_RANK[b.case_stage] ?? 9)) ||
    (openTime(b) - openTime(a)) || String(a.case_id).localeCompare(String(b.case_id)));
  for (const r of caseRows) {
    const c = byContact.get(Number(r.contact_id));
    if (!c || c.cases.length >= RELATED_CASES_PER_CONTACT || c.cases.some(x => x.case_id === r.case_id)) continue;
    c.cases.push({
      case_id: r.case_id,
      case_number: r.case_number_full || r.case_number || null,
      case_type: r.case_type || null,
      case_stage: r.case_stage || null,
      case_status: r.case_status || null,
      relation: r.relation,
    });
  }
  const contacts = [...byContact.values()]
    .sort((a, b) => (a.role === b.role ? 0 : a.role === 'from' ? -1 : 1) || (a.rank - b.rank) || a.contact_id - b.contact_id)
    .map(({ rank, ...c }) => c);
  return { contacts };
}


// ─────────────────────────────────────────────────────────────────────────────
// Read state (§4.3) — idempotent, never \Seen
// ─────────────────────────────────────────────────────────────────────────────

async function setRead(db, userId, messageId, read) {
  const v = await loadVisible(db, userId, messageId);
  if (read) {
    await db.query(
      `INSERT INTO mail_read_state (user, message_fk, read_at) VALUES (?, ?, UTC_TIMESTAMP())
       ON DUPLICATE KEY UPDATE read_at = read_at`,
      [Number(userId), v.id]
    );
  } else {
    await db.query('DELETE FROM mail_read_state WHERE user = ? AND message_fk = ?', [Number(userId), v.id]);
  }
  return { id: v.id, unread: !read };
}

/**
 * Bulk mark-read: exactly one of
 *   { ids: [..≤500] }                              those of them the caller can read
 *   { all: true, mailbox_ids?: [..], filters?: {} } every message the LIST would show
 *       for (readable ∩ mailbox_ids) + filters, every page — the same scope
 *       predicates (scopeWhere: INBOX unless all_folders, unread_only,
 *       has_case, from_domain, q). "Mark all read" with a filter on clears the
 *       filtered list, never the whole mailbox behind it.
 * Grant scoping is in the statement itself (mailbox_id IN readable). The
 * anti-join keeps `marked` = rows newly marked (mysql2 sets CLIENT_FOUND_ROWS,
 * so an ON DUPLICATE no-op would otherwise count as affected); the ON
 * DUPLICATE clause only absorbs a concurrent writer.
 * @returns {{marked:number}} rows newly marked
 */
async function markRead(db, userId, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'request body must be a JSON object');
  for (const k of Object.keys(body)) {
    if (!['ids', 'all', 'mailbox_ids', 'filters'].includes(k)) throw httpError(400, `unknown field "${k}"`);
  }
  const all = has(body, 'all') ? toBool(body.all, 'all') : false;
  const hasIds = has(body, 'ids');
  if (all === hasIds) throw httpError(400, 'send exactly one of ids or all: true');
  const uid = Number(userId);
  if (all) {
    const wanted = idList(body.mailbox_ids, 'mailbox_ids', VIEW_IDS_MAX);
    const filters = strictFilters(body.filters);
    const scope = await readableScope(db, uid);
    let ids = [...scope.keys()];
    if (wanted) ids = ids.filter(id => wanted.includes(id));
    if (!ids.length) return { marked: 0 };
    const { extra, params } = scopeWhere(filters, null);
    const [r] = await db.query(
      `INSERT INTO mail_read_state (user, message_fk, read_at)
       SELECT ?, m.id, UTC_TIMESTAMP() FROM mail_messages m${JOINS}
        WHERE m.mailbox_id IN (?) AND rs.message_fk IS NULL${extra}
       ON DUPLICATE KEY UPDATE read_at = mail_read_state.read_at`,
      [uid, uid, ids, ...params]
    );
    return { marked: Number(r && r.affectedRows) || 0 };
  }
  if (has(body, 'mailbox_ids') || has(body, 'filters')) throw httpError(400, 'mailbox_ids / filters go with all: true');
  if (!Array.isArray(body.ids) || !body.ids.length) throw httpError(400, 'ids must be a non-empty array');
  const want = idList(body.ids, 'ids', BULK_READ_MAX);
  const ids = [...(await readableScope(db, uid)).keys()];
  if (!ids.length) return { marked: 0 };
  const [r] = await db.query(
    `INSERT INTO mail_read_state (user, message_fk, read_at)
     SELECT ?, m.id, UTC_TIMESTAMP() FROM mail_messages m
       LEFT JOIN mail_read_state rs ON rs.user = ? AND rs.message_fk = m.id
      WHERE m.id IN (?) AND m.mailbox_id IN (?) AND rs.message_fk IS NULL
     ON DUPLICATE KEY UPDATE read_at = mail_read_state.read_at`,
    [uid, uid, want, ids]
  );
  return { marked: Number(r && r.affectedRows) || 0 };
}


// ─────────────────────────────────────────────────────────────────────────────
// Saved views (inbox_views) — caller-owned rows only
// ─────────────────────────────────────────────────────────────────────────────

const VIEW_COLS = 'id, name, mailbox_ids, filters, is_default, sort_order';

function shapeView(r) {
  const ids = parseJson(r.mailbox_ids);
  return {
    id: Number(r.id),
    name: r.name,
    mailbox_ids: Array.isArray(ids) && ids.length ? ids.map(Number) : null,
    filters: parseJson(r.filters) || {},
    is_default: !!Number(r.is_default),
    sort_order: Number(r.sort_order) || 0,
  };
}

async function getOwnView(db, userId, viewId) {
  const [[r]] = await db.query(
    `SELECT ${VIEW_COLS} FROM inbox_views WHERE id = ? AND user = ? LIMIT 1`,
    [viewId, Number(userId)]
  );
  if (!r) throw httpError(404, 'View not found');
  return shapeView(r);
}

async function listViews(db, userId) {
  const [rows] = await db.query(
    `SELECT ${VIEW_COLS} FROM inbox_views WHERE user = ? ORDER BY sort_order ASC, id ASC`,
    [Number(userId)]
  );
  return rows.map(shapeView);
}

/** Validate a view body. `partial` = PATCH. Returns DB-shaped columns. */
async function validateView(db, userId, body, { partial }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'request body must be a JSON object');
  const allowed = ['name', 'mailbox_ids', 'filters', 'is_default', 'sort_order'];
  for (const k of Object.keys(body)) {
    if (k === 'user') throw httpError(400, 'a view always belongs to you — user is not accepted');
    if (!allowed.includes(k)) throw httpError(400, `unknown field "${k}"`);
  }
  if (partial && !Object.keys(body).length) throw httpError(400, 'no fields to update');
  const out = {};
  if (has(body, 'name') || !partial) {
    if (typeof body.name !== 'string' || !body.name.trim()) throw httpError(400, 'name is required');
    const n = body.name.trim();
    if (n.length > 64) throw httpError(400, 'name must be at most 64 characters');
    out.name = n;
  }
  if (has(body, 'mailbox_ids')) {
    const v = body.mailbox_ids;
    if (v === null || (Array.isArray(v) && !v.length)) {
      out.mailbox_ids = null;
    } else {
      if (!Array.isArray(v)) throw httpError(400, 'mailbox_ids must be an array of mailbox ids, or null for all readable');
      const ids = idList(v, 'mailbox_ids', VIEW_IDS_MAX);
      const scope = await readableScope(db, userId);
      // Same answer for "no such mailbox" and "not yours to read".
      const bad = ids.filter(id => !scope.has(id));
      if (bad.length) throw httpError(400, `mailbox ${bad[0]} is not a mailbox you can read`);
      out.mailbox_ids = JSON.stringify(ids);
    }
  }
  if (has(body, 'filters')) out.filters = JSON.stringify(strictFilters(body.filters));
  if (has(body, 'is_default')) out.is_default = toBool(body.is_default, 'is_default') ? 1 : 0;
  if (has(body, 'sort_order')) {
    const s = body.sort_order;
    if (!Number.isInteger(s) || s < -1000 || s > 1000) throw httpError(400, 'sort_order must be an integer -1000..1000');
    out.sort_order = s;
  }
  return out;
}

async function createView(db, userId, body) {
  const uid = Number(userId);
  const clean = await validateView(db, uid, body, { partial: false });
  const [[cnt]] = await db.query('SELECT COUNT(*) AS n FROM inbox_views WHERE user = ?', [uid]);
  if (Number(cnt && cnt.n) >= VIEWS_MAX) throw httpError(409, `you already have ${VIEWS_MAX} saved views — delete one first`);
  const row = {
    name: clean.name,
    mailbox_ids: has(clean, 'mailbox_ids') ? clean.mailbox_ids : null,
    filters: has(clean, 'filters') ? clean.filters : JSON.stringify({}),
    is_default: clean.is_default || 0,
    sort_order: has(clean, 'sort_order') ? clean.sort_order : 0,
  };
  const id = await withTransaction(db, async (conn) => {
    const [r] = await conn.query(
      `INSERT INTO inbox_views (user, name, mailbox_ids, filters, is_default, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [uid, row.name, row.mailbox_ids, row.filters, row.is_default, row.sort_order]
    );
    if (row.is_default) {
      await conn.query('UPDATE inbox_views SET is_default = 0 WHERE user = ? AND id <> ?', [uid, r.insertId]);
    }
    return r.insertId;
  }, { retries: 1 });
  return getOwnView(db, uid, id);
}

async function updateView(db, userId, viewId, body) {
  const uid = Number(userId);
  const id = toId(viewId, 'view id');
  const clean = await validateView(db, uid, body, { partial: true });
  await withTransaction(db, async (conn) => {
    const [[own]] = await conn.query('SELECT id FROM inbox_views WHERE id = ? AND user = ? LIMIT 1 FOR UPDATE', [id, uid]);
    if (!own) throw httpError(404, 'View not found');
    const cols = Object.keys(clean);
    await conn.query(
      `UPDATE inbox_views SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ? AND user = ?`,
      [...cols.map(c => clean[c]), id, uid]
    );
    if (clean.is_default === 1) {
      await conn.query('UPDATE inbox_views SET is_default = 0 WHERE user = ? AND id <> ?', [uid, id]);
    }
  }, { retries: 1 });
  return getOwnView(db, uid, id);
}

async function deleteView(db, userId, viewId) {
  const id = toId(viewId, 'view id');
  const [r] = await db.query('DELETE FROM inbox_views WHERE id = ? AND user = ?', [id, Number(userId)]);
  if (!r.affectedRows) throw httpError(404, 'View not found');
  return { removed: 1, id };
}


// ─────────────────────────────────────────────────────────────────────────────
// Case link (about-link machinery)
// ─────────────────────────────────────────────────────────────────────────────

/** True when the mailbox's ingest config emits this folder into the rules pipeline. */
function folderEmits(mailbox, folder) {
  const cfg = folderConfig(mailbox.ingest_folders)
    .find(([f]) => String(f).toLowerCase() === String(folder).toLowerCase());
  return !!(cfg && cfg[1].emit_to_rules);
}

/**
 * True when the ingest worker may still emit this stored message (and stamp
 * its own log row on it): an emitting folder whose new-mail cursor has not
 * passed the UID yet (in flight, or the crash window it retries), or a
 * re-key backfill that emits and has not walked past it.
 */
function emissionPending(mailbox, msg) {
  if (!folderEmits(mailbox, msg.folder)) return false;
  const states = parseJson(mailbox.ingest_state) || {};
  const stKey = Object.keys(states).find(f => f.toLowerCase() === String(msg.folder).toLowerCase());
  const st = stKey ? states[stKey] : null;
  if (!st || st.last_uid == null || msg.uid == null) return true;
  if (Number(msg.uid) > Number(st.last_uid)) return true;
  if (st.backfill_emit_after && st.backfill_uid != null && Number(msg.uid) < Number(st.backfill_uid)) return true;
  return false;
}

/**
 * A live log row some ingest source already wrote for this email, or null.
 * Keys: the RFC Message-ID (bare and bracketed — sources differ) and every
 * provider id the store holds for it, this row's and its copies' (a SiteGround
 * box forwarding into the Workspace inbox has its Gmail-keyed twin there).
 * email_ingest_executions.message_id is indexed; the log JOIN drops rows whose
 * log entry was deleted. Execution rows are per source, so this is the only
 * place a cross-source match is made — by design, for linking only.
 */
async function priorLogId(conn, msg) {
  const keys = new Set();
  if (msg.provider_id) keys.add(String(msg.provider_id));
  if (msg.message_id) {
    keys.add(String(msg.message_id));
    keys.add(`<${msg.message_id}>`);
    const [twins] = await conn.query(
      'SELECT DISTINCT provider_id FROM mail_messages WHERE message_id = ? AND provider_id IS NOT NULL',
      [msg.message_id]
    );
    for (const t of twins) keys.add(String(t.provider_id));
  }
  if (!keys.size) return null;
  const [[ex]] = await conn.query(
    `SELECT e.log_id FROM email_ingest_executions e JOIN log l ON l.log_id = e.log_id
      WHERE e.message_id IN (?) ORDER BY e.id ASC LIMIT 1`,
    [[...keys]]
  );
  return ex ? Number(ex.log_id) : null;
}

/** The earlier of two instants (either may be null). */
function earliest(a, b) {
  if (a && b) return a.getTime() <= b.getTime() ? a : b;
  return a || b || null;
}

/**
 * Link a message to a case via its log row's about-link (about_type 'case').
 * body: { case_id }. Reuses a log row that already carries the email (its own
 * stamp, a copy's, or another source's); only otherwise creates one (header).
 * @returns {{id, log_id, log_created:boolean, case:{case_id, case_number}}}
 */
async function caseLink(db, userId, messageId, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'request body must be a JSON object');
  for (const k of Object.keys(body)) {
    if (k !== 'case_id') throw httpError(400, `unknown field "${k}"`);
  }
  const caseIdRaw = typeof body.case_id === 'string' ? body.case_id.trim() : (typeof body.case_id === 'number' ? String(body.case_id) : '');
  if (!CASE_ID_RE.test(caseIdRaw)) throw httpError(400, 'case_id is required');

  const v = await loadVisible(db, userId, messageId);
  const [[cs]] = await db.query(
    'SELECT case_id, case_number, case_number_full FROM cases WHERE case_id = ? LIMIT 1', [caseIdRaw]
  );
  if (!cs) throw httpError(404, 'Case not found');

  const result = await withTransaction(db, async (conn) => {
    const [[msg]] = await conn.query(
      `SELECT id, mailbox_id, folder, uid, message_id, provider_id, from_addr, to_addrs, subject, date,
              ingested_at, (ingested_at > NOW() - INTERVAL ? MINUTE) AS fresh,
              body_text, body_html, log_id
         FROM mail_messages WHERE id = ? LIMIT 1 FOR UPDATE`,
      [STORE_ONLY_GRACE_MIN, v.id]
    );
    if (!msg) throw httpError(404, 'Message not found');
    let logId = msg.log_id == null ? null : Number(msg.log_id);
    let created = false;

    if (!logId && msg.message_id) {
      // A copy of the same mail (another mailbox or folder) already in the
      // log: link THAT row rather than logging the email twice.
      const [[cp]] = await conn.query(
        `SELECT log_id FROM mail_messages
          WHERE message_id = ? AND id <> ? AND log_id IS NOT NULL
          ORDER BY id ASC LIMIT 1`,
        [msg.message_id, msg.id]
      );
      if (cp) logId = Number(cp.log_id);
    }

    // Logged by another source while this mailbox stored it store-only (the
    // Apps Script source logs the Workspace inbox today): link THAT row.
    if (!logId) logId = await priorLogId(conn, msg);

    if (!logId) {
      const [[mb]] = await conn.query(
        'SELECT id, ingest_folders, ingest_state FROM mailboxes WHERE id = ? LIMIT 1', [msg.mailbox_id]
      );
      if (mb && emissionPending(mb, msg)) {
        throw httpError(409, 'This message is still being processed by the mail sync — try again in a few minutes.');
      }
      if (mb && !folderEmits(mb, msg.folder) && Number(msg.fresh)) {
        throw httpError(409, `This email arrived in the last few minutes and another mail sync may still log it — try again in about ${STORE_ONLY_GRACE_MIN} minutes.`);
      }
      const fromEmail = emailsIn(msg.from_addr)[0] || '';
      const toList = emailsIn(msg.to_addrs);
      const direction = inferDirection(fromEmail, firmDomains());
      const otherParty = direction === 'incoming' ? fromEmail : (toList[0] || '');
      if (!otherParty) throw httpError(422, 'This message has no usable address to log it under.');
      // The text the worker would have emitted (text part, else derived from
      // the HTML) — never raw mail HTML into the firm-visible log.
      let message = emitText(msg.body_text, msg.body_html).text || '';
      if (message.length > LOG_MESSAGE_SOFT_CAP) message = message.slice(0, LOG_MESSAGE_SOFT_CAP) + '…[truncated]';
      const subject = msg.subject == null ? '' : String(msg.subject);
      const to = toList.join(', ');
      const r = await logService.createLogEntry(conn, {
        type: 'email',
        link_type: 'email',
        link_id: otherParty,
        about_type: 'case',
        about_id: cs.case_id,
        by: Number(userId),
        data: { From: fromEmail, To: to, Subject: subject, Message: message },
        extra: {
          source: 'mailbox-hub',
          mailbox_id: Number(msg.mailbox_id),
          mail_message_id: Number(msg.id),
          message_id: msg.message_id || null,
          folder: msg.folder,
        },
        from: fromEmail,
        to,
        subject,
        message,
        direction,
        // When it was sent — but never after the worker stored it: the Date
        // header is sender-supplied, and a future-dated one would sit at the
        // top of the case log for good.
        date: earliest(toDate(msg.date), toDate(msg.ingested_at)),
      });
      logId = Number(r.log_id);
      created = true;
    }

    if (msg.log_id == null) {
      await conn.query('UPDATE mail_messages SET log_id = ? WHERE id = ? AND log_id IS NULL', [logId, msg.id]);
    }
    if (!created) {
      try {
        await logService.setLogAbout(conn, { log_id: logId, about_type: 'case', about_id: cs.case_id });
      } catch (err) {
        if (err && err.code === 'LOG_NOT_FOUND') {
          throw httpError(409, 'The log entry this message points at no longer exists.');
        }
        throw err;
      }
    }
    return { id: Number(msg.id), log_id: logId, log_created: created };
  }, { retries: 1 });

  return { ...result, case: { case_id: cs.case_id, case_number: cs.case_number_full || cs.case_number || null } };
}


module.exports = {
  summary,
  listMessages,
  getThread,
  getMessage,
  setRead,
  markRead,
  listViews,
  createView,
  updateView,
  deleteView,
  caseLink,
  related,
  listImageSenders,
  trustImageSender,
  untrustImageSender,
  // exported for tests
  senderOf,
  CLIENT_RELATIONS,
  RELATED_CASES_PER_CONTACT,
  emissionPending,
  folderEmits,
  STORE_ONLY_GRACE_MIN,
  emailsIn,
  referencedCids,
  markInline,
  parseCursor,
  cursorOf,
  FILTER_KEYS,
  LIST_COLS,
  PAGE_MAX,
  THREAD_MAX,
  BULK_READ_MAX,
};
