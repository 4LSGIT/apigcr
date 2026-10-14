#!/usr/bin/env node
// scripts/accessA2SuRole.js
//
/**
 * Access-control A2, stage 1 — the `su` role member.
 *
 *   1. ALTER users.roles: append SET member 'su' (APPEND-ONLY — never
 *      reorder or remove SET members; ALGORITHM=INPLACE, LOCK=NONE so the
 *      statement REFUSES rather than copy the table).
 *   2. Grant 'su' to the row(s) whose user_auth is the legacy
 *      'authorized - SU' marker (live 2026-10-14: exactly one, user 6).
 *
 * ref/ACCESS_CONTROL_DESIGN.md §2.4. The applied SQL is recorded in
 * ref/migrations/2026-10-14_access_a2_su_role.sql.
 *
 * Deploy order (design §2.4): run THIS, then land + deploy the A2 backend
 * (dual-accept isSuperuser). Old backend ignores the new member, so this is
 * safe to run first — and MUST run first (SQL → backend → frontend).
 * user_auth collapse ('authorized - SU' → 'authorized') is stage 3, slice
 * A2b, NOT this script: 11 frontend files still gate on the string.
 *
 * USAGE (repo root, .env reaches production — same setup as npm run db:ref):
 *
 *   node scripts/accessA2SuRole.js           # CHECK — read-only, prints plan
 *   node scripts/accessA2SuRole.js --apply   # run it
 *
 * Both end with ONE line: GO or NO-GO, naming the next command. --apply is
 * resumable: it reads the live state every time and does only what is left.
 *
 * ── WHY A NODE SCRIPT ON ONE CONNECTION (not the SU console) ──────────────
 * The ALTER takes an exclusive metadata lock on `users` — a table touched by
 * nearly every request. lock_wait_timeout must be LOW on the SAME session
 * (global default is a year; a wait queued behind a long transaction stalls
 * every query on the table). /admin/db/batch cannot pin session settings to
 * statements.
 */

'use strict';

const CUR_SET = "set('it','admin','staff','attorney','automation','form_dev')";
const NEW_SET = "set('it','admin','staff','attorney','automation','form_dev','su')";
const LEGACY_SU = 'authorized - SU';

const ALTER_SQL =
  "ALTER TABLE `users` MODIFY `roles` " +
  "SET('it','admin','staff','attorney','automation','form_dev','su') " +
  "CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '', " +
  'ALGORITHM=INPLACE, LOCK=NONE';

const GRANT_SQL =
  "UPDATE users SET roles = CONCAT_WS(',', NULLIF(roles,''), 'su') " +
  "WHERE user_auth = ? AND NOT FIND_IN_SET('su', roles)";

async function colInfo(conn) {
  const [[row]] = await conn.query(
    `SELECT COLUMN_TYPE ct, COLLATION_NAME coll, COLUMN_COMMENT cmt
       FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'roles'`
  );
  return row
    ? { ct: String(row.ct).toLowerCase(), coll: row.coll, cmt: row.cmt }
    : null;
}

async function suRows(conn) {
  const [rows] = await conn.query(
    'SELECT `user`, username, user_auth, roles FROM users WHERE user_auth = ?', [LEGACY_SU]
  );
  return rows;
}

const holdsSu = (csv) =>
  String(csv || '').split(',').map(s => s.trim()).filter(Boolean).includes('su');

async function run(conn, { apply }) {
  const mode = apply ? 'APPLY' : 'CHECK';
  console.log(`accessA2SuRole — ${mode} — ${new Date().toISOString()}\n`);

  // ── base state ────────────────────────────────────────────────────────────
  const info = await colInfo(conn);
  if (!info) { console.log('users.roles column not found.'); console.log('\nNO-GO — wrong database? Nothing was changed.'); return { ok: false }; }
  const ct = info.ct;

  // The MODIFY restates collation and omits COMMENT — under INPLACE a MODIFY
  // silently drops an existing column comment. Live roles carries none and
  // uses the table collation; anything else means the column moved since this
  // script was written (review finding A2-F5).
  if (info.coll !== 'utf8mb4_general_ci' || (info.cmt || '') !== '') {
    console.log(`users.roles collation/comment unexpected: collation='${info.coll}', comment='${info.cmt}'.`);
    console.log('\nNO-GO — the MODIFY here would rewrite them; re-verify before touching it. Nothing was changed.');
    return { ok: false };
  }

  let alterNeeded;
  if (ct === CUR_SET) alterNeeded = true;
  else if (ct === NEW_SET) alterNeeded = false;        // resume: already altered
  else {
    console.log(`users.roles COLUMN_TYPE is neither the expected current nor the target SET:\n  live:   ${ct}\n  expect: ${CUR_SET}\n  target: ${NEW_SET}`);
    console.log('\nNO-GO — the schema moved since this script was written. Re-verify before touching it. Nothing was changed.');
    return { ok: false };
  }

  const rows = await suRows(conn);
  console.log(`roles SET:    ${alterNeeded ? "needs 'su' appended" : "already has 'su' ✓"}`);
  console.log(`legacy-SU rows (user_auth = '${LEGACY_SU}'): ${rows.length}`);
  for (const r of rows) console.log(`  user ${r.user} (${r.username}) roles='${r.roles}'${holdsSu(r.roles) ? " — already holds 'su' ✓" : ''}`);

  const grantNeeded = rows.filter(r => !holdsSu(r.roles));

  if (rows.length !== 1 && (alterNeeded || grantNeeded.length)) {
    console.log(`\nExpected EXACTLY ONE legacy-SU row (design §2.4, verified live 2026-10-14: user 6). Found ${rows.length}.`);
    console.log('\nNO-GO — the users table moved since this script was written. Re-verify before touching it. Nothing was changed.');
    return { ok: false };
  }

  if (!alterNeeded && !grantNeeded.length) {
    console.log('\nGO — stage 1 is already fully applied; nothing to do. Next: land + deploy the A2 backend.');
    return { ok: true };
  }

  if (!apply) {
    console.log(`\nPlan:\n${alterNeeded ? '  ' + ALTER_SQL + '\n' : ''}${grantNeeded.length ? `  grant 'su' to user ${grantNeeded[0].user} (${grantNeeded[0].username})\n` : ''}`);
    console.log('GO — base state matches. Next: node scripts/accessA2SuRole.js --apply');
    return { ok: true };
  }

  // ── apply ────────────────────────────────────────────────────────────────
  // Low metadata-lock patience BEFORE the ALTER (fieldDefReconciler rule).
  await conn.query('SET SESSION lock_wait_timeout = 5');

  if (alterNeeded) {
    await conn.query(ALTER_SQL);
    const after = (await colInfo(conn))?.ct;
    if (after !== NEW_SET) { console.log(`ALTER ran but COLUMN_TYPE is '${after}', not the target.`); console.log('\nNO-GO — verify by hand before rerunning.'); return { ok: false }; }
    console.log("✓ ALTER applied — roles SET now ends with 'su'");
  }

  if (grantNeeded.length) {
    const [res] = await conn.query(GRANT_SQL, [LEGACY_SU]);
    const verify = await suRows(conn);
    const bad = verify.filter(r => !holdsSu(r.roles));
    if (res.affectedRows !== grantNeeded.length || bad.length) {
      console.log(`UPDATE affected ${res.affectedRows} row(s), expected ${grantNeeded.length}; ${bad.length} still missing 'su'.`);
      console.log('\nNO-GO — verify by hand before rerunning.');
      return { ok: false };
    }
    for (const r of verify) console.log(`✓ user ${r.user} (${r.username}) roles='${r.roles}'`);
  }

  console.log('\nGO — stage 1 applied and verified. Next: land + deploy the A2 backend (then A2b ≥24h later).');
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

module.exports = { run, ALTER_SQL, GRANT_SQL, CUR_SET, NEW_SET };
