// services/mailbox/mailboxIngestService.js
//
/**
 * Mailbox ingest worker — mailbox-system arc, slice S1
 * services/mailbox/mailboxIngestService.js
 *
 *   runIngest(db, { budgetMs })   one lock-guarded poll pass over every
 *                                 active, ingest-enabled mailbox
 *   loadConnectionRow(db, id)     the secret-bearing row the transport needs
 *                                 (also used by the attachment route)
 *
 * Spec: ref/MAILBOX_SYSTEM_DESIGN.md §4.1, D1/D4/D6. Driven by POST
 * /mailbox-ingest (routes/mailboxIngest.js), ticked by Cloud Scheduler.
 *
 * ── TWO TIERS, ONE PASS ──────────────────────────────────────────────────────
 * Every message in every polled folder is stored in `mail_messages` (tier 1,
 * complete, grant-scoped). Folders whose ingest_folders entry says
 * `emit_to_rules: true` ALSO hand a canonical envelope to
 * emailIngestService.ingestEmail in-process, under the `mailbox-imap` source
 * row — rules, suppressions, firm-to-firm, executions and the log run exactly
 * as they do for the Apps Script source. The returned log_id is stamped on
 * the stored row (the tier bridge).
 *
 * ── THE CURSOR (ingest_state[folder]) ────────────────────────────────────────
 *   uidvalidity           the folder's UIDVALIDITY the cursor belongs to
 *   last_uid              every UID ≤ this has been processed by the NEW pass
 *   backfill_uid          backlog still to store: UIDs < this (absent = done)
 *   backfill_emit_after   ISO time; a backfilled message delivered after it
 *                         (INTERNALDATE, minus slack) is still emitted —
 *                         set only by a re-key (see below); null = store-only
 *   checked_at            last successful new pass (the re-key's emit horizon)
 *   errors / backfill_errors / last_error / last_error_at   failure streaks
 *   rekeyed_at, backfill_done_at                            breadcrumbs
 *
 * ── HISTORY IS NEVER EMITTED ─────────────────────────────────────────────────
 * The first time a folder is seen, the new-mail cursor starts at UIDNEXT and
 * everything already in the folder becomes BACKLOG: stored, never emitted.
 * Emitting a mailbox's history into the rules pipeline would re-fire every
 * court / e-sign / task rule on months of old mail (the 2026-06-10 replay
 * class, at scale). "Emit to rules" therefore means "mail that arrives after
 * YisraCase started watching this folder".
 *
 * New mail is processed before backlog — every mailbox's new-mail pass runs
 * (phase 1) before any backfill (phase 2), so a large first sync never delays
 * the next court notice. Backfill walks DOWN from the cursor, newest first.
 *
 * ── UIDVALIDITY CHANGE ⇒ RE-KEY, NEVER BLANKET PURGE (§4.1) ──────────────────
 * Also taken when a folder has stored rows but no cursor (state was lost):
 * stored UIDs cannot be trusted against the server either way. One
 * ENVELOPE scan of the folder, then ONE pure-DB transaction:
 *   orphans (no unique Message-ID match) → their mail_read_state, then the
 *   rows, are deleted; matched rows whose UID moves are PARKED at uid=NULL;
 *   then every final UID is set (a CASE update — collision-free once parked);
 *   then the new cursor is written.
 * Messages the server has that matched nothing are left to the backfill pass
 * (it stores whatever is missing), with backfill_emit_after = the old
 * cursor's checked_at: a message delivered after we last looked is new and is
 * emitted; anything older (a provider migration's imported history) is
 * stored only. Re-emitted envelopes are absorbed by the pipeline's
 * (source, message_id) dedupe.
 *
 * ── DELIVERY SEMANTICS ───────────────────────────────────────────────────────
 * The cursor advances only after the messages below it are durably stored and
 * emitted. A crash between store and emit leaves a row with log_id NULL above
 * the cursor; the retry re-emits it (the pipeline answers `duplicate` if it
 * had already run) — at-least-once into a deduping pipeline. Emission is in
 * no transaction (it runs external side effects); the only transaction here
 * is the re-key, which is pure DB (retries:1).
 *
 * ── NO MODULE-SCOPE STATE (design §2) ────────────────────────────────────────
 * `limits` is configuration, read at call time. No caches, no connections.
 *
 * ── LOCK ─────────────────────────────────────────────────────────────────────
 * GET_LOCK(CONCAT('mailbox_ingest:', DATABASE()), 0) on a dedicated pooled
 * connection; held → the run returns {skipped:true}. The DATABASE() suffix is
 * load-bearing: lock names are server-global and the SiteGround MySQL may be
 * shared (YC3 P0-6) — never shorten it. SiteGround reaps a connection idle
 * for 60 s (wait_timeout) and a reaped connection silently RELEASES its lock,
 * while this run's work happens on other pooled connections — so the lock
 * connection is pinged every `limits.heartbeatMs`; a failed ping or a lock no
 * longer ours stops the run at the next checkpoint (lockLost:true).
 */

'use strict';

const transport = require('./imapTransport');
const emailIngestService = require('../emailIngestService');
const { withTransaction } = require('../../lib/withTransaction');

const SOURCE_NAME = 'mailbox-imap';
const ADAPTER_VERSION = 'yc-imap-1';
// The ONE spelling of the lock name. Every GET/IS_USED/RELEASE uses it.
const LOCK_EXPR = "CONCAT('mailbox_ingest:', DATABASE())";
const DEFAULT_FOLDERS = Object.freeze({ INBOX: Object.freeze({ emit_to_rules: true }) });

/** Knobs, read at call time (tests shrink them). Env overrides are platform knobs. */
const limits = {
  defaultBudgetMs: 240_000,   // MAILBOX_INGEST_BUDGET_MS; ~4 min under a 5-min tick
  batchSize: 25,              // MAILBOX_INGEST_BATCH_SIZE; messages per IMAP fetch
  alertAfter: 5,              // consecutive failed runs of one folder → one warning alert
  heartbeatMs: 20_000,        // lock-connection ping (SiteGround wait_timeout is 60 s)
  rekeyEmitSlackMs: 10 * 60_000,
  idChunk: 500,
};

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

function envInt(name, dflt, lo, hi) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < lo || n > hi) {
    console.warn(`[mailboxIngest] ignoring ${name}=${raw} (want an integer ${lo}..${hi})`);
    return dflt;
  }
  return n;
}

function resolveBudgetMs(budgetMs) {
  if (Number.isFinite(Number(budgetMs)) && Number(budgetMs) > 0) return Number(budgetMs);
  return envInt('MAILBOX_INGEST_BUDGET_MS', limits.defaultBudgetMs, 1_000, 840_000);
}

function batchSize() {
  return envInt('MAILBOX_INGEST_BATCH_SIZE', limits.batchSize, 1, 200);
}

function parseJson(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return null; }
}

function chunks(list, n) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

function errText(err) {
  const code = err && err.code ? `${err.code}: ` : '';
  const msg = err && err.message ? String(err.message) : String(err);
  // Sanitized IMAP errors already lead with their code.
  return (msg.startsWith('IMAP ') ? msg : code + msg).replace(/\s+/g, ' ').slice(0, 300);
}

function cut(v, n) {
  if (v == null) return null;
  const s = String(v);
  return s.length > n ? s.slice(0, n) : s;
}

/** Folder config → [[name, {emit_to_rules:boolean}]]. Absent/empty → INBOX emitting. */
function folderConfig(ingestFolders) {
  const cfg = parseJson(ingestFolders);
  const src = cfg && typeof cfg === 'object' && !Array.isArray(cfg) && Object.keys(cfg).length
    ? cfg : DEFAULT_FOLDERS;
  return Object.keys(src)
    .filter(name => typeof name === 'string' && name.length)
    .map(name => [name, { emit_to_rules: !!(src[name] && src[name].emit_to_rules === true) }]);
}

function backfillPending(st) {
  return !!st && Number(st.backfill_uid) > 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Header / address / body helpers (envelope parity with ref/gas.js)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * RFC 5322 header block → { all: {name: [values]}, flat: {name: value|values} }.
 * Folded lines unfold onto the previous value — a port of the Apps Script
 * adapter's parseHeaderBlock, so headers.all has the same shape.
 */
function parseHeaderBlock(block) {
  const all = {};
  let current = null;
  for (const line of String(block || '').split(/\r?\n/)) {
    if (line === '') { current = null; continue; }
    if (current !== null && (line[0] === ' ' || line[0] === '\t')) {
      const arr = all[current];
      arr[arr.length - 1] += ' ' + line.replace(/^\s+/, '');
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) { current = null; continue; }
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    (all[name] || (all[name] = [])).push(value);
    current = name;
  }
  const flat = {};
  for (const [k, v] of Object.entries(all)) flat[k] = v.length === 1 ? v[0] : v;
  return { all, flat };
}

function firstHeader(parsed, name) {
  const v = parsed.all[name];
  return v && v.length ? v[0] : null;
}

/** Same extraction as ref/gas.js parseAuthMethod. */
function parseAuthMethod(raw, method) {
  if (raw == null || raw === '') return null;
  const m = String(raw).match(new RegExp('(?:^|[\\s;])' + method + '=([a-zA-Z]+)'));
  return m ? m[1].toLowerCase() : null;
}

/** All <id> tokens of a References / In-Reply-To value, brackets stripped. */
function messageIdList(raw) {
  if (!raw) return [];
  const out = [];
  const re = /<([^<>\s]+)>/g;
  let m;
  while ((m = re.exec(String(raw)))) out.push(m[1]);
  return out;
}

/** {name, address} list → canonical-envelope [{name, email}] (emails lowercased, blanks dropped). */
function envelopeAddrs(list) {
  return (list || [])
    .filter(a => a && a.address && String(a.address).includes('@'))
    .map(a => ({ name: a.name || '', email: String(a.address).trim().toLowerCase() }));
}

/** Display form: `Name <a@b>` or `a@b`. Quotes the name when it carries specials. */
function displayAddr(a) {
  const email = String(a.email || '').trim();
  const name = String(a.name || '').replace(/[\r\n]+/g, ' ').trim();
  if (!name || name.toLowerCase() === email) return email;
  const q = /[(),:;<>@[\]"\\]/.test(name) ? `"${name.replace(/["\\]/g, '\\$&')}"` : name;
  return `${q} <${email}>`;
}

function displayList(list) {
  const s = (list || []).map(displayAddr).filter(Boolean).join(', ');
  return s || null;
}

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };

/**
 * HTML → readable text, for HTML-only mail. Parity matters: the court rules
 * (8–10) regex the envelope's `text`, and court NEFs are text/html only — the
 * Apps Script source gets Gmail's derived plain text there; this is ours.
 * Approximate by nature; verify against Gmail's during the Gmail-IMAP parity
 * window before the Apps Script source retires.
 */
function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote|pre|section|article|header|footer)\s*>/gi, '\n')
    .replace(/<(p|div|tr|li|h[1-6]|table|blockquote|pre)\b[^>]*>/gi, '\n')
    .replace(/<\/(td|th)\s*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e) => {
      const k = e.toLowerCase();
      if (k[0] === '#') {
        const cp = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
        return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
      }
      return Object.prototype.hasOwnProperty.call(ENTITIES, k) ? ENTITIES[k] : m;
    })
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Header Date when sane, else INTERNALDATE, else null. */
function effectiveDate(m) {
  const d = m.envelope && m.envelope.date;
  if (d instanceof Date && !Number.isNaN(d.getTime())) {
    const y = d.getUTCFullYear();
    if (y >= 1970 && y <= 2100) return d;
  }
  return m.internalDate instanceof Date && !Number.isNaN(m.internalDate.getTime()) ? m.internalDate : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Row + envelope builders (pure)
// ─────────────────────────────────────────────────────────────────────────────

/** A transport message → mail_messages column values. */
function buildRow(mailboxId, folder, m) {
  const hdr = parseHeaderBlock(m.headerBlock);
  const env = m.envelope || {};
  const refs = messageIdList(firstHeader(hdr, 'references'));
  const inReplyTo = env.inReplyTo || messageIdList(firstHeader(hdr, 'in-reply-to'))[0] || null;
  // Thread root: first References entry (oldest ancestor), else the parent,
  // else the message itself. Subject/participants fallback is S2's (OQ1).
  const threadKey = refs[0] || inReplyTo || env.messageId || null;
  const from = envelopeAddrs(env.from);
  const snippetSrc = m.text != null ? m.text : htmlToText(m.html);
  return {
    mailbox_id: mailboxId,
    folder,
    uid: m.uid,
    message_id: cut(env.messageId, 512),
    in_reply_to: cut(inReplyTo, 512),
    thread_key: cut(threadKey, 512),
    from_addr: from.length ? cut(displayAddr(from[0]), 255) : null,
    to_addrs: displayList(envelopeAddrs(env.to)),
    cc_addrs: displayList(envelopeAddrs(env.cc)),
    subject: env.subject != null ? String(env.subject) : null,
    date: effectiveDate(m),
    snippet: cut(String(snippetSrc || '').replace(/\s+/g, ' ').trim(), 255) || null,
    body_text: m.text != null ? m.text : null,
    body_html: m.html != null ? m.html : null,
    attachments: JSON.stringify(Array.isArray(m.attachments) ? m.attachments : []),
    size: Number.isFinite(Number(m.size)) ? Number(m.size) : null,
    flags: (m.flags || []).join(','),
  };
}

/**
 * A transport message → the canonical envelope emailIngestService consumes
 * (same shape the Apps Script adapter posts — ref/gas.js
 * buildCanonicalEnvelope), plus a `mailbox` provenance block.
 */
function buildEnvelope({ source, mailbox, folder, uidValidity, m, receivedAt }) {
  const hdr = parseHeaderBlock(m.headerBlock);
  const env = m.envelope || {};
  const warnings = [];

  let to = envelopeAddrs(env.to);
  if (!to.length) {
    const bcc = envelopeAddrs(env.bcc);
    if (bcc.length) { to = bcc; warnings.push('to_empty_fell_back_to_bcc'); }
    else warnings.push('to_empty_and_no_bcc');
  }
  // Delivered-To is the receiving address (plus-tags intact) — what the Apps
  // Script adapter uses. Absent → the mailbox's own address: it is, by
  // construction, where this copy was delivered.
  const delivered = envelopeAddrsFromHeader(firstHeader(hdr, 'delivered-to'))[0]
    || String(mailbox.address || '').toLowerCase() || null;
  let localPart = null; let plusTag = null; let domain = null;
  if (delivered && delivered.lastIndexOf('@') > 0) {
    const at = delivered.lastIndexOf('@');
    const lp = delivered.slice(0, at);
    domain = delivered.slice(at + 1) || null;
    const plus = lp.indexOf('+');
    localPart = plus >= 0 ? lp.slice(0, plus) : lp;
    plusTag = plus >= 0 ? lp.slice(plus + 1) : null;
  }

  const authRaw = firstHeader(hdr, 'authentication-results');
  const date = effectiveDate(m);
  let text = m.text != null ? m.text : '';
  const html = m.html != null ? m.html : '';
  if (!text && html) { text = htmlToText(html); warnings.push('text_derived_from_html'); }
  if (m.textTruncated) warnings.push('text_truncated');
  if (m.htmlTruncated) warnings.push('html_truncated');

  return {
    schema_version: '1',
    received_at: receivedAt,
    source: source.name,
    adapter_version: ADAPTER_VERSION,
    kind: 'email',
    envelope: {
      sender: null,
      recipient: delivered,
      local_part: localPart,
      plus_tag: plusTag,
      domain,
      exim_message_id: null,
      exim_local_part_raw: null,
      exim_domain_raw: null,
    },
    from: envelopeAddrs(env.from)[0] || { name: '', email: '' },
    to,
    cc: envelopeAddrs(env.cc),
    reply_to: envelopeAddrs(env.replyTo),
    subject: env.subject != null ? String(env.subject) : '',
    date: firstHeader(hdr, 'date') || (date ? date.toUTCString() : null),
    text,
    html,
    attachments: (m.attachments || []).map(a => ({
      filename: a.filename, mime: a.mime, size: a.size, url: null, content_id: a.cid || '',
    })),
    auth: {
      spf: parseAuthMethod(authRaw, 'spf'),
      dkim: parseAuthMethod(authRaw, 'dkim'),
      dmarc: parseAuthMethod(authRaw, 'dmarc'),
      arc: parseAuthMethod(authRaw, 'arc'),
      antispam_result: firstHeader(hdr, 'x-antispam-scan-result'),
      raw_authentication_results: authRaw,
    },
    headers: {
      // The RFC Message-ID (NOT a provider-internal id) — this source's
      // (source, message_id) dedupe key in email_log.
      message_id: env.messageId || null,
      in_reply_to: firstHeader(hdr, 'in-reply-to'),
      references: firstHeader(hdr, 'references'),
      content_type: firstHeader(hdr, 'content-type'),
      list_id: firstHeader(hdr, 'list-id'),
      all: hdr.flat,
    },
    raw: { headers_block: m.headerBlock || null, body_block: null },
    mailbox: { id: mailbox.id, address: mailbox.address, folder, uid: m.uid, uidvalidity: uidValidity },
    _parse_warnings: warnings,
  };
}

function envelopeAddrsFromHeader(raw) {
  if (!raw) return [];
  const m = String(raw).match(/<([^<>\s]+@[^<>\s]+)>/) || String(raw).match(/([^\s<>,;]+@[^\s<>,;]+)/);
  return m ? [m[1].trim().toLowerCase()] : [];
}

// ─────────────────────────────────────────────────────────────────────────────
// UIDVALIDITY re-key plan (pure)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * stored:  [{id, uid, message_id}] — this folder's mail_messages rows
 * current: [{uid, messageId}]       — the server's folder right now
 *
 * A stored row re-maps only when its Message-ID is present AND unique among
 * stored rows AND unique on the server. Everything else stored is an orphan
 * (purged); everything on the server that matched nothing is `unmatched`
 * (the backfill pass stores it).
 *
 * @returns {{ remap: Array<{id, oldUid, newUid}>, moving: Array<{id, oldUid, newUid}>,
 *             orphans: number[], unmatchedUids: number[] }}
 */
function planRekey(stored, current) {
  const norm = (v) => transport.normalizeMessageId(v);
  const storedBy = new Map();
  for (const r of stored || []) {
    const mid = norm(r.message_id);
    if (!mid) continue;
    (storedBy.get(mid) || storedBy.set(mid, []).get(mid)).push(r);
  }
  const currentBy = new Map();
  for (const c of current || []) {
    const mid = norm(c.messageId);
    if (!mid) continue;
    (currentBy.get(mid) || currentBy.set(mid, []).get(mid)).push(Number(c.uid));
  }
  const remap = [];
  const matchedIds = new Set();
  const taken = new Set();
  for (const [mid, rows] of storedBy) {
    const uids = currentBy.get(mid);
    if (rows.length !== 1 || !uids || uids.length !== 1) continue;
    remap.push({ id: rows[0].id, oldUid: rows[0].uid == null ? null : Number(rows[0].uid), newUid: uids[0] });
    matchedIds.add(rows[0].id);
    taken.add(uids[0]);
  }
  const orphans = (stored || []).filter(r => !matchedIds.has(r.id)).map(r => r.id);
  const unmatchedUids = (current || []).map(c => Number(c.uid)).filter(u => !taken.has(u)).sort((a, b) => a - b);
  const moving = remap.filter(r => r.oldUid !== r.newUid);
  return { remap, moving, orphans, unmatchedUids };
}

// ─────────────────────────────────────────────────────────────────────────────
// DB access
// ─────────────────────────────────────────────────────────────────────────────

// The ONLY projections that select imap_secret (ciphertext). It is handed to
// imapTransport, which alone decrypts it. Never log one of these rows.
const CONNECTION_COLUMNS =
  'id, address, imap_host, imap_port, imap_user, imap_secret, ingest_folders, ingest_state, active, ingest_enabled';

async function listIngestMailboxes(db) {
  const [rows] = await db.query(
    `SELECT ${CONNECTION_COLUMNS} FROM mailboxes WHERE active = 1 AND ingest_enabled = 1 ORDER BY id ASC`
  );
  return rows;
}

/** One mailbox's connection row (any active/ingest state), or null. */
async function loadConnectionRow(db, mailboxId) {
  const [[row]] = await db.query(`SELECT ${CONNECTION_COLUMNS} FROM mailboxes WHERE id = ? LIMIT 1`, [mailboxId]);
  return row || null;
}

async function loadSource(db) {
  const [[row]] = await db.query(
    'SELECT id, name, active FROM email_ingest_sources WHERE name = ? LIMIT 1', [SOURCE_NAME]
  );
  return row ? { id: row.id, name: row.name, active: !!Number(row.active) } : null;
}

/**
 * Persist the whole cursor object. `updated_at = updated_at` keeps the
 * ON UPDATE timestamp meaning "config last edited", not "last polled".
 */
async function writeState(db, mailboxId, state) {
  await db.query(
    'UPDATE mailboxes SET ingest_state = ?, updated_at = updated_at WHERE id = ?',
    [JSON.stringify(state), mailboxId]
  );
}

async function existingRows(db, mailboxId, folder, uids) {
  const out = new Map();
  for (const part of chunks(uids, limits.idChunk)) {
    const [rows] = await db.query(
      'SELECT id, uid, log_id FROM mail_messages WHERE mailbox_id = ? AND folder = ? AND uid IN (?)',
      [mailboxId, folder, part]
    );
    for (const r of rows) out.set(Number(r.uid), r);
  }
  return out;
}

/** An earlier mailbox-imap execution's log row for this Message-ID, if any. */
async function recoverLogId(db, sourceId, messageId) {
  if (!sourceId || !messageId) return null;
  const [[row]] = await db.query(
    `SELECT log_id FROM email_ingest_executions
      WHERE source_id = ? AND message_id = ? AND log_id IS NOT NULL
      ORDER BY id ASC LIMIT 1`,
    [sourceId, String(messageId).slice(0, 255)]
  );
  return row && row.log_id ? Number(row.log_id) : null;
}

async function stampLogId(db, rowId, logId) {
  await db.query('UPDATE mail_messages SET log_id = ? WHERE id = ? AND log_id IS NULL', [logId, rowId]);
}

const INSERT_COLS = [
  'mailbox_id', 'folder', 'uid', 'message_id', 'in_reply_to', 'thread_key', 'from_addr',
  'to_addrs', 'cc_addrs', 'subject', 'date', 'snippet', 'body_text', 'body_html',
  'attachments', 'size', 'flags',
];

/** Insert-or-noop on UNIQUE(mailbox_id, folder, uid). insertId 0 ⇔ it already existed. */
async function insertRow(db, row) {
  const [r] = await db.query(
    `INSERT INTO mail_messages (${INSERT_COLS.join(', ')})
     VALUES (${INSERT_COLS.map(() => '?').join(', ')})
     ON DUPLICATE KEY UPDATE id = id`,
    INSERT_COLS.map(c => row[c])
  );
  return Number(r.insertId) || 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lock
// ─────────────────────────────────────────────────────────────────────────────

async function acquireLock(db) {
  const conn = await db.getConnection();
  let got = false;
  try {
    const [[r]] = await conn.query(`SELECT GET_LOCK(${LOCK_EXPR}, 0) AS got`);
    got = !!r && Number(r.got) === 1;
  } catch (err) {
    try { conn.release(); } catch (_) { try { conn.destroy(); } catch (_) { /* gone */ } }
    throw err;
  }
  if (!got) {
    try { conn.release(); } catch (_) { try { conn.destroy(); } catch (_) { /* gone */ } }
    return null;
  }
  let lost = false;
  let closed = false;
  const beat = setInterval(() => {
    if (closed) return;
    conn.query(`SELECT IS_USED_LOCK(${LOCK_EXPR}) = CONNECTION_ID() AS mine`)
      .then(([[h]]) => { if (!closed && (!h || Number(h.mine) !== 1)) lost = true; })
      .catch(() => { if (!closed) lost = true; });
  }, limits.heartbeatMs);
  if (typeof beat.unref === 'function') beat.unref();
  return {
    lost: () => lost,
    async release() {
      if (closed) return;
      closed = true;
      clearInterval(beat);
      let clean = true;
      try { await conn.query(`SELECT RELEASE_LOCK(${LOCK_EXPR})`); } catch (_) { clean = false; }
      if (clean) {
        try { conn.release(); } catch (_) { try { conn.destroy(); } catch (_) { /* gone */ } }
      } else {
        // Closing the socket releases the lock anyway.
        try { conn.destroy(); } catch (_) { /* gone */ }
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Alerts (deferred require — circular-dep safety convention)
// ─────────────────────────────────────────────────────────────────────────────

function sendAlert(db, o) {
  try {
    const { alert } = require('../../lib/alerting');
    return Promise.resolve(alert(db, { source: 'app', ...o })).catch(() => {});
  } catch (_) {
    return Promise.resolve();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-folder state bookkeeping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `checkedAt` (new pass only): when the folder was EXAMINEd for a pass that
 * then ran to completion — every message delivered before it is processed.
 * It is the re-key's emit horizon, so a pass cut short by the budget must not
 * move it (the unprocessed tail would later count as "already seen").
 */
function markOk(state, folder, phase, checkedAt) {
  const st = state[folder] || (state[folder] = {});
  if (phase === 'new') { delete st.errors; if (checkedAt) st.checked_at = checkedAt; }
  else delete st.backfill_errors;
  if (!st.errors && !st.backfill_errors) { delete st.last_error; delete st.last_error_at; }
}

/** @returns {number} the streak length after this failure */
function markError(state, folder, phase, err, nowIso) {
  const st = state[folder] || (state[folder] = {});
  const key = phase === 'new' ? 'errors' : 'backfill_errors';
  st[key] = (Number(st[key]) || 0) + 1;
  st.last_error = errText(err);
  st.last_error_at = nowIso;
  return st[key];
}

// ─────────────────────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────────────────────

function newSummary() {
  return {
    skipped: false,
    lockLost: false,
    mailboxes: 0,
    folders: 0,
    fetched: 0,
    stored: 0,
    backfilled: 0,
    emitted: 0,
    duplicates: 0,
    rekeyed: 0,
    skippedBudget: 0,
    errors: 0,
    pipeline: {},
    emitDisabled: null,
    details: [],
    durationMs: 0,
  };
}

/**
 * Store (and maybe emit) one message.
 * @returns {Promise<'stored'|'present'|'duplicate'>}
 */
async function processMessage(ctx, mb, folder, cfg, st, m, pass, existing) {
  const { db, summary, source } = ctx;
  const mid = m.envelope && m.envelope.messageId;
  let rowId = existing ? existing.id : null;
  let logIdNull = existing ? existing.log_id == null : true;
  let inserted = false;

  if (!existing) {
    // Secondary dedupe: the same Message-ID already stored in this folder
    // under another UID (duplicate delivery, a client re-append).
    if (mid) {
      const [[dup]] = await db.query(
        'SELECT id FROM mail_messages WHERE mailbox_id = ? AND folder = ? AND message_id = ? LIMIT 1',
        [mb.id, folder, String(mid).slice(0, 512)]
      );
      if (dup) { summary.duplicates++; ctx.folderStats.duplicates++; return 'duplicate'; }
    }
    const id = await insertRow(db, buildRow(mb.id, folder, m));
    if (id) {
      rowId = id;
      inserted = true;
      if (pass === 'new') { summary.stored++; ctx.folderStats.stored++; }
      else { summary.backfilled++; ctx.folderStats.backfilled++; }
    } else {
      // A concurrent writer got there first (lock lost mid-run).
      const [[row]] = await db.query(
        'SELECT id, log_id FROM mail_messages WHERE mailbox_id = ? AND folder = ? AND uid = ? LIMIT 1',
        [mb.id, folder, m.uid]
      );
      summary.duplicates++;
      ctx.folderStats.duplicates++;
      if (!row) return 'present';
      rowId = row.id;
      logIdNull = row.log_id == null;
    }
  }

  // ── Emit decision ──
  let emit = false;
  if (cfg.emit_to_rules && source && source.active) {
    if (pass === 'new') {
      emit = inserted || logIdNull; // logIdNull on an existing row = crash window, retry
    } else if (inserted && st.backfill_emit_after) {
      const after = Date.parse(st.backfill_emit_after);
      const when = m.internalDate || (m.envelope && m.envelope.date) || null;
      emit = Number.isFinite(after) && when instanceof Date &&
        when.getTime() >= after - limits.rekeyEmitSlackMs;
    }
  }

  if (emit) {
    const envelope = buildEnvelope({
      source, mailbox: mb, folder, uidValidity: st.uidvalidity, m, receivedAt: new Date(ctx.now()).toISOString(),
    });
    let result;
    try {
      result = await emailIngestService.ingestEmail(db, source, envelope, null);
    } catch (err) {
      // Mirror routes/api.emailIngest.js: a pipeline throw still leaves an
      // execution row. Best effort; the folder then stops and retries.
      try {
        await db.query(
          `INSERT INTO email_ingest_executions (source_id, message_id, status, error, remote_ip)
           VALUES (?, ?, 'error', ?, NULL)`,
          [source.id, mid ? String(mid).slice(0, 255) : null, errText(err).slice(0, 1000)]
        );
      } catch (writeErr) {
        console.error('[mailboxIngest] failed to write error execution:', writeErr.code || '', writeErr.message);
      }
      throw err;
    }
    summary.emitted++;
    ctx.folderStats.emitted++;
    const status = (result && result.status) || 'unknown';
    summary.pipeline[status] = (summary.pipeline[status] || 0) + 1;
    let logId = result && result.logId ? Number(result.logId) : null;
    if (!logId && status === 'duplicate') logId = await recoverLogId(db, source.id, mid);
    if (logId) await stampLogId(db, rowId, logId);
  } else if (inserted && mid && source) {
    // Not emitted from here, but the same message may already be in the log
    // via another mailbox / folder of this source — bridge to it.
    const logId = await recoverLogId(db, source.id, mid);
    if (logId) await stampLogId(db, rowId, logId);
  }
  return inserted ? 'stored' : 'present';
}

/**
 * Process `uids` in the given order. `onBatch(last)` runs after each fully
 * processed batch (the caller advances + persists its cursor there, so a
 * crash replays at most one batch). Returns the last UID fully processed
 * (null if none). On failure, throws with err.progressUid set the same way,
 * so the caller can advance past the messages that did complete.
 */
async function processUids(ctx, session, mb, folder, cfg, st, uids, pass, onBatch) {
  const { db, summary } = ctx;
  let last = null;
  for (const batch of chunks(uids, batchSize())) {
    if (last != null) await onBatch(last);
    if (ctx.stop()) return { last, stopped: true };
    const have = await existingRows(db, mb.id, folder, batch);
    const emitting = cfg.emit_to_rules && ctx.source && ctx.source.active;
    const need = batch.filter(u => {
      const row = have.get(u);
      if (!row) return true;
      return pass === 'new' && emitting && row.log_id == null; // crash-window re-emit needs the body
    });
    const fetched = need.length ? await session.fetchMessages(need) : [];
    summary.fetched += fetched.length;
    ctx.folderStats.fetched += fetched.length;
    const byUid = new Map(fetched.map(m => [m.uid, m]));
    for (const uid of batch) {
      if (ctx.stop()) return { last, stopped: true };
      const row = have.get(uid);
      const m = byUid.get(uid);
      try {
        if (m) await processMessage(ctx, mb, folder, cfg, st, m, pass, row || null);
        // else: already stored (nothing to do) or expunged between SEARCH and FETCH
      } catch (err) {
        err.progressUid = last;
        throw err;
      }
      last = uid;
    }
  }
  return { last, stopped: false };
}

async function rekey(ctx, session, mb, folder, box, state) {
  const { db } = ctx;
  const prev = state[folder] || {};
  const current = await session.listMessageIds();
  const [stored] = await db.query(
    'SELECT id, uid, message_id FROM mail_messages WHERE mailbox_id = ? AND folder = ?',
    [mb.id, folder]
  );
  const plan = planRekey(stored, current);
  const maxUid = current.reduce((mx, c) => Math.max(mx, Number(c.uid) || 0), 0);
  const nowIso = new Date(ctx.now()).toISOString();
  const next = {
    ...prev,
    uidvalidity: box.uidValidity,
    last_uid: maxUid,
    backfill_uid: maxUid + 1,
    // Emit what was delivered after we last looked; with no trustworthy prior
    // cursor, store only.
    backfill_emit_after: (Number.isFinite(Number(prev.uidvalidity)) && prev.checked_at) ? prev.checked_at : null,
    rekeyed_at: nowIso,
  };
  delete next.backfill_done_at;
  const nextState = { ...state, [folder]: next };

  await withTransaction(db, async (conn) => {
    for (const part of chunks(plan.orphans, limits.idChunk)) {
      await conn.query('DELETE FROM mail_read_state WHERE message_fk IN (?)', [part]);
      await conn.query(
        'DELETE FROM mail_messages WHERE mailbox_id = ? AND folder = ? AND id IN (?)',
        [mb.id, folder, part]
      );
    }
    // Phase 1: park EVERY moving row before any final is written — a final
    // can equal another moving row's old UID (a swap), which the UNIQUE key
    // would refuse.
    for (const part of chunks(plan.moving.map(r => r.id), limits.idChunk)) {
      await conn.query(
        'UPDATE mail_messages SET uid = NULL WHERE mailbox_id = ? AND folder = ? AND id IN (?)',
        [mb.id, folder, part]
      );
    }
    // Phase 2: finals. Free by construction: every remaining non-NULL UID
    // belongs to a row whose UID did not change, and each final is a
    // distinct server UID matched to exactly one row.
    for (const part of chunks(plan.moving, limits.idChunk)) {
      const cases = part.map(() => 'WHEN ? THEN ?').join(' ');
      await conn.query(
        `UPDATE mail_messages SET uid = CASE id ${cases} END
          WHERE mailbox_id = ? AND folder = ? AND id IN (?)`,
        [...part.flatMap(r => [r.id, r.newUid]), mb.id, folder, part.map(r => r.id)]
      );
    }
    await conn.query(
      'UPDATE mailboxes SET ingest_state = ?, updated_at = updated_at WHERE id = ?',
      [JSON.stringify(nextState), mb.id]
    );
  }, { retries: 1 }); // pure DB — safe to retry once on a dead borrowed connection

  state[folder] = next;
  ctx.summary.rekeyed++;
  ctx.folderStats.rekey = {
    remapped: plan.remap.length, moved: plan.moving.length,
    orphans: plan.orphans.length, unmatched: plan.unmatchedUids.length,
  };
  console.log(`[mailboxIngest] mailbox ${mb.id} ${JSON.stringify(folder)}: re-keyed to UIDVALIDITY ${box.uidValidity}` +
    ` (remapped ${plan.remap.length}, moved ${plan.moving.length}, orphans ${plan.orphans.length},` +
    ` left for backfill ${plan.unmatchedUids.length})`);
}

async function newPass(ctx, session, mb, folder, cfg, state) {
  const { db } = ctx;
  const openedAt = new Date(ctx.now()).toISOString();
  const box = await session.openFolder(folder);
  let st = state[folder];
  const hasCursor = !!st && Number.isFinite(Number(st.uidvalidity)) && st.uidvalidity !== null;

  if (!hasCursor || Number(st.uidvalidity) !== box.uidValidity) {
    const [[cnt]] = await db.query(
      'SELECT COUNT(*) AS n FROM mail_messages WHERE mailbox_id = ? AND folder = ?', [mb.id, folder]
    );
    if (hasCursor || Number(cnt.n) > 0) {
      await rekey(ctx, session, mb, folder, box, state);
    } else {
      // First sight of this folder: new mail starts at UIDNEXT; what is
      // already here is backlog (stored, never emitted). Written BEFORE any
      // processing — a crash must not let the next run re-baseline later and
      // misfile mail that arrived in between as backlog.
      let uidNext = box.uidNext;
      if (!uidNext) {
        const all = await session.searchUids(1);
        uidNext = (all.length ? all[all.length - 1] : 0) + 1;
      }
      state[folder] = {
        ...(st || {}),
        uidvalidity: box.uidValidity,
        last_uid: uidNext - 1,
        backfill_uid: uidNext,
        backfill_emit_after: null,
      };
      await writeState(db, mb.id, state);
    }
    st = state[folder];
  }

  const lastUid = Number(st.last_uid) || 0;
  if (box.uidNext != null && box.uidNext <= lastUid + 1) return { stopped: false, openedAt };
  const uids = await session.searchUids(lastUid + 1);
  if (!uids.length) return { stopped: false, openedAt };
  const onBatch = async (last) => {
    st.last_uid = Math.max(Number(st.last_uid) || 0, last);
    await writeState(db, mb.id, state);
  };
  try {
    const r = await processUids(ctx, session, mb, folder, cfg, st, uids, 'new', onBatch);
    if (r.last != null) st.last_uid = Math.max(Number(st.last_uid) || 0, r.last);
    return { stopped: r.stopped, openedAt };
  } catch (err) {
    if (err.progressUid != null) st.last_uid = Math.max(Number(st.last_uid) || 0, err.progressUid);
    throw err;
  }
}

async function backfillPass(ctx, session, mb, folder, cfg, state) {
  const st = state[folder];
  if (!backfillPending(st)) return { stopped: false };
  const box = await session.openFolder(folder);
  // Changed under us since phase 1 — the next new pass re-keys first.
  if (box.uidValidity !== Number(st.uidvalidity)) return { stopped: false };
  const uids = (await session.searchUids(1, Number(st.backfill_uid) - 1)).sort((a, b) => b - a);
  const finish = () => {
    delete st.backfill_uid;
    delete st.backfill_emit_after;
    st.backfill_done_at = new Date(ctx.now()).toISOString();
  };
  if (!uids.length) { finish(); return { stopped: false }; }
  const onBatch = async (last) => {
    st.backfill_uid = last;
    await writeState(ctx.db, mb.id, state);
  };
  try {
    const r = await processUids(ctx, session, mb, folder, cfg, st, uids, 'backfill', onBatch);
    if (r.last != null) st.backfill_uid = r.last;
    if (!r.stopped) finish();
    return { stopped: r.stopped };
  } catch (err) {
    if (err.progressUid != null) st.backfill_uid = err.progressUid;
    throw err;
  }
}

async function runMailbox(ctx, mb, phase) {
  const { db, summary } = ctx;
  const folders = folderConfig(mb.ingest_folders);
  const state = mb._state;
  const targets = phase === 'new' ? folders : folders.filter(([f]) => backfillPending(state[f]));
  if (!targets.length) return;
  if (phase === 'new') summary.mailboxes++;

  const alerts = [];
  const record = (folder, err) => {
    summary.errors++;
    const n = markError(state, folder, phase, err, new Date(ctx.now()).toISOString());
    if (n === limits.alertAfter) alerts.push({ folder, phase, n, error: errText(err) });
  };

  const settled = new Set(); // folders whose outcome is recorded AND persisted this phase
  try {
    await transport.withMailbox(mb, async (session) => {
      for (const [folder, cfg] of targets) {
        if (phase === 'new') summary.folders++;
        ctx.folderStats = { mailbox_id: mb.id, folder, phase, outcome: 'ok', fetched: 0, stored: 0, backfilled: 0, emitted: 0, duplicates: 0 };
        summary.details.push(ctx.folderStats);
        if (ctx.stop()) { summary.skippedBudget++; ctx.folderStats.outcome = 'not_reached'; settled.add(folder); continue; }
        try {
          const r = phase === 'new'
            ? await newPass(ctx, session, mb, folder, cfg, state)
            : await backfillPass(ctx, session, mb, folder, cfg, state);
          if (r.stopped) { summary.skippedBudget++; ctx.folderStats.outcome = 'budget'; }
          markOk(state, folder, phase, r.stopped ? null : r.openedAt);
        } catch (err) {
          ctx.folderStats.outcome = 'error';
          ctx.folderStats.error = errText(err);
          console.warn(`[mailboxIngest] mailbox ${mb.id} ${JSON.stringify(folder)} ${phase}: ${errText(err)}`);
          record(folder, err);
        }
        await writeState(db, mb.id, state);
        settled.add(folder);
      }
    });
  } catch (err) {
    // Connect / login / decrypt failure (nothing ran), or a state write
    // failed mid-loop (the DB itself): every folder not yet settled failed.
    mb._failed = true;
    console.warn(`[mailboxIngest] mailbox ${mb.id} ${phase}: ${errText(err)}`);
    for (const [folder] of targets) {
      if (settled.has(folder)) continue;
      const d = summary.details.find(x => x.mailbox_id === mb.id && x.folder === folder && x.phase === phase);
      if (d) {
        if (d.outcome !== 'error') { d.outcome = 'error'; d.error = errText(err); record(folder, err); }
      } else {
        summary.details.push({ mailbox_id: mb.id, folder, phase, outcome: 'error', error: errText(err) });
        if (phase === 'new') summary.folders++;
        record(folder, err);
      }
    }
    try { await writeState(db, mb.id, state); } catch (wErr) {
      console.error(`[mailboxIngest] mailbox ${mb.id}: could not persist ingest_state:`, wErr.code || '', wErr.message);
    }
  }

  if (alerts.length) {
    await sendAlert(db, {
      kind: 'mailbox_ingest_failing',
      group_key: `app:mailbox_ingest_failing:${mb.id}`,
      severity: 'warning', // degraded, not down (FreeBusy fail-open precedent)
      title: `Mailbox ingest failing: ${mb.address}`,
      message: alerts.map(a => `${a.folder} (${a.phase}): ${a.n} consecutive failed runs — ${a.error}`).join('\n'),
      context: { mailbox_id: mb.id, folders: alerts },
      ref_table: 'mailboxes',
      ref_id: mb.id,
    });
  }
}

/**
 * One poll pass. Never throws for a mailbox/folder problem (those are
 * recorded in ingest_state and the summary); throws only if the lock
 * connection or the mailbox list cannot be read at all.
 *
 * @param {object} db  mysql2 promise pool (needs getConnection)
 * @param {{budgetMs?:number, now?:() => number}} [opts]
 */
async function runIngest(db, opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const started = now();
  const summary = newSummary();
  const lock = await acquireLock(db);
  if (!lock) {
    return { ...summary, skipped: true, reason: 'another ingest run holds the lock', durationMs: now() - started };
  }
  const deadline = started + resolveBudgetMs(opts.budgetMs);
  try {
    const source = await loadSource(db);
    const mailboxes = await listIngestMailboxes(db);
    for (const mb of mailboxes) mb._state = parseJson(mb.ingest_state) || {};

    const wantsEmit = mailboxes.some(mb => folderConfig(mb.ingest_folders).some(([, c]) => c.emit_to_rules));
    if (!source) summary.emitDisabled = 'source_missing';
    else if (!source.active) summary.emitDisabled = 'source_inactive';
    if (!source && wantsEmit) {
      // The S1 migration registers the source; missing = it was not run (or
      // the row was deleted). Mail is still stored; nothing reaches the log.
      await sendAlert(db, {
        kind: 'mailbox_ingest_source_missing',
        group_key: 'app:mailbox_ingest_source_missing',
        dedup_key: `mailbox_ingest_source_missing:${new Date(started).toISOString().slice(0, 10)}`,
        severity: 'warning',
        title: `Mailbox ingest: email_ingest_sources row '${SOURCE_NAME}' is missing`,
        message: 'Folders set to Emit to rules are being stored but NOT emitted into the rules pipeline. Run the S1 migration.',
      });
    }

    const ctx = {
      db, source, summary, now,
      folderStats: null,
      stop: () => now() >= deadline || lock.lost(),
    };

    for (const phase of ['new', 'backfill']) {
      for (const mb of mailboxes) {
        if (phase === 'backfill' && mb._failed) continue;
        if (ctx.stop()) {
          if (phase === 'new' || folderConfig(mb.ingest_folders).some(([f]) => backfillPending(mb._state[f]))) {
            summary.skippedBudget++;
          }
          continue;
        }
        try {
          await runMailbox(ctx, mb, phase);
        } catch (err) {
          // runMailbox records its own failures; this is a last resort.
          summary.errors++;
          console.error(`[mailboxIngest] mailbox ${mb.id} ${phase}: unexpected:`, errText(err));
        }
      }
    }
  } finally {
    summary.lockLost = lock.lost();
    await lock.release();
  }
  if (summary.lockLost) {
    await sendAlert(db, {
      kind: 'mailbox_ingest_lock_lost',
      group_key: 'app:mailbox_ingest_lock_lost',
      severity: 'warning',
      title: 'Mailbox ingest lost its run lock mid-run',
      message: 'The lock connection stopped answering (or the lock was no longer ours); the run stopped early. ' +
        'Idempotent by design — the next tick resumes from the stored cursors.',
    });
  }
  summary.durationMs = now() - started;
  return summary;
}

module.exports = {
  runIngest,
  loadConnectionRow,
  // exported for tests
  planRekey,
  buildRow,
  buildEnvelope,
  htmlToText,
  parseHeaderBlock,
  folderConfig,
  effectiveDate,
  acquireLock,
  limits,
  SOURCE_NAME,
  LOCK_EXPR,
};
