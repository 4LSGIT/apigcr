// services/mailbox/imapTransport.js
//
/**
 * IMAP transport — mailbox-system arc, slice S1
 * services/mailbox/imapTransport.js
 *
 * THE ONE MODULE THAT OWNS IMAP (ref/MAILBOX_SYSTEM_DESIGN.md §2). Nothing else
 * in the tree requires `imapflow`. It is provider-blind (D2): host, port and
 * login come from the `mailboxes` row, never from constants, and nothing here
 * knows whether the far end is SiteGround, Gmail or Migadu.
 *
 * Two consumers, two shapes:
 *   withMailbox(row, fn)   the ingest worker. Connects, hands `fn` a narrow
 *                          SESSION facade (openFolder / searchUids /
 *                          listMessageIds / fetchMessages), and logs out in
 *                          `finally` whatever happens.
 *   fetchPart(row, …)      the on-demand attachment route. Request-scoped
 *                          connection that closes when the returned stream
 *                          ends, errors or is destroyed.
 *   listFolders(row)       the SU folder listing (S1-G): every folder with its
 *                          special-use flag and STATUS counts, plus whether
 *                          the server will hand us provider ids. Read-only.
 *
 * ── NO PROCESS-GLOBAL STATE (design §2, tenancy audit A3/P0-5) ───────────────
 * No module-scope caches, no pooled or reused connections. A connection lives
 * inside one ingest run or one HTTP request and is always closed.
 *
 * ── THE SECRET NEVER LEAVES THIS MODULE ──────────────────────────────────────
 * `imap_secret` arrives as ENCv1 ciphertext (lib/credentialCrypto, the S0 write
 * path) and is decrypted here, into a local that is passed to ImapFlow's
 * `auth` and nowhere else. It is never logged, never returned and never put in
 * an error message:
 *   - imapflow's own logger is OFF (`logger:false`, no raw/emitted logs).
 *   - every error that crosses this module's boundary is REBUILT by
 *     sanitizeError(): a fresh Error carrying a whitelisted code + message,
 *     with the secret (and its SASL-PLAIN / base64 encodings) scrubbed as a
 *     second line of defense. The original error object — whose `response`
 *     carries raw protocol state — never escapes, so a caller that logs `err`
 *     whole still cannot print a credential.
 *   - an 'error' listener is attached BEFORE connect(). ImapFlow is an
 *     EventEmitter; an unlistened 'error' after connect becomes an
 *     uncaughtException, which server.js turns into process.exit(1).
 *
 * ── READ-ONLY, ALWAYS ────────────────────────────────────────────────────────
 * Folders are opened with EXAMINE (`readOnly:true`), so the server can never
 * set \Seen or clear \Recent on our account — staff still read this mail in
 * Outlook / Apple Mail (design §4.3: v1 never writes flags back). Nothing in
 * this module issues STORE, APPEND, COPY, MOVE or EXPUNGE. S3's Sent APPEND
 * will be the first writer and arrives as its own reviewed function.
 *
 * ── TLS, ALWAYS ──────────────────────────────────────────────────────────────
 * Port 143 → STARTTLS, mandatory (`doSTARTTLS:true` refuses a server that does
 * not offer it). Every other port → implicit TLS. There is no cleartext mode
 * and no way to turn off certificate verification from a row.
 *
 * ── PROVIDER-NATIVE IDS (S1-G) ───────────────────────────────────────────────
 * Gmail's X-GM-MSGID is a 64-bit unsigned decimal whose lowercase hex is the
 * id the Gmail web UI, the Gmail API and Apps Script GmailMessage.getId() use
 * (developers.google.com/workspace/gmail/imap/imap-extensions) — the id the
 * `gmail-firm` source has keyed email_log on since 2025. imapflow 2.3.0 adds
 * X-GM-MSGID to EVERY fetch when the server advertises X-GM-EXT-1 and surfaces
 * it as `emailId` — UNLESS the server also advertises OBJECTID, in which case
 * it asks for RFC 8474 EMAILID instead and `emailId` is an opaque objectid,
 * not a Gmail id (tests/mailboxS1G.transport.test.js pins both). So a message
 * carries `providerId` (hex) only on X-GM-EXT-1 without OBJECTID and only when
 * the value is a decimal 64-bit integer; everywhere else it is null, and the
 * worker never emits a provider-keyed message without one. The transport
 * still never asks which provider it is talking to — it reads capabilities.
 *
 * ── ATTACHMENTS ARE NOT DOWNLOADED (D1) ──────────────────────────────────────
 * fetchMessages() reads ENVELOPE, BODYSTRUCTURE, flags, size, internal date,
 * the header block and the TEXT parts only (first text/plain + first
 * text/html, each capped). Every other leaf part is described in
 * `attachments` ([{part, filename, size, mime, cid?}]) and streamed later, on
 * demand, by fetchPart(). `size` there is the server's ENCODED size (base64 ≈
 * 4/3 of the file) — the only size known without downloading.
 */

'use strict';

const { ImapFlow } = require('imapflow');
const { decrypt } = require('../../lib/credentialCrypto');

/** Knobs, read at call time (tests shrink them). */
const limits = {
  // Messages per fetchMessages() call is the CALLER's batch; this caps one
  // body part. Matches the Apps Script adapter's maxBodyBytes (ref/gas.js).
  maxBodyBytes: 1024 * 1024,
  connectionTimeoutMs: 20_000,
  greetingTimeoutMs: 15_000,
  socketTimeoutMs: 120_000,
  // Heap guards against a broken/hostile server announcing a huge literal.
  // Attachment streaming uses partial fetches (imapflow chunkSize 64 KiB) so
  // these never cap a download.
  maxLiteralSize: 64 * 1024 * 1024,
  maxResponseSize: 96 * 1024 * 1024,
  maxHeaderBlockBytes: 256 * 1024,
};

// Socket-level codes worth a quiet retry next tick (the worker decides; this
// only classifies).
const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH',
  'EAI_AGAIN', 'CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT', 'ETIMEOUT',
  'NoConnection', 'EConnectionClosed', 'ETHROTTLE',
]);

const FLAG_MAP = { '\\seen': 'seen', '\\answered': 'answered', '\\flagged': 'flagged', '\\draft': 'draft' };

const MAX_U64 = (1n << 64n) - 1n;

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

function typedError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.imap = true;
  Object.assign(err, extra);
  return err;
}

/** Every literal form a credential can take on the wire or in a message. */
function secretForms(secret, user) {
  if (!secret) return [];
  const forms = new Set([secret]);
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  forms.add(b64(secret));
  forms.add(b64(`\u0000${user || ''}\u0000${secret}`));          // SASL PLAIN, no authzid
  forms.add(b64(`${user || ''}\u0000${user || ''}\u0000${secret}`)); // SASL PLAIN, authzid = user
  forms.add(JSON.stringify(secret).slice(1, -1));                    // quoted-string escaping
  return [...forms].filter(f => f && f.length);
}

function scrub(text, secret, user) {
  let out = String(text == null ? '' : text);
  // Longest first, so a base64 form is removed whole before the raw secret
  // could split it.
  for (const f of secretForms(secret, user).sort((a, b) => b.length - a.length)) {
    out = out.split(f).join('[REDACTED]');
  }
  return out;
}

/**
 * Rebuild an imapflow / socket / TLS error as a fresh Error carrying only
 * whitelisted, scrubbed text. Already-sanitized errors pass through.
 */
function sanitizeError(err, { secret, user } = {}) {
  if (err && err.imap === true && err.sanitized === true) return err;
  const e = err || {};
  const code = e.code
    || (e.authenticationFailed ? 'AUTHENTICATIONFAILED' : null)
    || (e.serverResponseCode ? String(e.serverResponseCode) : null)
    || 'IMAP_ERROR';
  let msg = String(e.message || 'IMAP error');
  if (e.serverResponseCode && !msg.includes(e.serverResponseCode)) msg += ` [${e.serverResponseCode}]`;
  if (e.responseText && !msg.includes(e.responseText)) msg += ` ${e.responseText}`;
  msg = scrub(msg, secret, user).replace(/\s+/g, ' ').trim().slice(0, 280);
  return typedError(String(code).slice(0, 64), `IMAP ${code}: ${msg}`, {
    sanitized: true,
    authFailed: !!e.authenticationFailed,
    transient: TRANSIENT_CODES.has(code),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection
// ─────────────────────────────────────────────────────────────────────────────

function decryptSecret(row) {
  const enc = row && row.imap_secret;
  if (enc == null || enc === '') {
    throw typedError('NO_SECRET', 'mailbox has no IMAP secret set', { sanitized: true });
  }
  try {
    return decrypt(String(enc));
  } catch (_) {
    // decrypt() messages carry no plaintext, but nothing of it is needed here.
    throw typedError('DECRYPT_FAILED', 'IMAP secret could not be decrypted (wrong key or corrupt value)', { sanitized: true });
  }
}

function clientOptions(row, secret) {
  const port = Number(row.imap_port) || 993;
  const starttls = port === 143;
  return {
    host: String(row.imap_host),
    port,
    secure: !starttls,
    doSTARTTLS: starttls ? true : undefined,
    auth: { user: String(row.imap_user), pass: secret },
    tls: { minVersion: 'TLSv1.2' },
    logger: false,
    logRaw: false,
    emitLogs: false,
    disableAutoIdle: true,
    connectionTimeout: limits.connectionTimeoutMs,
    greetingTimeout: limits.greetingTimeoutMs,
    socketTimeout: limits.socketTimeoutMs,
    maxLiteralSize: limits.maxLiteralSize,
    maxResponseSize: limits.maxResponseSize,
  };
}

/** Exported so tests can swap the constructor (ImapFlow needs a live server). */
const factory = { create: (opts) => new ImapFlow(opts) };

function makeClient(row, secret) {
  const client = factory.create(clientOptions(row, secret));
  // MUST be attached before connect() — see header. Code only: the message
  // of a post-connect socket error carries no credential, but nothing here
  // needs more than the code.
  client.on('error', (err) => {
    console.warn(`[imapTransport] mailbox ${row.id} connection error: ${(err && err.code) || 'unknown'}`);
  });
  return client;
}

async function closeClient(client) {
  try {
    await client.logout();
  } catch (_) {
    try { client.close(); } catch (_) { /* already gone */ }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Message shaping
// ─────────────────────────────────────────────────────────────────────────────

/** "<a@b>" → "a@b"; blank → null. Same rule as emailIngestService._resolveMessageId. */
function normalizeMessageId(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(/^<+/, '').replace(/>+$/, '').trim();
  return s || null;
}

/**
 * Which provider id this connection yields: 'gmail' (X-GM-MSGID) or null.
 * Read from the live capability set after login — see PROVIDER-NATIVE IDS.
 */
function providerIdKind(client) {
  const caps = client && client.capabilities;
  if (!caps || typeof caps.has !== 'function') return null;
  return caps.has('X-GM-EXT-1') && !caps.has('OBJECTID') ? 'gmail' : null;
}

/** X-GM-MSGID (decimal string) → lowercase hex; anything else → null. */
function gmailHexId(v) {
  const s = v == null ? '' : String(v).trim();
  if (!/^\d{1,20}$/.test(s)) return null;
  const n = BigInt(s);
  if (n <= 0n || n > MAX_U64) return null;
  return n.toString(16);
}

function mapFlags(set) {
  const out = [];
  for (const f of set || []) {
    const m = FLAG_MAP[String(f).toLowerCase()];
    if (m && !out.includes(m)) out.push(m);
  }
  return out;
}

function addrList(list) {
  if (!Array.isArray(list)) return [];
  return list.map(a => ({ name: a && a.name ? String(a.name) : '', address: a && a.address ? String(a.address) : '' }));
}

function toDate(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Walk a BODYSTRUCTURE. Picks the first non-attachment text/plain and
 * text/html leaves as the body; every other leaf (and every message/rfc822,
 * which is NOT descended into — a forwarded mail's text is not this mail's
 * body) is an attachment. A single-part message has no `part` on its root;
 * IMAP calls that part "1".
 *
 * @returns {{ textPart: string|null, htmlPart: string|null,
 *             attachments: Array<{part, filename, size, mime, cid?}> }}
 */
function analyzeStructure(root) {
  const out = { textPart: null, htmlPart: null, attachments: [] };
  if (!root || typeof root !== 'object') return out;

  const visit = (node, isRoot) => {
    const type = String(node.type || 'application/octet-stream').toLowerCase();
    const part = node.part ? String(node.part) : (isRoot ? '1' : null);
    if (type.startsWith('multipart/')) {
      for (const child of node.childNodes || []) visit(child, false);
      return;
    }
    if (!part) return; // a leaf without an addressable id cannot be fetched later
    const disp = String(node.disposition || '').toLowerCase();
    const dp = node.dispositionParameters || {};
    const p = node.parameters || {};
    const filename = dp.filename || p.name || null;
    const isAttachment = disp === 'attachment' || !!filename;

    if (type !== 'message/rfc822' && !isAttachment) {
      if (type === 'text/plain' && !out.textPart) { out.textPart = part; return; }
      if (type === 'text/html' && !out.htmlPart) { out.htmlPart = part; return; }
    }
    const entry = {
      part,
      filename: filename ? String(filename).slice(0, 255) : null,
      size: Number.isFinite(Number(node.size)) ? Number(node.size) : null,
      mime: type,
    };
    if (node.id) entry.cid = String(node.id).replace(/^<|>$/g, '');
    out.attachments.push(entry);
  };
  visit(root, true);
  return out;
}

async function readStream(stream, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    chunks.push(buf);
  }
  const all = Buffer.concat(chunks);
  return { text: all.toString('utf8'), truncated: maxBytes != null && total >= maxBytes };
}

// ─────────────────────────────────────────────────────────────────────────────
// Session facade (the worker's whole view of IMAP)
// ─────────────────────────────────────────────────────────────────────────────

function makeSession(client, row, secret) {
  const user = row.imap_user;
  const idKind = providerIdKind(client);
  const providerIdOf = (m) => (idKind === 'gmail' ? gmailHexId(m && m.emailId) : null);
  const guard = (fn) => async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      throw sanitizeError(err, { secret, user });
    }
  };
  let opened = null;

  return {
    /**
     * EXAMINE a folder. uidValidity comes back as a Number (imapflow gives a
     * BigInt; the value is a 32-bit nz-number, and BigInt cannot go through
     * JSON.stringify into ingest_state).
     * @returns {{ uidValidity:number, uidNext:number|null, exists:number }}
     */
    openFolder: guard(async (folder) => {
      const box = await client.mailboxOpen(folder, { readOnly: true });
      opened = folder;
      return {
        uidValidity: Number(box.uidValidity),
        uidNext: Number.isFinite(Number(box.uidNext)) && Number(box.uidNext) > 0 ? Number(box.uidNext) : null,
        exists: Number(box.exists) || 0,
      };
    }),

    /**
     * UIDs in [from, to] (inclusive; `to` null = no upper bound), ascending.
     * Results are filtered to the requested bounds on purpose: `UID n:*` with
     * n above the highest UID returns the highest message (RFC 3501 §6.4.8 —
     * `*` is "the largest UID", and n:* is the range between them), the
     * classic off-by-the-top cursor bug.
     */
    searchUids: guard(async (from, to = null) => {
      const lo = Math.max(1, Number(from) || 1);
      const hi = to == null ? null : Number(to);
      if (hi != null && hi < lo) return [];
      const res = await client.search({ uid: `${lo}:${hi == null ? '*' : hi}` }, { uid: true });
      const list = Array.isArray(res) ? res : [];
      return [...new Set(list.map(Number))]
        .filter(u => Number.isInteger(u) && u >= lo && (hi == null || u <= hi))
        .sort((a, b) => a - b);
    }),

    /**
     * Every message in the open folder as {uid, messageId, providerId} — the
     * UIDVALIDITY re-key scan. ENVELOPE (not a header fetch) so the
     * Message-ID is parsed by exactly the same code path that stored it;
     * providerId rides along on Gmail (imapflow fetches it unasked).
     */
    listMessageIds: guard(async () => {
      const out = [];
      // No other command may run inside this loop (imapflow fetch contract).
      for await (const m of client.fetch('1:*', { uid: true, envelope: true }, { uid: true })) {
        out.push({
          uid: Number(m.uid),
          messageId: normalizeMessageId(m.envelope && m.envelope.messageId),
          providerId: providerIdOf(m),
        });
      }
      return out.sort((a, b) => a.uid - b.uid);
    }),

    /**
     * Full metadata + capped text bodies for the given UIDs, ascending. A UID
     * the server no longer has is simply absent from the result.
     */
    fetchMessages: guard(async (uids) => {
      const want = [...new Set((uids || []).map(Number).filter(u => Number.isInteger(u) && u > 0))];
      if (!want.length) return [];
      const wanted = new Set(want);
      const rows = await client.fetchAll(want.join(','), {
        uid: true, envelope: true, bodyStructure: true, flags: true,
        internalDate: true, size: true, headers: true,
      }, { uid: true });

      const byUid = new Map();
      // Unsolicited FETCH rows (flag changes from another session) can ride
      // along — keep only what was asked for.
      for (const m of rows) if (wanted.has(Number(m.uid))) byUid.set(Number(m.uid), m);

      const out = [];
      for (const uid of [...byUid.keys()].sort((a, b) => a - b)) {
        const m = byUid.get(uid);
        const env = m.envelope || {};
        const st = analyzeStructure(m.bodyStructure);
        const msg = {
          uid,
          providerId: providerIdOf(m),
          size: Number.isFinite(Number(m.size)) ? Number(m.size) : null,
          flags: mapFlags(m.flags),
          internalDate: toDate(m.internalDate),
          envelope: {
            date: toDate(env.date),
            subject: env.subject != null ? String(env.subject) : '',
            messageId: normalizeMessageId(env.messageId),
            inReplyTo: normalizeMessageId(env.inReplyTo),
            from: addrList(env.from),
            to: addrList(env.to),
            cc: addrList(env.cc),
            bcc: addrList(env.bcc),
            replyTo: addrList(env.replyTo),
          },
          headerBlock: m.headers ? m.headers.toString('utf8').slice(0, limits.maxHeaderBlockBytes) : '',
          text: null,
          html: null,
          textTruncated: false,
          htmlTruncated: false,
          attachments: st.attachments,
        };
        for (const [key, part] of [['text', st.textPart], ['html', st.htmlPart]]) {
          if (!part) continue;
          const d = await client.download(String(uid), part, { uid: true, maxBytes: limits.maxBodyBytes });
          if (!d || !d.content) continue;
          const r = await readStream(d.content, limits.maxBodyBytes);
          msg[key] = r.text;
          msg[`${key}Truncated`] = r.truncated;
        }
        out.push(msg);
      }
      return out;
    }),

    /**
     * Every folder on the account: path (what ingest_folders names), its
     * special-use flag (\\Sent, \\All …), selectability and STATUS counts.
     * For the SU folder listing — never called by the ingest worker.
     */
    listFolders: guard(async () => {
      const list = await client.list({ statusQuery: { messages: true, uidNext: true, uidValidity: true } });
      const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
      return (Array.isArray(list) ? list : []).map((f) => {
        const flags = [...(f.flags || [])].map(String);
        const st = f.status || {};
        return {
          path: String(f.path),
          delimiter: f.delimiter != null ? String(f.delimiter) : null,
          special_use: f.specialUse ? String(f.specialUse) : null,
          flags,
          selectable: !flags.some(x => /^\\(noselect|nonexistent)$/i.test(x)),
          messages: num(st.messages),
          uid_next: num(st.uidNext),
          uid_validity: num(st.uidValidity),
        };
      }).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    }),

    /** 'gmail' when this connection yields X-GM-MSGID provider ids, else null. */
    get providerIdKind() { return idKind; },

    get folder() { return opened; },
  };
}

/**
 * Connect, run `fn(session)`, always log out. Connect failures come back
 * sanitized; errors thrown by session methods are already sanitized; errors
 * from the caller's own code (DB etc.) pass through untouched.
 */
async function withMailbox(row, fn) {
  const secret = decryptSecret(row);
  const client = makeClient(row, secret);
  try {
    await client.connect();
  } catch (err) {
    try { client.close(); } catch (_) { /* never connected */ }
    throw sanitizeError(err, { secret, user: row.imap_user });
  }
  try {
    return await fn(makeSession(client, row, secret));
  } finally {
    await closeClient(client);
  }
}

/**
 * Stream one body part for the attachment route.
 *
 * Identity guard — the part is served only if the server's copy is provably
 * the stored message: the folder's UIDVALIDITY must equal the ingest cursor's
 * (a changed UIDVALIDITY means stored UIDs may now name different mail until
 * the next ingest re-keys them), and when the stored row has a Message-ID the
 * server's message at that UID must carry the same one. Serving the wrong
 * client's PDF is the failure this exists to make impossible.
 *
 * @returns {Promise<null | { stream, mime, filename, close }>}
 *   null = the server no longer has that message/part (deleted in webmail /
 *   Outlook — the accepted D1 caveat). Throws a sanitized error otherwise;
 *   err.code 'UIDVALIDITY_MISMATCH' | 'MESSAGE_MISMATCH' mean "re-sync
 *   pending", not "gone".
 */
async function fetchPart(row, folder, uid, partId, { uidValidity = null, messageId = null } = {}) {
  const secret = decryptSecret(row);
  const client = makeClient(row, secret);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    closeClient(client).catch(() => {});
  };
  try {
    await client.connect();
    const box = await client.mailboxOpen(folder, { readOnly: true });
    if (uidValidity != null && Number(box.uidValidity) !== Number(uidValidity)) {
      throw typedError('UIDVALIDITY_MISMATCH', 'folder UIDVALIDITY changed since the last ingest — re-sync pending', { sanitized: true });
    }
    const want = normalizeMessageId(messageId);
    if (want) {
      const m = await client.fetchOne(String(uid), { uid: true, envelope: true }, { uid: true });
      if (!m || Number(m.uid) !== Number(uid)) { close(); return null; }
      if (normalizeMessageId(m.envelope && m.envelope.messageId) !== want) {
        throw typedError('MESSAGE_MISMATCH', 'the server message at this UID is not the stored message — re-sync pending', { sanitized: true });
      }
    }
    const d = await client.download(String(uid), String(partId), { uid: true });
    if (!d || !d.content) { close(); return null; }
    const stream = d.content;
    stream.once('end', close);
    stream.once('error', close);
    stream.once('close', close);
    const meta = d.meta || {};
    return {
      stream,
      mime: meta.contentType ? String(meta.contentType).toLowerCase() : null,
      filename: meta.filename ? String(meta.filename) : null,
      close,
    };
  } catch (err) {
    close();
    throw sanitizeError(err, { secret, user: row.imap_user });
  }
}

/**
 * The SU folder listing (S1-G): {provider_id_kind, folders:[…]} for one
 * mailbox. Connect, LIST + STATUS, log out — no folder is opened, nothing is
 * written. `provider_id_kind` is 'gmail' when ingest will capture X-GM-MSGID
 * (the precondition for emitting under a provider-id source), else null.
 */
async function listFolders(row) {
  return withMailbox(row, async (session) => ({
    provider_id_kind: session.providerIdKind,
    folders: await session.listFolders(),
  }));
}

module.exports = {
  withMailbox,
  fetchPart,
  listFolders,
  // exported for the worker + tests
  analyzeStructure,
  normalizeMessageId,
  providerIdKind,
  gmailHexId,
  mapFlags,
  sanitizeError,
  scrub,
  clientOptions,
  limits,
  factory,
  TRANSIENT_CODES,
};
