#!/usr/bin/env node
// scripts/mailboxRepairShellRows.js
//
/**
 * Repair the envelope-less "shell" rows the mailbox worker stored before the
 * FETCH-merge fix (services/mailbox/imapTransport.js, FETCH ROWS ARE MERGED
 * PER UID). Mailbox 2 (stuart@4lsg.com, [Gmail]/All Mail) has two:
 *
 *   mail_messages 790   uid 188961   2026-10-16   alert 1854   log 74833
 *   mail_messages 1077  uid 189459   2026-10-20   alert 1947   log 75265
 *
 * A flag update that arrived with the FETCH replaced the message's data, so
 * each row holds a UID and flags and nothing else: no provider id, no
 * Message-ID, no sender, no body. The worker never revisits a UID below its
 * cursor, so nothing heals them. The Apps Script logged both mails (the log
 * ids above), so the case log is complete; the STORE is what lacks them.
 *
 * USAGE (from the repo root, on a machine whose .env reaches production — the
 * same setup `npm run db:ref` uses; the Cloud SQL proxy is started if .env
 * opts in; CREDENTIALS_ENCRYPTION_KEY must be in .env, it decrypts the
 * mailbox's IMAP secret):
 *
 *   node scripts/mailboxRepairShellRows.js           # CHECK — writes nothing
 *   node scripts/mailboxRepairShellRows.js --apply   # repair
 *
 * Both end with ONE line: GO or NO-GO, naming the next command. --apply is
 * resumable: it reads the live state every time and repairs only what is
 * still a shell.
 *
 * WHAT IT DOES (CHECK and --apply alike, until the write):
 *   - takes the ingest LOCK (the worker's own GET_LOCK) — a tick holding it →
 *     NO-GO, re-run in a minute; held for the whole run, so no tick re-keys
 *     UIDs under it;
 *   - asserts the mailbox is the Gmail box it expects (address, gmail-firm +
 *     provider emission, All Mail as the only polled folder, a cursor);
 *   - finds every shell of that folder (provider_id, message_id, from_addr and
 *     date all NULL) and asserts the base: at most MAX_SHELLS, each below the
 *     cursor and never bridged (log_id NULL), and the two known rows above are
 *     either such a shell or already repaired to their known Gmail id;
 *   - EXAMINEs All Mail (read-only, as the worker does), asserts its
 *     UIDVALIDITY is the cursor's (so each UID still names the same message)
 *     and that the server hands out Gmail ids, and fetches the shells' UIDs
 *     through the worker's own transport;
 *   - for each: the server still has it, it is not a draft, it carries a Gmail
 *     id, a known row's id is the known one, no other row of the folder
 *     already holds that id, and the log id to bridge is the one the Apps
 *     Script's execution recorded (email_ingest_executions — the worker's own
 *     recoverLogId query).
 *
 * --apply then rewrites each shell IN PLACE (same row id, so read state and
 * any reference survive) with the worker's own buildRow() values and the
 * bridged log_id — one UPDATE per row, guarded on the row still being a shell
 * — and re-reads every row to verify. It emits NOTHING: both mails were
 * logged by the Apps Script; a shell the Apps Script never logged is repaired
 * store-only and named in the output, its emission left to a human.
 */

'use strict';

// .env FIRST, before anything below is required: the transport's
// lib/credentialCrypto fails fast at require() without CREDENTIALS_ENCRYPTION_KEY.
if (require.main === module) {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
}

const svc = require('../services/mailbox/mailboxIngestService');
const realTransport = require('../services/mailbox/imapTransport');

const MAILBOX_ID = 2;
const ADDRESS = 'stuart@4lsg.com';
const FOLDER = '[Gmail]/All Mail';
const SOURCE = 'gmail-firm';
const MAX_SHELLS = 10;
const KNOWN = Object.freeze([
  { id: 790, uid: 188961, providerId: '1a1454d7167dd8b5', logId: 74833 },
  { id: 1077, uid: 189459, providerId: '1a159785934c96f7', logId: 75265 },
]);
const ME = 'node scripts/mailboxRepairShellRows.js';

const SQL = {
  shells:
    '/* shellrepair:shells */ SELECT id, uid, log_id FROM mail_messages ' +
    'WHERE mailbox_id = ? AND folder = ? AND provider_id IS NULL AND message_id IS NULL ' +
    'AND from_addr IS NULL AND date IS NULL ORDER BY uid ASC',
  rows:
    '/* shellrepair:rows */ SELECT id, mailbox_id, folder, uid, provider_id, message_id, from_addr, date, ' +
    'log_id, subject, in_inbox FROM mail_messages WHERE id IN (?)',
  sameId:
    '/* shellrepair:same-id */ SELECT id FROM mail_messages WHERE mailbox_id = ? AND folder = ? AND provider_id = ? AND id <> ?',
  source: '/* shellrepair:source */ SELECT id, name, active FROM email_ingest_sources WHERE name = ?',
  // The worker's recoverLogId, verbatim.
  logId:
    '/* shellrepair:log-id */ SELECT log_id FROM email_ingest_executions ' +
    'WHERE source_id = ? AND message_id = ? AND log_id IS NOT NULL ORDER BY id ASC LIMIT 1',
  update:
    '/* shellrepair:update */ UPDATE mail_messages SET message_id = ?, provider_id = ?, ' +
    'gmail_labels = CAST(? AS JSON), in_reply_to = ?, thread_key = ?, from_addr = ?, to_addrs = ?, ' +
    'cc_addrs = ?, subject = ?, date = ?, snippet = ?, body_text = ?, body_html = ?, ' +
    'attachments = CAST(? AS JSON), size = ?, flags = ?, log_id = ? ' +
    'WHERE id = ? AND mailbox_id = ? AND folder = ? AND uid = ? ' +
    'AND provider_id IS NULL AND message_id IS NULL AND log_id IS NULL',
};

const one = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const parse = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);

/**
 * @param {object} pool  mysql2 promise pool (needs getConnection for the lock)
 * @param {{apply?:boolean, transport?:object, say?:(s:string)=>void}} [opts]
 * @returns {Promise<{ok:boolean, line:string, repaired?:number[], plan?:object[]}>}
 */
async function run(pool, { apply = false, transport = realTransport, say = console.log } = {}) {
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const nogo = (problems) => {
    say('\nPROBLEMS:');
    for (const x of problems) say(`  - ${x}`);
    const line = `NO-GO — ${problems.length} problem(s) above. Nothing was changed.`;
    say(`\n${line}`);
    return { ok: false, line, problems };
  };

  say(`${apply ? 'APPLY' : 'CHECK'} — shell rows of mailbox ${MAILBOX_ID} ${JSON.stringify(FOLDER)}`);
  const lock = await svc.acquireLock(pool);
  if (!lock) {
    const line = `NO-GO — an ingest run holds the lock. Nothing was read or changed. Re-run ${ME}${apply ? ' --apply' : ''} in a minute.`;
    say(`\n${line}`);
    return { ok: false, line };
  }
  try {
    // ── the mailbox ──
    const mb = await svc.loadConnectionRow(pool, MAILBOX_ID);
    const problems = [];
    if (!mb) return nogo([`mailbox ${MAILBOX_ID} not found`]);
    const folders = svc.folderConfig(mb.ingest_folders).map(([f]) => f);
    if (String(mb.address).toLowerCase() !== ADDRESS) problems.push(`mailbox ${MAILBOX_ID} is ${mb.address}, expected ${ADDRESS}`);
    if (mb.emit_source_name !== SOURCE || mb.emit_id_kind !== 'provider') {
      problems.push(`mailbox ${MAILBOX_ID} emits as ${mb.emit_source_name}/${mb.emit_id_kind}, expected ${SOURCE}/provider`);
    }
    if (folders.length !== 1 || folders[0] !== FOLDER) problems.push(`polled folders are ${JSON.stringify(folders)}, expected [${JSON.stringify(FOLDER)}]`);
    const st = (parse(mb.ingest_state) || {})[FOLDER];
    if (!st || !Number.isFinite(Number(st.uidvalidity)) || !Number.isFinite(Number(st.last_uid))) {
      problems.push(`${FOLDER} has no cursor`);
    }
    if (problems.length) return nogo(problems);
    const cursor = { uidvalidity: Number(st.uidvalidity), lastUid: Number(st.last_uid) };
    say(`mailbox ${MAILBOX_ID} ${mb.address}: ${SOURCE}/provider, cursor uidvalidity ${cursor.uidvalidity}, last_uid ${cursor.lastUid}`);

    // ── the base ──
    const shells = await q(SQL.shells, [MAILBOX_ID, FOLDER]);
    const known = await q(SQL.rows, [KNOWN.map(k => k.id)]);
    say(`shells: ${shells.length ? shells.map(s => `${s.id} (uid ${s.uid})`).join(', ') : 'none'}`);
    if (shells.length > MAX_SHELLS) problems.push(`${shells.length} shell rows — more than ${MAX_SHELLS}: is the FETCH-merge fix deployed?`);
    for (const s of shells) {
      if (s.uid == null || Number(s.uid) > cursor.lastUid) problems.push(`shell ${s.id} (uid ${s.uid}) is not below the cursor (${cursor.lastUid}) — the worker may still be on it`);
      if (s.log_id != null) problems.push(`shell ${s.id} already carries log_id ${s.log_id}`);
    }
    const shellIds = new Set(shells.map(s => Number(s.id)));
    for (const k of KNOWN) {
      const r = known.find(x => Number(x.id) === k.id);
      if (!r) { problems.push(`known row ${k.id} is missing`); continue; }
      if (Number(r.mailbox_id) !== MAILBOX_ID || r.folder !== FOLDER || Number(r.uid) !== k.uid) {
        problems.push(`known row ${k.id} is ${r.mailbox_id}/${r.folder}/uid ${r.uid}, expected ${MAILBOX_ID}/${FOLDER}/uid ${k.uid}`);
      } else if (!shellIds.has(k.id) && (r.provider_id !== k.providerId || Number(r.log_id) !== k.logId)) {
        problems.push(`known row ${k.id} is neither a shell nor repaired (provider_id ${r.provider_id}, log_id ${r.log_id})`);
      }
    }
    if (problems.length) return nogo(problems);
    if (!shells.length) {
      const line = 'ALREADY REPAIRED — no shell rows; the known rows carry their Gmail id and log id. GO: nothing to do.';
      say(`\n${line}`);
      return { ok: true, line, repaired: [] };
    }

    const [src] = await q(SQL.source, [SOURCE]);
    if (!src) return nogo([`email_ingest_sources has no ${SOURCE} row`]);

    // ── the server ──
    const fetched = await transport.withMailbox(mb, async (session) => {
      if (session.providerIdKind !== 'gmail') throw Object.assign(new Error('the server hands out no Gmail ids (no X-GM-EXT-1)'), { plan: true });
      const box = await session.openFolder(FOLDER);
      if (box.uidValidity !== cursor.uidvalidity) {
        throw Object.assign(new Error(`${FOLDER} UIDVALIDITY is ${box.uidValidity}, the cursor's is ${cursor.uidvalidity}: stored UIDs may name other mail — let the worker re-key first`), { plan: true });
      }
      return session.fetchMessages(shells.map(s => Number(s.uid)));
    });
    const byUid = new Map(fetched.map(m => [Number(m.uid), m]));

    const plan = [];
    for (const s of shells) {
      const k = KNOWN.find(x => x.id === Number(s.id));
      const m = byUid.get(Number(s.uid));
      if (!m) { problems.push(`shell ${s.id}: Gmail no longer has uid ${s.uid} (deleted since?) — cannot repair it`); continue; }
      if (svc.isDraft(m)) { problems.push(`shell ${s.id}: uid ${s.uid} is a draft now`); continue; }
      if (!m.providerId) { problems.push(`shell ${s.id}: uid ${s.uid} came back without a Gmail id`); continue; }
      if (k && m.providerId !== k.providerId) {
        problems.push(`shell ${s.id}: uid ${s.uid} is Gmail id ${m.providerId}, expected ${k.providerId}`);
        continue;
      }
      const dup = await q(SQL.sameId, [MAILBOX_ID, FOLDER, m.providerId, s.id]);
      if (dup.length) { problems.push(`shell ${s.id}: Gmail id ${m.providerId} is already stored as row ${dup.map(d => d.id).join(', ')}`); continue; }
      const [lg] = await q(SQL.logId, [src.id, m.providerId]);
      const logId = lg && lg.log_id ? Number(lg.log_id) : null;
      if (k && logId !== k.logId) { problems.push(`shell ${s.id}: the ${SOURCE} execution for ${m.providerId} recorded log ${logId}, expected ${k.logId}`); continue; }
      const row = svc.buildRow(MAILBOX_ID, FOLDER, m);
      plan.push({ id: Number(s.id), uid: Number(s.uid), row, logId });
      say(`  ${s.id} uid ${s.uid} → ${m.providerId} | ${row.date ? row.date.toISOString().slice(0, 19) + 'Z' : 'no date'} | ` +
        `${one(row.from_addr, 50)} | ${one(row.subject, 60)} | log ${logId == null ? 'NONE — never logged by either feeder; repaired store-only, NOT emitted' : logId}`);
    }
    if (problems.length) return nogo(problems);

    if (!apply) {
      const line = `CHECK OK — GO. ${plan.length} shell row(s) can be repaired. Next: ${ME} --apply`;
      say(`\n${line}`);
      return { ok: true, line, plan };
    }

    // ── apply ──
    if (lock.lost()) return nogo(['lost the ingest lock before writing']);
    const repaired = [];
    for (const p of plan) {
      const r = p.row;
      const [res] = await pool.query(SQL.update, [
        r.message_id, r.provider_id, r.gmail_labels, r.in_reply_to, r.thread_key, r.from_addr, r.to_addrs,
        r.cc_addrs, r.subject, r.date, r.snippet, r.body_text, r.body_html, r.attachments, r.size, r.flags,
        p.logId, p.id, MAILBOX_ID, FOLDER, p.uid,
      ]);
      if (Number(res.affectedRows) !== 1) {
        const line = `NO-GO — row ${p.id} was not updated (affectedRows ${res.affectedRows}: no longer a shell?). ` +
          `${repaired.length ? `Repaired before it: ${repaired.join(', ')}. ` : ''}Re-run ${ME} to see the live state.`;
        say(`\n${line}`);
        return { ok: false, line, repaired };
      }
      repaired.push(p.id);
      say(`  ✓ row ${p.id} repaired`);
    }

    // ── verify the end state ──
    const after = await q(SQL.rows, [plan.map(p => p.id)]);
    const bad = [];
    for (const p of plan) {
      const a = after.find(x => Number(x.id) === p.id);
      if (!a) { bad.push(`row ${p.id} is gone`); continue; }
      if (a.provider_id !== p.row.provider_id) bad.push(`row ${p.id} provider_id is ${a.provider_id}`);
      if (a.message_id !== p.row.message_id) bad.push(`row ${p.id} message_id is ${a.message_id}`);
      if ((a.log_id == null ? null : Number(a.log_id)) !== p.logId) bad.push(`row ${p.id} log_id is ${a.log_id}, expected ${p.logId}`);
      if (Number(a.uid) !== p.uid) bad.push(`row ${p.id} uid is ${a.uid}`);
    }
    const left = await q(SQL.shells, [MAILBOX_ID, FOLDER]);
    if (left.length) bad.push(`${left.length} shell row(s) remain: ${left.map(s => s.id).join(', ')}`);
    if (bad.length) {
      const line = `NO-GO — written, but the end state is wrong:\n    - ${bad.join('\n    - ')}\nRe-run ${ME} to see the live state.`;
      say(`\n${line}`);
      return { ok: false, line, repaired };
    }
    say(`  ✓ verified: ${after.map(a => `${a.id} → ${a.provider_id} (log ${a.log_id}, in_inbox ${a.in_inbox})`).join('; ')}; no shell rows remain`);
    const line = `REPAIRED — GO. ${repaired.length} row(s). Next: acknowledge the mailbox_ingest_no_provider_id alerts for mailbox ${MAILBOX_ID} in the Alerts pane.`;
    say(`\n${line}`);
    return { ok: true, line, repaired };
  } catch (err) {
    const line = `NO-GO — ${err.plan ? '' : 'could not finish: '}${err.message}. Nothing was changed unless a line above says ✓.`;
    say(`\n${line}`);
    return { ok: false, line };
  } finally {
    await lock.release();
  }
}

module.exports = { run, KNOWN, SQL, MAILBOX_ID, FOLDER };

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────

if (require.main === module) {
  const mysql = require('mysql2');
  const { ensureSqlProxy } = require('./ensure-sql-proxy');
  const apply = process.argv.includes('--apply');
  (async () => {
    let pool;
    try {
      const proxy = await ensureSqlProxy();
      if (proxy.status === 'failed') throw new Error(`the Cloud SQL proxy is not working: ${proxy.reason}`);
      for (const k of ['host', 'user', 'password', 'database', 'CREDENTIALS_ENCRYPTION_KEY']) {
        if (!process.env[k]) throw new Error(`missing env var "${k}" (is .env present?)`);
      }
      pool = mysql.createPool({
        host: process.env.host, user: process.env.user, password: process.env.password,
        database: process.env.database, timezone: 'Z', connectTimeout: 15_000, connectionLimit: 3,
      }).promise();
      const r = await run(pool, { apply });
      process.exitCode = r.ok ? 0 : 1;
    } catch (err) {
      console.log(`\n${err.message}\n\nNO-GO — could not ${pool ? 'finish' : 'connect'}. Nothing was changed.`);
      process.exitCode = 1;
    } finally {
      if (pool) await pool.end().catch(() => {});
    }
  })();
}
