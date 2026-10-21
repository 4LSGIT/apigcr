#!/usr/bin/env node
// scripts/reportGrantUserProvision.js
//
/**
 * Report/assistant DB grant user — provision a MySQL user whose privileges are
 * PER-TABLE and PER-COLUMN, generated from lib/reportSchema/manifest, to
 * replace the schema-wide `SELECT` the reports + Ask Casey engines run on today
 * (the `yc_ro` user used by startup/dbReadonly).
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 * The report SQL validator (lib/reportSchema/validator.js) is an app-layer
 * allowlist. It was hardened (2026-10-21) so the table allowlist and the
 * SELECT-* ban can no longer be side-stepped by alternative join/statement
 * spellings, with a word-scan belt on the credential/content tables. But the
 * pool behind it still holds SELECT on the WHOLE schema, so the validator is
 * the ONLY thing standing between a staff JWT and app_settings secrets,
 * email_ingest_sources.api_key, users.password, contact_ssn via a path the
 * validator didn't anticipate, and every other user's assistant chat. Fred
 * ratified the real fix (review 2026-10-21, Q1): a MySQL user that physically
 * cannot read anything outside the curated set, so a future validator gap is a
 * failed query, not a breach.
 *
 * This generates GRANT SELECT(col, …) ON <db>.<table> for exactly the manifest
 * allowlist, with the manifest's DENIED_COLUMNS (password/password_hash/reset_*,
 * the access tokens, the raw `custom` JSON bag) withheld at the column level.
 * Tables absent from the allowlist — app_settings, email_ingest_sources,
 * assistant_chats, assistant_chat_messages, the backup/junk tables, everything
 * — get no grant at all and become unreadable through this user.
 *
 * ── THIS IS A DRAFT ───────────────────────────────────────────────────────────
 * Fred provisions this by hand later; the executor that wrote it does NOT run
 * it. CHECK mode is read-only (information_schema + SHOW GRANTS) and prints the
 * exact statement plan. --apply creates/rewrites the grants on ONE connection,
 * verifies the end state from SHOW GRANTS, and ends on one GO / NO-GO line.
 * Before anything lands, startup/dbReadonly (and any reports/assistant wiring)
 * must point at the new user's credentials — that switch is a separate slice,
 * out of this script's scope. See ref/plans.md "Report/assistant least-
 * privilege DB user".
 *
 * ── USAGE ──────────────────────────────────────────────────────────────────────
 *   REPORT_DB_USER=<name> \
 *     node scripts/reportGrantUserProvision.js            # CHECK — read-only plan
 *
 *   REPORT_DB_USER=<name> REPORT_DB_PASSWORD=<secret> \
 *     admin_user=root admin_password=<root pw> \
 *     node scripts/reportGrantUserProvision.js --apply    # create + grant + verify
 *
 *   ... --apply --rotate     # the account already exists: set the NEW password
 *                            # (CREATE USER IF NOT EXISTS silently KEEPS the old
 *                            # one, so a plain --apply refuses an existing user)
 *
 * The connection is the admin `.env` login or the admin_* overrides — CREATE
 * USER / GRANT OPTION are global privileges the app user (`yc_app`) does not
 * hold, so point admin_user/admin_password at root through the Auth Proxy.
 * The NEW user's name and password come from env only — NEVER a CLI arg
 * (shell history) and NEVER committed. `REPORT_DB_HOST` is the host half of
 * the ACCOUNT name (`'<user>'@'<host>'`), not a server address, and defaults
 * to '%': Cloud Run reaches Cloud SQL over the connector socket and presents
 * as `cloudsqlproxy~…` (ref/INFRA_GCP.md §1/§5 — the service has no fixed
 * egress IP), so an IP-bound account would never match a production
 * connection. '%' matches how `yc_ro` is scoped (AI_CONTEXT); exposure is
 * unchanged — the instance takes connections only from the connector and the
 * one authorized network, and the account is password-protected.
 *
 * ── CONVENTIONS (CLAUDE.md "A migration that needs a session") ─────────────────
 * One connection from .env, read-only CHECK by default, --apply asserts live
 * state → writes → verifies end state, one GO / NO-GO line. GRANT/REVOKE take no
 * table metadata lock, so no lock_wait_timeout dance is needed; FLUSH PRIVILEGES
 * is issued after the account changes. --apply is resumable: it reads SHOW
 * GRANTS every run and converges to the generated plan.
 */

const path = require('path');

const {
  ALLOWED_TABLES,
  DENIED_COLUMNS,
} = require(path.join(__dirname, '..', 'lib', 'reportSchema', 'manifest'));

const DENIED_COL_SET = new Set(DENIED_COLUMNS.map((c) => c.toLowerCase()));

// Backtick-quote a MySQL identifier (table or column). Identifiers from the
// manifest and information_schema only; a backtick inside one is doubled.
const q = (id) => '`' + String(id).replace(/`/g, '``') + '`';
const quser = (u) => "'" + String(u).replace(/'/g, "''") + "'";

/**
 * Build the per-table column allowlist from the LIVE schema: every real column
 * of an allowlisted table, minus the manifest's DENIED_COLUMNS. Reading
 * information_schema (not the manifest's hand-listed columns) is deliberate —
 * the manifest treats columns as opt-OUT (anything not denied is selectable, so
 * the validator admits it), and that is the policy the grant must mirror exactly,
 * including the generated `cf_*` custom-field columns.
 *
 * @returns {Promise<{plan: Array<{table,columns,missingDenied}>, errors: string[]}>}
 */
async function buildPlan(conn, db) {
  const tables = [...ALLOWED_TABLES].sort();
  const plan = [];
  const errors = [];

  for (const table of tables) {
    const [rows] = await conn.query(
      'SELECT COLUMN_NAME FROM information_schema.columns ' +
        'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
      [db, table]
    );
    if (!rows.length) {
      errors.push(`allowlisted table "${table}" has no columns in ${db} (missing table?)`);
      continue;
    }
    const all = rows.map((r) => r.COLUMN_NAME);
    const columns = all.filter((c) => !DENIED_COL_SET.has(c.toLowerCase()));
    const withheld = all.filter((c) => DENIED_COL_SET.has(c.toLowerCase()));
    if (!columns.length) {
      errors.push(`allowlisted table "${table}" would grant ZERO columns (all denied?) — skipped`);
      continue;
    }
    plan.push({ table, columns, withheld });
  }
  return { plan, errors };
}

/** The GRANT statements for a plan, one per table, as text. */
function grantStatements(plan, db, account) {
  return plan.map(
    ({ table, columns }) =>
      `GRANT SELECT (${columns.map(q).join(', ')}) ON ${q(db)}.${q(table)} TO ${account};`
  );
}

/**
 * Create the account, or rotate its password when it already exists.
 * CREATE USER IF NOT EXISTS silently KEEPS an existing account's password, so
 * an --apply against an existing account would leave the old secret live while
 * the operator believes the new one is set. Fail closed: an existing account
 * is a NO-GO unless --rotate was asked for, and --rotate on a missing account
 * is a NO-GO too (a typo must not quietly create a second user).
 * The probe reads mysql.user, which the privileged admin login (required for
 * CREATE USER anyway) can see.
 */
async function ensureAccount(conn, { account, userName, userHost, password, rotate }) {
  const [[row]] = await conn.query(
    'SELECT COUNT(*) AS n FROM mysql.user WHERE user = ? AND host = ?',
    [userName, userHost]
  );
  const exists = Number(row.n) > 0;
  if (exists && !rotate) {
    return { ok: false, reason: `${account} already exists — CREATE USER IF NOT EXISTS would silently keep its OLD password. Re-run with --rotate to set the new one.` };
  }
  if (!exists && rotate) {
    return { ok: false, reason: `${account} does not exist — --rotate only rotates an existing account. Run --apply without it to create.` };
  }
  if (exists) {
    await conn.query(`ALTER USER ${account} IDENTIFIED BY ?`, [password]);
    return { ok: true, did: 'ALTER USER (password rotated)' };
  }
  await conn.query(`CREATE USER IF NOT EXISTS ${account} IDENTIFIED BY ?`, [password]);
  return { ok: true, did: 'CREATE USER' };
}

/**
 * @param {object} conn  mysql2 promise connection (admin)
 * @param {object} opts  { apply, db, userName, userHost, password, rotate }
 */
async function run(conn, opts) {
  const { apply, db, userName, userHost } = opts;
  const account = `${quser(userName)}@${quser(userHost)}`;

  console.log(`Report/assistant grant user: ${account} on database ${q(db)}`);
  console.log(`Mode: ${apply ? 'APPLY' : 'CHECK (read-only)'}\n`);

  const { plan, errors } = await buildPlan(conn, db);
  if (errors.length) {
    console.log('Schema mismatches (resolve before --apply):');
    for (const e of errors) console.log(`  ⚠ ${e}`);
    console.log('');
  }

  const grants = grantStatements(plan, db, account);
  const totalCols = plan.reduce((n, p) => n + p.columns.length, 0);
  const totalWithheld = plan.reduce((n, p) => n + p.withheld.length, 0);

  console.log(`Plan: ${plan.length} tables, ${totalCols} columns granted, ${totalWithheld} denied-column(s) withheld.`);
  for (const p of plan) {
    const w = p.withheld.length ? `  (withheld: ${p.withheld.join(', ')})` : '';
    console.log(`  ${p.table}: ${p.columns.length} col(s)${w}`);
  }
  console.log('\nStatements that WOULD run on --apply:');
  console.log(`  CREATE USER IF NOT EXISTS ${account} IDENTIFIED BY <REPORT_DB_PASSWORD>;   -- or ALTER USER … with --rotate`);
  console.log(`  REVOKE ALL PRIVILEGES, GRANT OPTION FROM ${account};`);
  for (const g of grants) console.log(`  ${g}`);
  console.log('  FLUSH PRIVILEGES;\n');

  if (!apply) {
    if (errors.length) {
      console.log('NO-GO — CHECK found schema mismatches above. Fix the manifest/schema, re-run CHECK.');
      return { ok: false };
    }
    console.log('GO (CHECK only) — re-run with REPORT_DB_PASSWORD set and --apply to provision. Nothing was changed.');
    return { ok: true };
  }

  if (errors.length) {
    console.log('NO-GO — refusing to --apply with unresolved schema mismatches above.');
    return { ok: false };
  }
  if (!opts.password) {
    console.log('NO-GO — --apply needs REPORT_DB_PASSWORD in the environment (never on the CLI).');
    return { ok: false };
  }

  // Apply. Create or rotate, strip everything, re-grant the plan, flush.
  const made = await ensureAccount(conn, { account, userName, userHost, password: opts.password, rotate: opts.rotate });
  if (!made.ok) {
    console.log(`\nNO-GO — ${made.reason}`);
    return { ok: false };
  }
  console.log(`✓ ${made.did} ${account}`);
  await conn.query(`REVOKE ALL PRIVILEGES, GRANT OPTION FROM ${account}`);
  console.log(`✓ REVOKE ALL from ${account}`);
  for (const g of grants) await conn.query(g);
  console.log(`✓ GRANT SELECT per column on ${plan.length} tables`);
  await conn.query('FLUSH PRIVILEGES');
  console.log('✓ FLUSH PRIVILEGES');

  // Verify end state from SHOW GRANTS — the account must hold a grant line for
  // every allowlisted table and NONE for a denied one.
  const [shown] = await conn.query(`SHOW GRANTS FOR ${account}`);
  const lines = shown.map((r) => Object.values(r)[0]);
  const text = lines.join('\n');
  const missing = plan.filter((p) => !new RegExp(`\\b${p.table}\\b`, 'i').test(text));
  // A denied table name must not appear anywhere in the grants.
  const forbidden = ['app_settings', 'email_ingest_sources', 'assistant_chats', 'assistant_chat_messages']
    .filter((t) => new RegExp(`\\b${t}\\b`, 'i').test(text));

  console.log('\nSHOW GRANTS:');
  for (const l of lines) console.log(`  ${l}`);

  if (missing.length || forbidden.length) {
    if (missing.length) console.log(`\n⚠ missing grant for: ${missing.map((p) => p.table).join(', ')}`);
    if (forbidden.length) console.log(`⚠ UNEXPECTED grant touching: ${forbidden.join(', ')}`);
    console.log('\nNO-GO — end state does not match the plan. Investigate before pointing any pool at this user.');
    return { ok: false };
  }

  console.log(
    `\nGO — ${account} can read exactly the curated set (${plan.length} tables, ${totalCols} columns). ` +
      'Next: switch startup/dbReadonly (reports+assistant) to these credentials in its own slice, ' +
      'deploy, then confirm a representative report still runs.'
  );
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────
if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const mysql = require('mysql2');
  const apply = process.argv.includes('--apply');

  const rotate = process.argv.includes('--rotate');
  const userName = process.env.REPORT_DB_USER;
  const userHost = process.env.REPORT_DB_HOST || '%';   // account host half — see USAGE
  const password = process.env.REPORT_DB_PASSWORD || null;

  // Admin connection: default to the .env app login; allow admin_* overrides for
  // a privileged account that holds GRANT OPTION.
  const adminHost = process.env.admin_host || process.env.host;
  const adminUser = process.env.admin_user || process.env.user;
  const adminPass = process.env.admin_password || process.env.password;
  const db = process.env.database;

  (async () => {
    let conn;
    try {
      if (!userName) throw new Error('set REPORT_DB_USER to the grant user name (env only, not a CLI arg)');
      for (const [k, v] of Object.entries({ host: adminHost, user: adminUser, password: adminPass, database: db })) {
        if (!v) throw new Error(`missing admin connection env "${k}" (is .env present?)`);
      }
      // Optional on-demand Cloud SQL proxy, same opt-in as the other scripts.
      try {
        const { ensureSqlProxy } = require('./ensure-sql-proxy');
        const proxy = await ensureSqlProxy();
        if (proxy && proxy.status === 'failed') throw new Error(`the Cloud SQL proxy is not working: ${proxy.reason}`);
      } catch (e) {
        if (/proxy is not working/.test(e.message)) throw e;
        // ensure-sql-proxy is inert without DEV_SQL_PROXY_INSTANCE — ignore.
      }
      conn = mysql
        .createConnection({
          host: adminHost, user: adminUser, password: adminPass,
          database: db, timezone: 'Z', connectTimeout: 15_000,
        })
        .promise();
      const r = await run(conn, { apply, db, userName, userHost, password, rotate });
      process.exitCode = r.ok ? 0 : 1;
    } catch (err) {
      console.log(`\n${err.message}\n\nNO-GO — could not ${conn ? 'finish' : 'start'}. Nothing was changed unless a ✓ line says so.`);
      process.exitCode = 1;
    } finally {
      if (conn) await conn.end().catch(() => {});
    }
  })();
}

module.exports = { buildPlan, grantStatements, ensureAccount, run };
