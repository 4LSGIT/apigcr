// services/mailbox/mailAttachmentService.js
//
/**
 * MAIL ATTACHMENTS AS BYTES — for automations, not for a browser.
 *
 * The mailbox store keeps attachment STRUCTURE only (design D1:
 * mail_messages.attachments = [{part, filename, size, mime, cid?}]); the bytes
 * stay on the mail server and come over IMAP on demand. The browser path for
 * that is GET /api/mailboxes/:id/messages/:mid/parts/:part, which streams one
 * part to a grant-checked user. This module is the SERVER path: the same
 * identity-guarded fetch, buffered, for code that files attachments
 * (services/emailAttachmentFilingService.js). Nothing here is
 * provider-specific — any IMAP mailbox (Gmail today, Migadu tomorrow) works.
 * Design: ref/EMAIL_ATTACHMENTS_DESIGN.md §2.
 *
 *   resolveMessage(db, ref)          → the stored mail_messages row, or null
 *   fileableParts(row, opts)         → which parts are documents worth filing
 *   fetchPartBuffer(db, row, part)   → { buffer, mime } — throws coded errors
 *
 * ── THE IDENTITY GUARD IS imapTransport.fetchPart's ─────────────────────────
 * fetchPart refuses (UIDVALIDITY_MISMATCH / MESSAGE_MISMATCH) unless the
 * server's message at that UID is provably the stored one — serving one
 * client's PDF as another's is the failure it exists to make impossible. This
 * module adds only what the route adds around it: the folder's ingest cursor
 * must hold a UIDVALIDITY, and the row must have a UID (a re-key parks rows at
 * NULL). The route is deliberately NOT refactored onto this module: it streams
 * to the client with its own response mapping, and the guard that matters is
 * the transport's, which both share.
 *
 * ── ERRORS (err.code) ───────────────────────────────────────────────────────
 *   BAD_REF          the reference names no message
 *   MAILBOX_GONE     the message's mailbox row is gone
 *   RESYNC_PENDING   no UID / no cursor / UIDVALIDITY or Message-ID mismatch —
 *                    the next ingest run fixes it; retry later
 *   PART_GONE        the server no longer has the message or part (deleted in
 *                    webmail / a mail client — the D1 caveat)
 *   TOO_LARGE        the part's bytes exceeded maxBytes (the stream is aborted)
 *   anything else    a transport failure (sanitized by imapTransport)
 */

'use strict';

// Lazy requires (convention): mailboxIngestService → emailIngestService →
// emailIngestRuleService → actionDispatchers → internal_functions, which loads
// the function that loads THIS module. A module-scope require here would read
// a half-built export in production load order.
const ingest = () => require('./mailboxIngestService');
const transport = () => require('./imapTransport');
const reads = () => require('./mailReadService');

/** Default per-file cap on DECODED bytes. Under docReq's 50 MB, inside a 1 GiB instance. */
const DEFAULT_MAX_BYTES = 40 * 1024 * 1024;

/**
 * Inline (cid-referenced) images below this many decoded bytes are signature
 * logos and social icons, never filed. NOT markInline alone: Apple Mail sends a
 * photographed document as a cid-referenced inline image (mail_messages 3206 —
 * a 6.7 MB photo of a mortgage statement), and those are the point.
 */
const INLINE_LOGO_MAX_BYTES = 20 * 1024;

/**
 * IMAP reports the ENCODED part size (base64 ≈ 4/3 of the file —
 * imapTransport header). Estimates only; the real cap is enforced on bytes.
 */
const DECODED_RATIO = 0.74;

const PART_ID_RE = /^\d{1,4}(?:\.\d{1,4}){0,15}$/;

/**
 * The extension allowlist is the client-upload one (portalDocsService), so an
 * emailed document and an uploaded one are filed by the same rule.
 */
function allowedExtensions() {
  return require('../portalDocsService').ALLOWED_EXTENSIONS;   // lazy (convention)
}

/** Extension to give a part that arrived without one, by MIME type. */
const EXT_BY_MIME = Object.freeze({
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/pjpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/gif': 'gif',
  'image/tiff': 'tif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/csv': 'csv',
  'text/plain': 'txt',
  'application/rtf': 'rtf',
  'text/rtf': 'rtf',
});

function codedError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code }, extra);
}

function parseJson(v) {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (_) { return null; }
}

function stripBrackets(id) {
  return String(id == null ? '' : id).trim().replace(/^<|>$/g, '');
}

const MESSAGE_COLS =
  'id, mailbox_id, folder, uid, message_id, provider_id, from_addr, to_addrs, cc_addrs, subject, date, body_text, body_html, attachments, log_id';

// ─────────────────────────────────────────────────────────────────────────────
// resolveMessage
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The stored message a reference names. Three forms, most specific first:
 *   { mail_message_id }             mail_messages.id — the worker's envelope
 *                                   carries it as mailbox.message_row_id
 *   { mailbox_id, folder, uid }     the envelope's mailbox block (any envelope
 *                                   the worker emitted, before or after S1)
 *   { source, message_id }          the ingest dedupe identity
 *                                   (envelope.source + headers.message_id):
 *                                   the mailbox(es) emitting under that source,
 *                                   keyed the way they emit — provider id or
 *                                   RFC Message-ID (mailboxIngestService
 *                                   emissionConfig). The only form an Apps
 *                                   Script envelope can resolve through.
 * @returns {Promise<object|null>} the row (attachments parsed), or null
 * @throws BAD_REF when no usable form is given
 */
async function resolveMessage(db, ref = {}) {
  const r = ref || {};
  let rows;
  if (r.mail_message_id != null && r.mail_message_id !== '') {
    const id = Number(r.mail_message_id);
    if (!Number.isInteger(id) || id <= 0) throw codedError('BAD_REF', `mail_message_id must be a positive integer (got ${JSON.stringify(r.mail_message_id)})`);
    [rows] = await db.query(`SELECT ${MESSAGE_COLS} FROM mail_messages WHERE id = ? LIMIT 1`, [id]);
  } else if (r.mailbox_id != null && r.folder && r.uid != null) {
    const mb = Number(r.mailbox_id);
    const uid = Number(r.uid);
    if (!Number.isInteger(mb) || mb <= 0 || !Number.isInteger(uid) || uid <= 0) {
      throw codedError('BAD_REF', 'mailbox_id and uid must be positive integers');
    }
    [rows] = await db.query(
      `SELECT ${MESSAGE_COLS} FROM mail_messages WHERE mailbox_id = ? AND folder = ? AND uid = ? LIMIT 1`,
      [mb, String(r.folder), uid]
    );
  } else if (r.source && r.message_id) {
    const source = String(r.source).toLowerCase();
    const key = stripBrackets(r.message_id);
    if (!key) throw codedError('BAD_REF', 'message_id is empty');
    const [boxes] = await db.query('SELECT id, emit_source_name, emit_id_kind FROM mailboxes WHERE alias_of IS NULL');
    const provider = [];
    const rfc = [];
    for (const b of boxes) {
      const c = ingest().emissionConfig(b);
      if (c.misconfig || String(c.sourceName).toLowerCase() !== source) continue;
      (c.kind === 'provider' ? provider : rfc).push(Number(b.id));
    }
    rows = [];
    if (provider.length) {
      [rows] = await db.query(
        `SELECT ${MESSAGE_COLS} FROM mail_messages WHERE mailbox_id IN (?) AND provider_id = ? ORDER BY id ASC LIMIT 1`,
        [provider, key.toLowerCase()]
      );
    }
    if (!rows.length && rfc.length) {
      [rows] = await db.query(
        `SELECT ${MESSAGE_COLS} FROM mail_messages WHERE mailbox_id IN (?) AND message_id = ? ORDER BY id ASC LIMIT 1`,
        [rfc, key]
      );
    }
  } else {
    throw codedError('BAD_REF', 'give mail_message_id, or mailbox_id + folder + uid, or source + message_id');
  }
  const row = rows && rows[0];
  if (!row) return null;
  return { ...row, attachments: parseJson(row.attachments) || [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// fileableParts
// ─────────────────────────────────────────────────────────────────────────────

function extOf(name) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

/**
 * Which attachment parts are documents to file. Pure.
 *
 * Kept: a part whose filename extension is on the client-upload allowlist —
 * or, with NO extension, whose MIME type maps to one (the name gets it
 * appended). The NAME decides when it has an extension: "x.pdf.exe" is an
 * .exe whatever its MIME type says.
 * Skipped, with a reason the notice lists:
 *   inline_image      cid-referenced inline image under INLINE_LOGO_MAX_BYTES
 *   type_not_allowed  extension (or MIME type) not on the allowlist —
 *                     attached emails, calendar invites, archives, .exe …
 *   too_large         estimated decoded size over maxBytes
 *
 * @param {object} row   resolveMessage() row (attachments parsed, body_html)
 * @returns {{files: Array<{part, filename, mime, ext, est_bytes, inline}>,
 *            skipped: Array<{part, filename, reason}>}}
 */
function fileableParts(row, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const parts = (Array.isArray(row && row.attachments) ? row.attachments : [])
    .filter(p => p && p.part != null && PART_ID_RE.test(String(p.part)));
  const marked = reads().markInline(parts, row && row.body_html);
  const allowed = allowedExtensions();
  const files = [];
  const skipped = [];
  for (const p of marked) {
    const part = String(p.part);
    const mime = String(p.mime || '').toLowerCase();
    const est = Math.round((Number(p.size) || 0) * DECODED_RATIO);
    let filename = String(p.filename || '').trim();
    let ext = extOf(filename);
    if (!ext && EXT_BY_MIME[mime]) {
      ext = EXT_BY_MIME[mime];
      filename = `${filename || `attachment-${part}`}.${ext}`;
    }
    const shown = filename || `attachment-${part}`;
    if (p.inline && est < INLINE_LOGO_MAX_BYTES) { skipped.push({ part, filename: shown, reason: 'inline_image' }); continue; }
    if (!ext || !allowed.has(ext)) { skipped.push({ part, filename: shown, reason: 'type_not_allowed' }); continue; }
    if (est > maxBytes) { skipped.push({ part, filename: shown, reason: 'too_large' }); continue; }
    files.push({ part, filename, mime, ext, est_bytes: est, inline: !!p.inline });
  }
  return { files, skipped };
}

// ─────────────────────────────────────────────────────────────────────────────
// fetchPartBuffer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One part's bytes, through imapTransport.fetchPart's identity guard.
 * A request-scoped IMAP connection, like the browser route's.
 *
 * @param {object} db
 * @param {object} row       resolveMessage() row
 * @param {string} part      IMAP body part id (must be on the row)
 * @param {object} [o]
 * @param {number} [o.maxBytes=DEFAULT_MAX_BYTES]
 * @returns {Promise<{buffer: Buffer, mime: string|null}>}
 * @throws coded errors — see header
 */
async function fetchPartBuffer(db, row, part, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!row || !PART_ID_RE.test(String(part))) throw codedError('BAD_REF', `bad part id ${JSON.stringify(part)}`);
  const atts = Array.isArray(row.attachments) ? row.attachments : (parseJson(row.attachments) || []);
  if (!atts.some(a => a && String(a.part) === String(part))) {
    throw codedError('BAD_REF', `part ${part} is not an attachment of message ${row.id}`);
  }
  const conn = await ingest().loadConnectionRow(db, row.mailbox_id);
  if (!conn) throw codedError('MAILBOX_GONE', `mailbox ${row.mailbox_id} no longer exists`);
  const cursor = (parseJson(conn.ingest_state) || {})[row.folder];
  if (row.uid == null || !cursor || cursor.uidvalidity == null) {
    throw codedError('RESYNC_PENDING', 'the mailbox is re-syncing this folder — retry after the next ingest run');
  }

  let got;
  try {
    got = await transport().fetchPart(conn, row.folder, row.uid, String(part), {
      uidValidity: cursor.uidvalidity,
      messageId: row.message_id,
    });
  } catch (err) {
    if (err && (err.code === 'UIDVALIDITY_MISMATCH' || err.code === 'MESSAGE_MISMATCH')) {
      throw codedError('RESYNC_PENDING', err.message, { cause: err });
    }
    throw err;
  }
  if (!got) throw codedError('PART_GONE', 'the message is no longer on the mail server (deleted in webmail or a mail client)');

  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of got.stream) {
      total += chunk.length;
      if (total > maxBytes) {
        throw codedError('TOO_LARGE', `part ${part} is larger than ${Math.round(maxBytes / 1048576)} MB`);
      }
      chunks.push(chunk);
    }
  } finally {
    try { got.close(); } catch (_) { /* best effort */ }
  }
  return { buffer: Buffer.concat(chunks, total), mime: got.mime || null };
}

module.exports = {
  resolveMessage,
  fileableParts,
  fetchPartBuffer,
  DEFAULT_MAX_BYTES,
  INLINE_LOGO_MAX_BYTES,
  EXT_BY_MIME,
  // exported for tests
  _extOf: extOf,
};
