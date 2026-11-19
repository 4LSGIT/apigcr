#!/usr/bin/env node
// scripts/bookingRedirectColumn.js
//
/**
 * Booking redirect — booking_views.redirect_url, where the widget sends the
 * visitor after a booking (routes/booking.js successBody, public/book.html
 * afterBooked). The applied SQL is recorded in
 * ref/migrations/2026-11-19_booking_views_redirect_url.sql.
 *
 * MUST RUN BEFORE the code lands: routes/api.bookingViews.js writes every
 * FIELDS column on every create and save, redirect_url included, so the new
 * code on the old table refuses every booking-view save.
 *
 * USAGE (from a checkout of the COMMITTED sha, whose .env reaches production):
 *
 *   node scripts/bookingRedirectColumn.js            # CHECK — read-only
 *   node scripts/bookingRedirectColumn.js --apply    # run it
 *
 * Both end on ONE GO / NO-GO line. --apply reads the live state every time and
 * does only what is left.
 *
 * WHY A NODE SCRIPT ON ONE CONNECTION: lock_wait_timeout must reach the ALTER.
 * Every ALTER takes an exclusive metadata lock; one queued behind a long
 * transaction stalls every query on the table, and the global default is a
 * year. booking_views is read by every public booking page open.
 *
 * ALGORITHM=INSTANT makes a refused plan fail instead of rebuilding the table
 * (INSTANT at a named position needs MySQL 8.0.29+; production is 8.4). The
 * column is nullable with no default and nothing is backfilled — every
 * existing view keeps today's behaviour (stay on the thank-you) — so no
 * existing value changes and there is nothing to back up.
 */
'use strict';

const path = require('path');

const COLUMN = 'redirect_url';
const COMMENT = 'https URL the booking widget sends the visitor to after a booking, once the thank-you has shown; in an iframe the host page redirects via the embed snippet. NULL = stay on the thank-you. https-only, app-validated (routes/api.bookingViews.js)';
const DDL = `ALTER TABLE booking_views
  ADD COLUMN ${COLUMN} varchar(500) NULL DEFAULT NULL COMMENT ${JSON.stringify(COMMENT).replace(/"/g, "'")} AFTER thankyou_html,
  ALGORITHM=INSTANT`;

async function columnNow(conn) {
  const [rows] = await conn.query(
    `SELECT COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt, COLUMN_COMMENT AS comment
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'booking_views' AND COLUMN_NAME = ?`,
    [COLUMN]);
  return rows[0] || null;
}

function assertShape(got) {
  if (got.type !== 'varchar(500)' || got.nullable !== 'YES' || got.dflt !== null || got.comment !== COMMENT) {
    throw new Error(`booking_views.${COLUMN} exists with the wrong shape (${got.type}, nullable ${got.nullable}, default ${got.dflt})`);
  }
}

async function run(conn, { apply, log = console.log }) {
  await conn.query('SET SESSION lock_wait_timeout = 5');

  const [[{ anchor }]] = await conn.query(
    `SELECT COUNT(*) AS anchor FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'booking_views' AND COLUMN_NAME = 'thankyou_html'`);
  if (!Number(anchor)) throw new Error('booking_views.thankyou_html is missing — this is not the expected table');

  const live = await columnNow(conn);
  if (live) assertShape(live);
  const [[{ total }]] = await conn.query('SELECT COUNT(*) AS total FROM booking_views');
  log(`booking_views: ${total} rows`);
  log(`${COLUMN}: ${live ? 'already there' : 'to add'}`);

  if (live) {
    log('\nGO — nothing left to do.');
    return { ok: true };
  }
  if (!apply) {
    log('\nGO — CHECK passed, nothing written. Next: node scripts/bookingRedirectColumn.js --apply');
    return { ok: true };
  }

  await conn.query(DDL);
  log(`  ✓ added ${COLUMN}`);

  // End state, read fresh.
  const after = await columnNow(conn);
  if (!after) throw new Error(`${COLUMN} did not land`);
  assertShape(after);
  const [[end]] = await conn.query(
    `SELECT COUNT(*) AS total, SUM(${COLUMN} IS NOT NULL) AS set_rows FROM booking_views`);
  if (Number(end.total) !== Number(total)) throw new Error(`row count moved from ${total} to ${end.total}`);
  if (Number(end.set_rows)) throw new Error(`${end.set_rows} view(s) already carry a redirect with no code writing it`);
  log('\nGO — column live, every view NULL (no redirect). Next: land the booking-redirect code.');
  return { ok: true };
}

module.exports = { run, COLUMN, COMMENT, DDL };

if (require.main === module) {
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
      console.log(`\n${err.message}\n\nNO-GO — stopped. A ✓ above is what landed; rerun to resume.`);
      process.exitCode = 1;
    } finally {
      if (conn) await conn.end().catch(() => {});
      process.exit();
    }
  })();
}
