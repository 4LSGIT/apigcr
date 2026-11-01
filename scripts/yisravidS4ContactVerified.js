#!/usr/bin/env node
// scripts/yisravidS4ContactVerified.js
//
/**
 * YisraVideo S4 — video_views.contact_verified, what lets a view announce an
 * event. The applied SQL is recorded in
 * ref/migrations/2026-11-01_yisravid_s4_contact_verified.sql.
 *
 * MUST RUN BEFORE the S4 code lands: recordView inserts this column, so the new
 * code on the old table records no view at all.
 *
 * USAGE (from a checkout of the COMMITTED sha, whose .env reaches production):
 *
 *   node scripts/yisravidS4ContactVerified.js                             # CHECK — read-only
 *   node scripts/yisravidS4ContactVerified.js --apply --backup-dir <dir>  # run it
 *
 * Both end on ONE GO / NO-GO line. --apply reads the live state every time and
 * does only what is left.
 *
 * WHY A NODE SCRIPT ON ONE CONNECTION: lock_wait_timeout must reach the ALTER.
 * Every ALTER takes an exclusive metadata lock; one queued behind a long
 * transaction stalls every query on the table, and the global default is a
 * year. video_views takes a write on every public page open.
 *
 * ALGORITHM=INSTANT makes a refused plan fail instead of rebuilding the table.
 * No backfill: nothing recorded how an older view's contact was resolved, so
 * those views stay 0, which is the safe reading.
 *
 * BACKUP: --apply writes every video_views row to <dir> first (JSON, mode 0600)
 * and re-reads it to prove the file before the ALTER. Pass an absolute path
 * outside the worktree.
 */
'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const COLUMN = 'contact_verified';
const COMMENT = '1 = contact_id came from a ?ct= token; 0 = a ?c= integer anyone can type, no contact, or a view from before this column. Only 1 may fire video.* events';
const DDL = `ALTER TABLE video_views
  ADD COLUMN ${COLUMN} tinyint(1) NOT NULL DEFAULT '0' COMMENT ${JSON.stringify(COMMENT).replace(/"/g, "'")},
  ALGORITHM=INSTANT`;

async function columnNow(conn) {
  const [rows] = await conn.query(
    `SELECT COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt, COLUMN_COMMENT AS comment
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'video_views' AND COLUMN_NAME = ?`,
    [COLUMN]);
  return rows[0] || null;
}

function assertShape(got) {
  if (got.type !== 'tinyint(1)' || got.nullable !== 'NO' || String(got.dflt) !== '0' || got.comment !== COMMENT) {
    throw new Error(`video_views.${COLUMN} exists with the wrong shape (${got.type}, default ${got.dflt})`);
  }
}

async function writeBackup(conn, dir, log) {
  if (!dir || !path.isAbsolute(dir)) throw new Error('--apply needs --backup-dir <absolute path>');
  fs.mkdirSync(dir, { recursive: true });
  const [rows] = await conn.query('SELECT * FROM video_views');
  const takenAt = new Date().toISOString();
  const body = JSON.stringify({ taken_at: takenAt, video_views: rows }, null, 1);
  const file = path.join(dir, `yisravid-s4-${takenAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, body, { mode: 0o600, flag: 'wx' });
  const back = fs.readFileSync(file, 'utf8');
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  if (crypto.createHash('sha256').update(back).digest('hex') !== sha) throw new Error('the backup did not read back identically');
  if (JSON.parse(back).video_views.length !== rows.length) throw new Error('the backup row count does not match');
  log(`  ✓ backup ${file}`);
  log(`    sha256 ${sha} — ${rows.length} views`);
}

async function run(conn, { apply, backupDir, log = console.log }) {
  await conn.query('SET SESSION lock_wait_timeout = 5');

  const [[{ tables }]] = await conn.query(
    `SELECT COUNT(*) AS tables FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'video_views' AND COLUMN_NAME = 'track_token'`);
  if (!Number(tables)) throw new Error('video_views.track_token is missing — this is not the expected table');

  const live = await columnNow(conn);
  if (live) assertShape(live);
  const [[{ total }]] = await conn.query('SELECT COUNT(*) AS total FROM video_views');
  log(`video_views: ${total} rows`);
  log(`${COLUMN}: ${live ? 'already there' : 'to add'}`);

  if (live) {
    log('\nGO — nothing left to do.');
    return { ok: true };
  }
  if (!apply) {
    log('\nGO — CHECK passed, nothing written. Next: node scripts/yisravidS4ContactVerified.js --apply --backup-dir <abs dir>');
    return { ok: true };
  }

  await writeBackup(conn, backupDir, log);
  await conn.query(DDL);
  log(`  ✓ added ${COLUMN}`);

  // End state, read fresh.
  const after = await columnNow(conn);
  if (!after) throw new Error(`${COLUMN} did not land`);
  assertShape(after);
  const [[end]] = await conn.query(
    `SELECT COUNT(*) AS total, SUM(${COLUMN} <> 0) AS verified FROM video_views`);
  if (Number(end.total) < total) throw new Error(`row count fell from ${total} to ${end.total}`);
  if (Number(end.verified)) throw new Error(`${end.verified} view(s) read verified with no code writing it`);
  log('\nGO — column live, no view verified yet. Next: land the S4 code.');
  return { ok: true };
}

module.exports = { run, COLUMN, COMMENT, DDL };

if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const mysql = require('mysql2');
  const { ensureSqlProxy } = require('./ensure-sql-proxy');
  const apply = process.argv.includes('--apply');
  const i = process.argv.indexOf('--backup-dir');
  const backupDir = i > -1 ? process.argv[i + 1] : null;
  (async () => {
    let conn;
    try {
      const testUrl = process.env.YV_TEST_DB_URL;
      if (testUrl) {
        if (!/_test$/.test(new URL(testUrl).pathname)) throw new Error('YV_TEST_DB_URL must name a *_test database');
        conn = mysql.createConnection({ uri: testUrl, timezone: 'Z' }).promise();
      } else {
        const proxy = await ensureSqlProxy();
        if (proxy.status === 'failed') throw new Error(`the Cloud SQL proxy is not working: ${proxy.reason}`);
        for (const k of ['host', 'user', 'password', 'database']) {
          if (!process.env[k]) throw new Error(`missing env var "${k}" (is .env present?)`);
        }
        conn = mysql.createConnection({
          host: process.env.host, user: process.env.user, password: process.env.password,
          database: process.env.database, timezone: 'Z', connectTimeout: 15_000,
        }).promise();
      }
      const r = await run(conn, { apply, backupDir });
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
