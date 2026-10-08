// tests/helpers/mailboxS1World.js
//
/**
 * Test world for the mailbox S1 suites (tests/mailboxS1.*.test.js).
 *
 *   makeWorld()           stateful fake MySQL: the exact statements
 *                         services/mailbox/mailboxIngestService.js and the
 *                         part route issue, evaluated against stored rows.
 *                         Unknown statements THROW (so a new query shows up as
 *                         a failing test, not a silent empty result).
 *   makeImapServer()      fake IMAP account + a SESSION object with the same
 *                         contract as imapTransport's facade (openFolder /
 *                         searchUids / listMessageIds / fetchMessages), plus
 *                         withMailbox(row, fn).
 *   makePipeline(world)   stand-in for emailIngestService.ingestEmail: writes
 *                         email_ingest_executions rows into the world and
 *                         dedupes on (source, message_id) like the real one.
 *
 * FIDELITY THAT MATTERS
 *   - UNIQUE(mailbox_id, folder, uid) is enforced ROW BY ROW in ascending id
 *     order, on INSERT and on every UPDATE of uid — as InnoDB does for a
 *     multi-row UPDATE. A CASE update that swaps two UIDs without parking
 *     fails here exactly as it fails on MySQL (verified on MySQL 8.0, see the
 *     S1 worker report). NULL uids never collide.
 *   - `folder` compares case-insensitively (utf8mb4_general_ci).
 *   - INSERT … ON DUPLICATE KEY UPDATE id = id → insertId 0 on a duplicate
 *     (mysql2 + MySQL 8, verified).
 *   - Transactions snapshot at BEGIN and restore on ROLLBACK.
 *   - JSON columns come back parsed (mysql2 behaviour).
 */

'use strict';

const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const clone = (v) => JSON.parse(JSON.stringify(v));
const ci = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

const LOCK = "CONCAT('mailbox_ingest:', DATABASE())";

function dupErr() {
  return Object.assign(new Error("Duplicate entry for key 'uq_mail_messages_folder_uid'"), { code: 'ER_DUP_ENTRY', errno: 1062 });
}

function makeWorld() {
  const T = {
    mailboxes: [],
    mail_messages: [],
    mail_read_state: [],
    email_ingest_sources: [{ id: 3, name: 'mailbox-imap', active: 1 }],
    email_ingest_executions: [],
    channel_grants: [],
    users: [
      { user: 1, user_auth: 'authorized' },
      { user: 5, user_auth: 'authorized' },
      { user: 6, user_auth: 'authorized - SU' },
      { user: 9, user_auth: 'authorized' },
    ],
  };
  const seq = { mail_messages: 0, email_ingest_executions: 0 };
  const statements = [];
  const lock = { holder: null, nextConn: 100 };
  let txnSnapshot = null;

  const parseRow = (r) => {
    const out = { ...r };
    for (const k of ['ingest_folders', 'ingest_state', 'attachments']) {
      if (typeof out[k] === 'string') out[k] = JSON.parse(out[k]);
    }
    return out;
  };

  function assertUnique(row, uid) {
    if (uid == null) return;
    const clash = T.mail_messages.find(r => r !== row && r.mailbox_id === row.mailbox_id &&
      ci(r.folder, row.folder) && r.uid != null && Number(r.uid) === Number(uid));
    if (clash) throw dupErr();
  }

  function msgRowsIn(mailboxId, folder) {
    return T.mail_messages.filter(r => r.mailbox_id === Number(mailboxId) && ci(r.folder, folder));
  }

  async function query(sqlIn, params = [], connId = null) {
    const sql = norm(sqlIn);
    statements.push({ sql, params: clone(params || []) });
    const p = params || [];
    let m;

    // ── locks ──
    if (sql === `SELECT GET_LOCK(${LOCK}, 0) AS got`) {
      if (lock.holder != null && lock.holder !== connId) return [[{ got: 0 }]];
      lock.holder = connId;
      return [[{ got: 1 }]];
    }
    if (sql === `SELECT IS_USED_LOCK(${LOCK}) = CONNECTION_ID() AS mine`) {
      if (lock.breakHeartbeat) throw Object.assign(new Error('Connection lost'), { code: 'PROTOCOL_CONNECTION_LOST' });
      return [[{ mine: lock.holder === connId ? 1 : 0 }]];
    }
    if (sql === `SELECT RELEASE_LOCK(${LOCK})`) {
      if (lock.holder === connId) lock.holder = null;
      return [[{ 'RELEASE_LOCK': 1 }]];
    }

    // ── sources / mailboxes ──
    if (sql === 'SELECT id, name, active FROM email_ingest_sources WHERE name = ? LIMIT 1') {
      return [T.email_ingest_sources.filter(s => s.name === p[0]).slice(0, 1).map(clone)];
    }
    if ((m = /^SELECT (id, address, imap_host, imap_port, imap_user, imap_secret, ingest_folders, ingest_state, active, ingest_enabled) FROM mailboxes WHERE active = 1 AND ingest_enabled = 1 ORDER BY id ASC$/.exec(sql))) {
      return [T.mailboxes.filter(b => b.active && b.ingest_enabled).sort((a, b) => a.id - b.id).map(b => parseRow(clone(b)))];
    }
    if (/^SELECT id, address, imap_host, imap_port, imap_user, imap_secret, ingest_folders, ingest_state, active, ingest_enabled FROM mailboxes WHERE id = \? LIMIT 1$/.test(sql)) {
      return [T.mailboxes.filter(b => b.id === Number(p[0])).map(b => parseRow(clone(b)))];
    }
    if (sql === 'UPDATE mailboxes SET ingest_state = ?, updated_at = updated_at WHERE id = ?') {
      if (T.failStateWrite) throw Object.assign(new Error('write failed'), { code: 'ECONNRESET' });
      const b = T.mailboxes.find(x => x.id === Number(p[1]));
      if (b) b.ingest_state = p[0];
      return [{ affectedRows: b ? 1 : 0 }];
    }
    if (sql === 'SELECT user_auth FROM users WHERE user = ? LIMIT 1') {
      return [T.users.filter(u => u.user === Number(p[0])).map(clone)];
    }
    if (sql === 'SELECT can_read, can_send, can_manage FROM channel_grants WHERE user = ? AND channel_type = ? AND channel_id = ? LIMIT 1') {
      return [T.channel_grants.filter(g => g.user === Number(p[0]) && g.channel_type === p[1] && g.channel_id === Number(p[2])).map(clone)];
    }

    // ── mail_messages ──
    if (sql === 'SELECT id, uid, log_id FROM mail_messages WHERE mailbox_id = ? AND folder = ? AND uid IN (?)') {
      const set = new Set(p[2].map(Number));
      return [msgRowsIn(p[0], p[1]).filter(r => r.uid != null && set.has(Number(r.uid)))
        .map(r => ({ id: r.id, uid: r.uid, log_id: r.log_id }))];
    }
    if (sql === 'SELECT id FROM mail_messages WHERE mailbox_id = ? AND folder = ? AND message_id = ? LIMIT 1') {
      return [msgRowsIn(p[0], p[1]).filter(r => r.message_id != null && ci(r.message_id, p[2])).slice(0, 1).map(r => ({ id: r.id }))];
    }
    if (sql === 'SELECT id, log_id FROM mail_messages WHERE mailbox_id = ? AND folder = ? AND uid = ? LIMIT 1') {
      return [msgRowsIn(p[0], p[1]).filter(r => Number(r.uid) === Number(p[2])).slice(0, 1).map(r => ({ id: r.id, log_id: r.log_id }))];
    }
    if (sql === 'SELECT id, uid, message_id FROM mail_messages WHERE mailbox_id = ? AND folder = ?') {
      return [msgRowsIn(p[0], p[1]).map(r => ({ id: r.id, uid: r.uid, message_id: r.message_id }))];
    }
    if (sql === 'SELECT COUNT(*) AS n FROM mail_messages WHERE mailbox_id = ? AND folder = ?') {
      return [[{ n: msgRowsIn(p[0], p[1]).length }]];
    }
    if ((m = /^INSERT INTO mail_messages \(([^)]+)\) VALUES \([?, ]+\) ON DUPLICATE KEY UPDATE id = id$/.exec(sql))) {
      const cols = m[1].split(',').map(s => s.trim());
      const row = {};
      cols.forEach((c, i) => { row[c] = p[i] instanceof Date ? p[i].toISOString() : p[i]; });
      row.mailbox_id = Number(row.mailbox_id);
      row.log_id = null;
      if (T.failInsert) throw Object.assign(new Error('insert failed'), { code: 'ER_LOCK_DEADLOCK' });
      try { assertUnique(row, row.uid); } catch (_) { return [{ affectedRows: 1, insertId: 0 }]; }
      row.id = ++seq.mail_messages;
      T.mail_messages.push(row);
      return [{ affectedRows: 1, insertId: row.id }];
    }
    if (sql === 'UPDATE mail_messages SET log_id = ? WHERE id = ? AND log_id IS NULL') {
      const r = T.mail_messages.find(x => x.id === Number(p[1]) && x.log_id == null);
      if (r) r.log_id = p[0];
      return [{ affectedRows: r ? 1 : 0 }];
    }
    if (sql === 'SELECT id, folder, uid, message_id, attachments FROM mail_messages WHERE id = ? AND mailbox_id = ? LIMIT 1') {
      return [T.mail_messages.filter(r => r.id === Number(p[0]) && r.mailbox_id === Number(p[1]))
        .map(r => parseRow({ id: r.id, folder: r.folder, uid: r.uid, message_id: r.message_id, attachments: r.attachments }))];
    }

    // ── re-key transaction statements ──
    if (sql === 'DELETE FROM mail_read_state WHERE message_fk IN (?)') {
      const set = new Set(p[0].map(Number));
      const before = T.mail_read_state.length;
      T.mail_read_state = T.mail_read_state.filter(r => !set.has(Number(r.message_fk)));
      return [{ affectedRows: before - T.mail_read_state.length }];
    }
    if (sql === 'DELETE FROM mail_messages WHERE mailbox_id = ? AND folder = ? AND id IN (?)') {
      const set = new Set(p[2].map(Number));
      const before = T.mail_messages.length;
      T.mail_messages = T.mail_messages.filter(r => !(r.mailbox_id === Number(p[0]) && ci(r.folder, p[1]) && set.has(r.id)));
      return [{ affectedRows: before - T.mail_messages.length }];
    }
    if (sql === 'UPDATE mail_messages SET uid = NULL WHERE mailbox_id = ? AND folder = ? AND id IN (?)') {
      const set = new Set(p[2].map(Number));
      for (const r of msgRowsIn(p[0], p[1]).filter(x => set.has(x.id))) r.uid = null;
      return [{ affectedRows: set.size }];
    }
    if ((m = /^UPDATE mail_messages SET uid = CASE id ((?:WHEN \? THEN \? ?)+)END WHERE mailbox_id = \? AND folder = \? AND id IN \(\?\)$/.exec(sql))) {
      const pairs = (m[1].match(/WHEN/g) || []).length;
      const map = new Map();
      for (let i = 0; i < pairs; i++) map.set(Number(p[2 * i]), Number(p[2 * i + 1]));
      const mailboxId = p[2 * pairs];
      const folder = p[2 * pairs + 1];
      const ids = new Set(p[2 * pairs + 2].map(Number));
      // Row by row, ascending id — InnoDB's unique check is not deferred.
      for (const r of msgRowsIn(mailboxId, folder).filter(x => ids.has(x.id)).sort((a, b) => a.id - b.id)) {
        const next = map.has(r.id) ? map.get(r.id) : null;
        assertUnique(r, next);
        r.uid = next;
      }
      return [{ affectedRows: ids.size }];
    }

    // ── executions (worker's error row + recoverLogId) ──
    if (sql === "INSERT INTO email_ingest_executions (source_id, message_id, status, error, remote_ip) VALUES (?, ?, 'error', ?, NULL)") {
      T.email_ingest_executions.push({ id: ++seq.email_ingest_executions, source_id: p[0], message_id: p[1], status: 'error', error: p[2], log_id: null });
      return [{ affectedRows: 1, insertId: seq.email_ingest_executions }];
    }
    if (sql === 'SELECT log_id FROM email_ingest_executions WHERE source_id = ? AND message_id = ? AND log_id IS NOT NULL ORDER BY id ASC LIMIT 1') {
      return [T.email_ingest_executions.filter(e => e.source_id === p[0] && e.message_id != null && ci(e.message_id, p[1]) && e.log_id != null)
        .sort((a, b) => a.id - b.id).slice(0, 1).map(e => ({ log_id: e.log_id }))];
    }

    // ── auth middleware audit (fire-and-forget in lib/auth.jwtOrApiKey) ──
    if (/^INSERT INTO jwt_api_audit_log /.test(sql)) {
      T.jwt_api_audit_log = T.jwt_api_audit_log || [];
      T.jwt_api_audit_log.push(clone(p));
      return [{ affectedRows: 1 }];
    }

    throw new Error(`mailboxS1World: unscripted statement: ${sql}`);
  }

  function getConnection() {
    const connId = ++lock.nextConn;
    if (T.failGetConnection) return Promise.reject(Object.assign(new Error('pool exhausted'), { code: 'ETIMEDOUT' }));
    const conn = {
      id: connId,
      released: false,
      destroyed: false,
      query: (sql, params) => {
        if (conn.released || conn.destroyed) {
          return Promise.reject(new Error("Can't add new command when connection is in closed state"));
        }
        return query(sql, params, connId);
      },
      async beginTransaction() { txnSnapshot = clone({ mm: T.mail_messages, rs: T.mail_read_state, mb: T.mailboxes }); },
      async commit() { txnSnapshot = null; },
      async rollback() {
        if (txnSnapshot) {
          T.mail_messages = txnSnapshot.mm; T.mail_read_state = txnSnapshot.rs; T.mailboxes = txnSnapshot.mb;
          txnSnapshot = null;
        }
      },
      release() { conn.released = true; },
      destroy() { conn.destroyed = true; if (lock.holder === connId) lock.holder = null; },
    };
    return Promise.resolve(conn);
  }

  return {
    T,
    statements,
    lock,
    seq,
    db: { query: (sql, params) => query(sql, params, null), getConnection },
    addMailbox(over = {}) {
      const id = (T.mailboxes.reduce((mx, b) => Math.max(mx, b.id), 0)) + 1;
      const row = {
        id,
        address: `box${id}@example.test`,
        imap_host: 'imap.example.test',
        imap_port: 993,
        imap_user: `box${id}@example.test`,
        imap_secret: 'ENCv1:fake',
        ingest_folders: JSON.stringify({ INBOX: { emit_to_rules: true } }),
        ingest_state: null,
        active: 1,
        ingest_enabled: 1,
        ...over,
      };
      if (row.ingest_folders && typeof row.ingest_folders !== 'string') row.ingest_folders = JSON.stringify(row.ingest_folders);
      if (row.ingest_state && typeof row.ingest_state !== 'string') row.ingest_state = JSON.stringify(row.ingest_state);
      T.mailboxes.push(row);
      return id;
    },
    state(mailboxId) {
      const b = T.mailboxes.find(x => x.id === mailboxId);
      return b && b.ingest_state ? JSON.parse(b.ingest_state) : null;
    },
    rows(mailboxId, folder) {
      return msgRowsIn(mailboxId, folder).slice().sort((a, b) => (a.uid ?? 0) - (b.uid ?? 0));
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fake IMAP
// ─────────────────────────────────────────────────────────────────────────────

/** A normalized transport message (the shape imapTransport.fetchMessages returns). */
function msg(uid, over = {}) {
  const mid = Object.prototype.hasOwnProperty.call(over, 'messageId') ? over.messageId : `m${uid}@example.com`;
  return {
    uid,
    size: 1000 + uid,
    flags: over.flags || [],
    internalDate: over.internalDate || new Date('2026-10-01T12:00:00Z'),
    envelope: {
      date: over.date === undefined ? new Date('2026-10-01T12:00:00Z') : over.date,
      subject: over.subject || `subject ${uid}`,
      messageId: mid,
      inReplyTo: over.inReplyTo || null,
      from: over.from || [{ name: 'Client Person', address: `client${uid}@example.com` }],
      to: over.to || [{ name: '', address: 'box1@example.test' }],
      cc: over.cc || [],
      bcc: over.bcc || [],
      replyTo: over.replyTo || [],
    },
    headerBlock: over.headerBlock != null ? over.headerBlock
      : `Date: Thu, 01 Oct 2026 12:00:00 +0000\r\nMessage-ID: <${mid}>\r\nAuthentication-Results: mx; spf=pass smtp.mailfrom=x; dkim=pass; dmarc=fail\r\n`,
    text: over.text === undefined ? `body ${uid}` : over.text,
    html: over.html === undefined ? null : over.html,
    textTruncated: false,
    htmlTruncated: false,
    attachments: over.attachments || [],
  };
}

function makeImapServer() {
  const server = {
    folders: {},           // name → { uidValidity, uidNext, messages: [msg] }
    connects: 0,
    logouts: 0,
    failConnect: null,     // Error to throw from withMailbox before fn
    failOpen: {},          // folder → Error
    failFetchOnUid: null,  // uid → Error thrown by fetchMessages when it includes that uid
    fetchCalls: [],
    searchCalls: [],
  };
  const folder = (name) => {
    const key = Object.keys(server.folders).find(k => ci(k, name));
    if (!key) throw Object.assign(new Error(`IMAP NONEXISTENT: Mailbox doesn't exist: ${name}`), { code: 'NONEXISTENT', imap: true, sanitized: true });
    return server.folders[key];
  };
  server.addFolder = (name, uidValidity = 1000, messages = []) => {
    const maxUid = messages.reduce((mx, m) => Math.max(mx, m.uid), 0);
    server.folders[name] = { uidValidity, uidNext: maxUid + 1, messages: messages.slice() };
  };
  server.deliver = (name, m) => {
    const f = folder(name);
    f.messages.push(m);
    f.uidNext = Math.max(f.uidNext, m.uid + 1);
  };
  server.session = () => {
    let opened = null;
    return {
      async openFolder(name) {
        if (server.failOpen[name]) throw server.failOpen[name];
        const f = folder(name);
        opened = f;
        return { uidValidity: f.uidValidity, uidNext: f.uidNext, exists: f.messages.length };
      },
      async searchUids(from, to = null) {
        server.searchCalls.push([from, to]);
        const lo = Math.max(1, Number(from) || 1);
        // Mirror the real facade's contract: results bounded to [lo, hi].
        return opened.messages.map(m => m.uid)
          .filter(u => u >= lo && (to == null || u <= to))
          .sort((a, b) => a - b);
      },
      async listMessageIds() {
        return opened.messages.map(m => ({ uid: m.uid, messageId: m.envelope.messageId })).sort((a, b) => a.uid - b.uid);
      },
      async fetchMessages(uids) {
        server.fetchCalls.push(uids.slice());
        if (server.failFetchOnUid != null && uids.includes(server.failFetchOnUid)) throw server.failFetchErr;
        const want = new Set(uids);
        return opened.messages.filter(m => want.has(m.uid)).map(clone2).sort((a, b) => a.uid - b.uid);
      },
    };
  };
  server.withMailbox = async (row, fn) => {
    server.connects++;
    if (server.failConnect) throw server.failConnect;
    try { return await fn(server.session()); } finally { server.logouts++; }
  };
  return server;
}

/** structuredClone keeping Dates. */
function clone2(m) {
  return {
    ...m,
    internalDate: m.internalDate ? new Date(m.internalDate) : null,
    envelope: { ...m.envelope, date: m.envelope.date ? new Date(m.envelope.date) : null },
    attachments: (m.attachments || []).map(a => ({ ...a })),
    flags: (m.flags || []).slice(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fake pipeline (emailIngestService.ingestEmail stand-in)
// ─────────────────────────────────────────────────────────────────────────────

function makePipeline(world) {
  const seen = new Map(); // `${source}|${mid}` → { logId }
  let nextLog = 500;
  const pipeline = {
    envelopes: [],
    statusFor: null,      // (envelope) → 'logged' | 'skipped_suppression' | ...
    throwFor: null,       // (envelope) → Error | null
    async ingestEmail(db, source, envelope /* , remoteIp */) {
      pipeline.envelopes.push(envelope);
      const err = pipeline.throwFor && pipeline.throwFor(envelope);
      if (err) throw err;
      const mid = String(envelope.headers.message_id || '').replace(/^<|>$/g, '') || null;
      const key = `${source.name}|${mid}`;
      const T = world.T;
      const exec = (row) => {
        const id = ++world.seq.email_ingest_executions;
        T.email_ingest_executions.push({ id, source_id: source.id, message_id: mid, log_id: null, ...row });
        return id;
      };
      if (!mid) return { status: 'validation_failed', executionId: exec({ status: 'validation_failed' }), error: 'no message-id' };
      if (seen.has(key)) {
        return { status: 'duplicate', executionId: exec({ status: 'duplicate' }), emailLogId: 1 };
      }
      const status = (pipeline.statusFor && pipeline.statusFor(envelope)) || 'logged';
      const logId = status === 'logged' ? ++nextLog : null;
      seen.set(key, { logId });
      return { status, executionId: exec({ status, log_id: logId }), logId, emailLogId: 1 };
    },
  };
  return pipeline;
}

module.exports = { makeWorld, makeImapServer, makePipeline, msg, LOCK };
