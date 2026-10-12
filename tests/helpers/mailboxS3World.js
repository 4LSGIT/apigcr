// tests/helpers/mailboxS3World.js
//
/**
 * Test world for the mailbox S3 suites (compose / reply / Sent —
 * tests/mailboxS3.*.test.js). It IS the S2 world (tests/helpers/mailboxS2World.js
 * — the same tables, the same parsed list, the same read-state writes the
 * read-state seed reuses) plus the statements S3 adds:
 *   mailboxService.listSendable, services/mailbox/mailboxSendService (identity,
 *   parent, budget, email_log lookup, Sent APPEND connection row, the seed
 *   job and its probes), the email adapters' email_log INSERTs, lib/alerting's
 *   system_alerts / alert_state writes, admin_audit_log, settingsService.
 * Unknown statements still THROW (the S2 world's fallthrough), so a new or
 * edited S3 query fails a test instead of returning nothing. The SQL itself
 * runs on MySQL 8 in tests/mailboxS3.mysql.test.js (gated).
 *
 * Fidelity notes:
 *   - `credential_id <=> ?` is NULL-safe equality; from_email IN (?) and
 *     address comparisons are case-insensitive (general_ci).
 *   - email_log.processed_at = the insert time (Date.now()); "NOW() -
 *     INTERVAL 24 HOUR" against Date.now(). Seed rows with W.sent({at}).
 *   - system_alerts INSERT IGNORE honours UNIQUE(dedup_key).
 */

'use strict';

const { makeWorld: makeS2World } = require('./mailboxS2World');

const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const ci = (a, b) => a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase();
const clone = (v) => structuredClone(v);
function parseJsonCol(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return v; }
}

const SENDABLE_COLS = 'm.id, m.address, m.domain, m.display_name, m.color, m.active, m.send_credential_id';
const CONNECTION_COLUMNS = 'id, address, imap_host, imap_port, imap_user, imap_secret, ingest_folders, ingest_state, active, ingest_enabled, emit_source_name, emit_id_kind';
const PARENT_COLS = 'id, mailbox_id, folder, gmail_labels, message_id, in_reply_to, thread_key, provider_id, from_addr, to_addrs, cc_addrs, subject, date, body_text, body_html';

function makeWorld() {
  const W = makeS2World();
  const T = W.T;
  Object.assign(T, {
    email_credentials: [], email_log: [], scheduled_jobs: [], system_alerts: [], alert_state: [],
    admin_audit_log: [], app_settings: [],
  });
  const seq = { email_log: 0, scheduled_jobs: 0, system_alerts: 0, admin_audit_log: 0 };

  /** An email_credentials row (provider smtp by default). */
  W.cred = (id, over = {}) => {
    T.email_credentials.push({
      id, email: `sender${id}@firm.test`, from_name: `Sender ${id}`, provider: 'smtp', credential_id: null,
      smtp_host: 'mail.firm.test', smtp_port: 587, smtp_user: `sender${id}@firm.test`, smtp_pass: 'ENCv1:x', smtp_secure: 0,
      signature_html: null, signature_text: null, owner_user: null, ...over,
    });
    return id;
  };
  /** An outbound email_log row `at` (Date|ms) — budget history. */
  W.sent = (over = {}) => {
    const row = { id: ++seq.email_log, source: 'outbound-smtp', message_id: `m${seq.email_log}`, from_email: 'x@firm.test',
      to_email: 'y@x.test', subject: 's', body: 'b', delivery_info: null, processed_at: new Date(), ...over };
    if (!(row.processed_at instanceof Date)) row.processed_at = new Date(row.processed_at);
    T.email_log.push(row);
    return row.id;
  };
  W.setting = (key, value) => { T.app_settings.push({ key, value }); };

  const mailboxRow = (id) => T.mailboxes.find(b => b.id === Number(id));
  const byAddr = (a, b) => String(a.address).localeCompare(String(b.address));
  const sendable = (b) => ({ id: b.id, address: b.address, domain: b.domain, display_name: b.display_name, color: b.color, active: b.active, send_credential_id: b.send_credential_id ?? null });

  const s2 = W.db.query;
  async function query(sqlIn, params = []) {
    const sql = norm(sqlIn);
    const p = params || [];
    const rec = () => W.statements.push({ sql, params: clone(p) });
    let m;

    // ── mailboxService.listSendable ──
    if (sql === `SELECT ${SENDABLE_COLS} FROM mailboxes m ORDER BY m.address ASC`) {
      rec(); return [[...T.mailboxes].sort(byAddr).map(sendable)];
    }
    if (sql === `SELECT ${SENDABLE_COLS} FROM channel_grants g JOIN mailboxes m ON m.id = g.channel_id WHERE g.user = ? AND g.channel_type = 'mailbox' AND g.can_send = 1 ORDER BY m.address ASC`) {
      rec();
      const rows = [];
      for (const g of T.channel_grants) {
        if (g.user !== Number(p[0]) || g.channel_type !== 'mailbox' || Number(g.can_send) !== 1) continue;
        const b = mailboxRow(g.channel_id);
        if (b) rows.push(sendable(b));
      }
      return [rows.sort(byAddr)];
    }

    // ── mailboxSendService.grantedIdentities (S3.2): an SU's explicit send grant rows ──
    if (sql === "SELECT channel_id FROM channel_grants WHERE user = ? AND channel_type = 'mailbox' AND can_send = 1") {
      rec();
      return [T.channel_grants.filter(g => g.user === Number(p[0]) && g.channel_type === 'mailbox' && Number(g.can_send) === 1)
        .map(g => ({ channel_id: g.channel_id }))];
    }

    // ── mailboxSendService: identity, credential, parent ──
    if (sql === 'SELECT id, address, display_name, active, send_credential_id, ingest_enabled, ingest_folders FROM mailboxes WHERE id = ? LIMIT 1') {
      rec();
      const b = mailboxRow(p[0]);
      return [b ? [{ id: b.id, address: b.address, display_name: b.display_name, active: b.active, send_credential_id: b.send_credential_id ?? null,
        ingest_enabled: b.ingest_enabled ?? 1, ingest_folders: parseJsonCol(b.ingest_folders) }] : []];
    }
    if (sql === 'SELECT * FROM email_credentials WHERE id = ? LIMIT 1') {
      rec();
      const c = T.email_credentials.find(x => x.id === Number(p[0]));
      return [c ? [clone(c)] : []];
    }
    if (sql === "SELECT id, email, provider, ((signature_html IS NOT NULL AND signature_html <> '') OR (signature_text IS NOT NULL AND signature_text <> '')) AS has_sig FROM email_credentials WHERE id IN (?)") {
      rec();
      const ids = new Set(p[0].map(Number));
      return [T.email_credentials.filter(c => ids.has(c.id)).map(c => ({
        id: c.id, email: c.email, provider: c.provider,
        has_sig: (c.signature_html != null && c.signature_html !== '') || (c.signature_text != null && c.signature_text !== '') ? 1 : 0,
      }))];
    }
    if (sql === `SELECT ${PARENT_COLS} FROM mail_messages WHERE id = ? LIMIT 1`) {
      rec();
      const x = T.mail_messages.find(r => r.id === Number(p[0]));
      if (!x) return [[]];
      const out = {};
      for (const c of PARENT_COLS.split(', ')) out[c] = x[c] instanceof Date ? new Date(x[c]) : (x[c] ?? null);
      return [[out]];
    }

    // ── budget ──
    if (sql === "SELECT id, email FROM email_credentials WHERE provider = 'gmail' AND credential_id <=> ?") {
      rec();
      return [T.email_credentials.filter(c => c.provider === 'gmail' && (c.credential_id ?? null) === (p[0] ?? null)).map(c => ({ id: c.id, email: c.email }))];
    }
    if (sql === "SELECT id, email FROM email_credentials WHERE provider = 'smtp' AND smtp_host = ? AND smtp_user = ?") {
      rec();
      return [T.email_credentials.filter(c => c.provider === 'smtp' && ci(c.smtp_host, p[0]) && ci(c.smtp_user, p[1])).map(c => ({ id: c.id, email: c.email }))];
    }
    if (sql === 'SELECT address FROM mailboxes WHERE send_credential_id IN (?)') {
      rec();
      const ids = new Set(p[0].map(Number));
      return [T.mailboxes.filter(b => b.send_credential_id != null && ids.has(Number(b.send_credential_id))).map(b => ({ address: b.address }))];
    }
    if (sql === 'SELECT `value` FROM app_settings WHERE `key` = ? LIMIT 1') {
      rec();
      const s = T.app_settings.find(x => x.key === p[0]);
      return [s ? [{ value: s.value }] : []];
    }
    if (sql === 'SELECT COUNT(*) AS n FROM email_log WHERE source = ? AND from_email IN (?) AND processed_at > NOW() - INTERVAL 24 HOUR') {
      rec();
      const from = new Set(p[1].map(a => String(a).toLowerCase()));
      const since = Date.now() - 24 * 3600_000;
      return [[{ n: T.email_log.filter(r => r.source === p[0] && from.has(String(r.from_email).toLowerCase()) && r.processed_at.getTime() > since).length }]];
    }

    // ── lib/alerting.alert ──
    if ((m = /^(INSERT|INSERT IGNORE) INTO system_alerts \(source, kind, group_key, severity, title, message, context, ref_table, ref_id, dedup_key\) VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, \?\)$/.exec(sql))) {
      rec();
      const row = { source: p[0], kind: p[1], group_key: p[2], severity: p[3], title: p[4], message: p[5], context: p[6], ref_table: p[7], ref_id: p[8], dedup_key: p[9] };
      if (row.dedup_key != null && T.system_alerts.some(a => a.dedup_key === row.dedup_key)) {
        if (m[1] === 'INSERT') throw Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
        return [{ affectedRows: 0, insertId: 0 }];
      }
      row.id = ++seq.system_alerts;
      T.system_alerts.push(row);
      return [{ affectedRows: 1, insertId: row.id }];
    }
    if (sql === 'INSERT INTO alert_state (group_key, first_seen, last_seen, occurrence_count) VALUES (?, NOW(), NOW(), 1) ON DUPLICATE KEY UPDATE last_seen = NOW(), occurrence_count = occurrence_count + 1') {
      rec();
      const s = T.alert_state.find(x => x.group_key === p[0]);
      if (s) s.occurrence_count++; else T.alert_state.push({ group_key: p[0], occurrence_count: 1 });
      return [{ affectedRows: 1 }];
    }

    // ── the adapters' own email_log rows ──
    if (sql === "INSERT INTO email_log (source, message_id, from_email, to_email, subject, body, delivery_info, processed_at) VALUES ('outbound-smtp', ?, ?, ?, ?, ?, ?, NOW())") {
      rec();
      const row = { id: ++seq.email_log, source: 'outbound-smtp', message_id: p[0], from_email: p[1], to_email: p[2], subject: p[3], body: p[4], delivery_info: p[5], processed_at: new Date() };
      T.email_log.push(row);
      return [{ affectedRows: 1, insertId: row.id }];
    }
    if (sql === "INSERT INTO email_log (source, message_id, from_email, to_email, subject, body, processed_at) VALUES ('outbound-gmail', ?, ?, ?, ?, ?, NOW())") {
      rec();
      const row = { id: ++seq.email_log, source: 'outbound-gmail', message_id: p[0], from_email: p[1], to_email: p[2], subject: p[3], body: p[4], delivery_info: null, processed_at: new Date() };
      T.email_log.push(row);
      return [{ affectedRows: 1, insertId: row.id }];
    }
    if (sql === 'SELECT id FROM email_log WHERE source = ? AND message_id = ? ORDER BY id DESC LIMIT 1') {
      rec();
      const hit = T.email_log.filter(r => r.source === p[0] && ci(r.message_id, p[1])).sort((a, b) => b.id - a.id)[0];
      return [hit ? [{ id: hit.id }] : []];
    }

    // ── Sent APPEND connection row (mailboxIngestService.loadConnectionRow) ──
    if (sql === `SELECT ${CONNECTION_COLUMNS} FROM mailboxes WHERE id = ? LIMIT 1`) {
      rec();
      const b = mailboxRow(p[0]);
      if (!b) return [[]];
      const out = {};
      for (const c of CONNECTION_COLUMNS.split(', ')) out[c] = c === 'ingest_folders' || c === 'ingest_state' ? parseJsonCol(b[c]) : (b[c] ?? null);
      return [[out]];
    }

    // ── the read-state seed job ──
    if (sql === "INSERT INTO scheduled_jobs (type, scheduled_time, status, name, data, max_attempts, backoff_seconds) VALUES ('one_time', ?, 'pending', ?, ?, ?, ?)") {
      rec();
      const row = { id: ++seq.scheduled_jobs, type: 'one_time', scheduled_time: p[0], status: 'pending', name: p[1], data: p[2], max_attempts: p[3], backoff_seconds: p[4] };
      T.scheduled_jobs.push(row);
      return [{ affectedRows: 1, insertId: row.id }];
    }
    if (sql === 'SELECT id FROM mail_messages WHERE mailbox_id IN (?) AND date >= ? AND provider_id = ?') {
      rec();
      const ids = new Set(p[0].map(Number));
      const since = new Date(p[1]).getTime();
      return [T.mail_messages.filter(x => ids.has(x.mailbox_id) && x.date != null && new Date(x.date).getTime() >= since && x.provider_id === p[2]).map(x => ({ id: x.id }))];
    }
    if (sql === 'SELECT id FROM mail_messages WHERE message_id = ? AND mailbox_id IN (?)') {
      rec();
      const ids = new Set(p[1].map(Number));
      return [T.mail_messages.filter(x => ci(x.message_id, p[0]) && ids.has(x.mailbox_id)).map(x => ({ id: x.id }))];
    }

    // ── admin_audit_log (lib/auth.superuser.auditAdminAction) ──
    if (sql === 'INSERT INTO admin_audit_log (tool, user_id, username, route, method, status, error_message, duration_ms, ip_address, user_agent, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)') {
      rec();
      const row = { id: ++seq.admin_audit_log, tool: p[0], user_id: p[1], username: p[2], route: p[3], method: p[4], status: p[5], error_message: p[6], details: p[10] ? JSON.parse(p[10]) : null };
      T.admin_audit_log.push(row);
      return [{ affectedRows: 1, insertId: row.id }];
    }

    return s2(sqlIn, params);
  }

  const conn0 = W.db.getConnection;
  W.db = { query, getConnection: conn0 };
  return W;
}

/**
 * The Sent scope's edge matrix (mailReadService SENT_WHERE): [id, mailbox_id,
 * folder, gmail_labels, inSent]. ONE copy: tests/mailboxS3.send.test.js runs
 * it against this world (CI), tests/mailboxS3.mysql.test.js against MySQL
 * (gated) — so the world can never drift from the engine unnoticed.
 */
const SENT_MATRIX = Object.freeze([
  [401, 2, '[Gmail]/All Mail', '["\\\\Sent"]', true],
  [402, 2, '[Gmail]/All Mail', '["\\\\Inbox", "\\\\Sent"]', true],     // sent to oneself: Inbox AND Sent
  [403, 2, '[Gmail]/All Mail', '["\\\\SENT"]', false],                // case matters (JSON compare)
  [404, 2, '[Gmail]/All Mail', '["Sent"]', false],                    // a user label, no backslash
  [405, 2, '[Gmail]/All Mail', '[]', false],                          // archived
  [406, 2, '[Gmail]/All Mail', null, false],
  [407, 2, '[Gmail]/Sent Mail', '[]', true],                          // the selected folder's own label left out
  [408, 1, 'INBOX.Sent', null, true],                                 // SiteGround
  [409, 1, 'Sent Items', null, true],
  [410, 1, 'INBOX.sent messages', null, true],                        // REGEXP on general_ci: case-blind
  [411, 1, 'INBOX.Sentinel', null, false],
  [412, 1, 'Unsent', null, false],
  [413, 1, 'INBOX', null, false],
]);

module.exports = { makeWorld, SENT_MATRIX };
