#!/usr/bin/env node
// scripts/accessA2bCollapse.js
//
/**
 * Access-control A2b, stage 3 — the user_auth collapse.
 *
 *   'authorized - SU' → 'authorized' on the one legacy-marker row (live
 *   2026-10-14: exactly one, user 6, which already holds the `su` role since
 *   stage 1 — scripts/accessA2SuRole.js).
 *
 * ref/ACCESS_CONTROL_DESIGN.md §2.4. The applied SQL is recorded in
 * ref/migrations/2026-10-14_access_a2b_user_auth_collapse.sql.
 *
 * SEQUENCE — this script runs LAST:
 *   1. Fred logs in again (his fresh JWT carries the `su` roles claim).
 *   2. Land + deploy the A2b backend AND frontend (SU is the role only; the
 *      string confers nothing; SU pages gate on currentUser.roles).
 *   3. THIS script.
 * Running it before step 2 would hide every SU page from its holder: the
 * pre-A2b frontend gates SU UI on the literal string. Running it after is
 * pure hygiene — the deployed code already ignores the string — so there is
 * no urgency and no rollback concern: the row keeps `su` either way.
 *
 * Saving user 6 in the Users pane after the deploy also writes 'authorized'
 * (routes/admin.users.js compares login status) — then this script finds
 * nothing left and says GO as a no-op.
 *
 * USAGE (repo root, .env reaches production — same setup as npm run db:ref):
 *
 *   node scripts/accessA2bCollapse.js           # CHECK — read-only, prints plan
 *   node scripts/accessA2bCollapse.js --apply   # run it
 *
 * Both end with ONE line: GO or NO-GO, naming the next command. --apply is
 * resumable: it reads the live state every time and does only what is left.
 * One row UPDATE, no DDL — no lock_wait_timeout concern — but the base state
 * is asserted before any write all the same.
 */

'use strict';

const LEGACY_SU = 'authorized - SU';
const EXPECTED_USER = 6;                       // verified live 2026-10-14
const KNOWN_AUTH = ['authorized', 'disabled', LEGACY_SU];

const COLLAPSE_SQL =
  "UPDATE users SET user_auth = 'authorized' " +
  "WHERE `user` = ? AND user_auth = ? AND FIND_IN_SET('su', roles)";

const holdsSu = (csv) =>
  String(csv || '').split(',').map(s => s.trim()).filter(Boolean).includes('su');

async function legacyRows(conn) {
  const [rows] = await conn.query(
    'SELECT `user`, username, user_auth, roles FROM users WHERE user_auth = ?', [LEGACY_SU]
  );
  return rows;
}

async function authValues(conn) {
  const [rows] = await conn.query('SELECT DISTINCT user_auth FROM users');
  return rows.map(r => r.user_auth);
}

async function activeSuHolders(conn) {
  const [rows] = await conn.query(
    "SELECT `user`, username FROM users WHERE FIND_IN_SET('su', roles) AND user_auth LIKE 'authorized%'"
  );
  return rows;
}

async function run(conn, { apply }) {
  const mode = apply ? 'APPLY' : 'CHECK';
  console.log(`accessA2bCollapse — ${mode} — ${new Date().toISOString()}\n`);

  // ── base state ────────────────────────────────────────────────────────────
  const vals = await authValues(conn);
  const odd = vals.filter(v => !KNOWN_AUTH.includes(v));
  console.log(`user_auth values: ${vals.map(v => `'${v}'`).join(', ')}`);
  if (odd.length) {
    console.log(`Unexpected user_auth value(s): ${odd.map(v => `'${v}'`).join(', ')}.`);
    console.log('\nNO-GO — the users table moved since this script was written. Re-verify before touching it. Nothing was changed.');
    return { ok: false };
  }

  const su = await activeSuHolders(conn);
  console.log(`active su-role holders: ${su.length ? su.map(r => `user ${r.user} (${r.username})`).join(', ') : 'NONE'}`);
  if (!su.length) {
    console.log('\nNo enabled user holds the su role — collapsing now would leave the tenant without a superuser.');
    console.log('NO-GO — run scripts/accessA2SuRole.js (stage 1) first. Nothing was changed.');
    return { ok: false };
  }

  const rows = await legacyRows(conn);
  console.log(`legacy-SU rows (user_auth = '${LEGACY_SU}'): ${rows.length}`);
  for (const r of rows) console.log(`  user ${r.user} (${r.username}) roles='${r.roles}'`);

  if (!rows.length) {
    console.log('\nGO — stage 3 is already applied; nothing to do. The access-control A2b cutover is complete.');
    return { ok: true };
  }

  const row = rows[0];
  if (rows.length !== 1 || Number(row.user) !== EXPECTED_USER || !holdsSu(row.roles)) {
    console.log(`\nExpected EXACTLY ONE legacy-SU row — user ${EXPECTED_USER}, already holding 'su' (design §2.4, verified live 2026-10-14).`);
    console.log('NO-GO — re-verify before touching it. Nothing was changed.');
    return { ok: false };
  }

  if (!apply) {
    console.log(`\nPlan:\n  ${COLLAPSE_SQL}   -- [${row.user}, '${LEGACY_SU}']\n`);
    console.log('GO — base state matches. Next: node scripts/accessA2bCollapse.js --apply');
    return { ok: true };
  }

  // ── apply ────────────────────────────────────────────────────────────────
  const [res] = await conn.query(COLLAPSE_SQL, [row.user, LEGACY_SU]);
  const [[after]] = await conn.query(
    'SELECT `user`, username, user_auth, roles FROM users WHERE `user` = ?', [row.user]
  );
  const left = await legacyRows(conn);
  if (res.affectedRows !== 1 || !after || after.user_auth !== 'authorized' || !holdsSu(after.roles) || left.length) {
    console.log(`UPDATE affected ${res.affectedRows} row(s); user ${row.user} now user_auth='${after && after.user_auth}' roles='${after && after.roles}'; ${left.length} legacy row(s) left.`);
    console.log('\nNO-GO — verify by hand before rerunning.');
    return { ok: false };
  }
  console.log(`✓ user ${after.user} (${after.username}) user_auth='authorized' roles='${after.roles}'`);

  console.log('\nGO — stage 3 applied and verified. The access-control A2b cutover is complete.');
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────

if (require.main === module) {
  const path = require('path');
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const mysql = require('mysql2');
  const { ensureSqlProxy } = require('./ensure-sql-proxy');
  const apply = process.argv.includes('--apply');
  (async () => {
    let conn;
    try {
      const proxy = await ensureSqlProxy();
      if (proxy.status === 'failed') throw new Error(`the Cloud SQL proxy is not working: ${proxy.reason}`);
      for (const k of ['host', 'user', 'password', 'database']) {
        if (!process.env[k]) throw new Error(`missing env var "${k}" (is .env present?)`);
      }
      conn = mysql.createConnection({
        host: process.env.host, user: process.env.user, password: process.env.password,
        database: process.env.database, timezone: 'Z', connectTimeout: 15_000,
      }).promise();
      const r = await run(conn, { apply });
      process.exitCode = r.ok ? 0 : 1;
    } catch (err) {
      console.log(`\n${err.message}\n\nNO-GO — could not ${conn ? 'finish' : 'connect'}. Nothing was changed unless a line above says ✓.`);
      process.exitCode = 1;
    } finally {
      if (conn) await conn.end().catch(() => {});
    }
  })();
}

module.exports = { run, COLLAPSE_SQL, LEGACY_SU, EXPECTED_USER };
