#!/usr/bin/env node
// scripts/yisravidS2Columns.js
//
/**
 * YisraVideo S2 — four new video_views columns, and completed_at backfilled.
 * The applied SQL is recorded in
 * ref/migrations/2026-11-01_yisravid_s2_video_views_columns.sql.
 *
 * MUST RUN BEFORE the S2 code lands: recordView inserts track_token, so the
 * new code on the old table records no view at all. RERUN --apply ONCE AFTER
 * THE DEPLOY: until then the old code still writes completion_pct = 100 with
 * no completed_at, and a rerun picks those views up.
 *
 * USAGE (from a checkout of the COMMITTED sha, whose .env reaches production):
 *
 *   node scripts/yisravidS2Columns.js                             # CHECK — read-only
 *   node scripts/yisravidS2Columns.js --apply --backup-dir <dir>  # run it
 *
 * Both end on ONE GO / NO-GO line. --apply is resumable: it reads the live
 * state every time and does only what is left.
 *
 * WHY A NODE SCRIPT ON ONE CONNECTION: lock_wait_timeout must reach the ALTER.
 * Every ALTER takes an exclusive metadata lock; one queued behind a long
 * transaction stalls every query on the table, and the global default is a
 * year. video_views takes a write on every public page open.
 *
 * ALGORITHM=INSTANT makes a refused plan fail instead of rebuilding the table.
 *
 * BACKUP: --apply writes every video_views row to <dir> first (JSON, mode 0600)
 * and re-reads it to prove the file before the first write. Pass an absolute
 * path outside the worktree.
 */
'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const COLUMNS = {
  track_token: {
    type: 'char(22)', collation: 'utf8mb4_bin',
    ddl: `ADD COLUMN track_token char(22) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL
      COMMENT 'bearer for the public track + cta-click POSTs, rendered into the page that opened the view; ids are sequential; NULL on views before 2026-11-01; _bin: case-sensitive'`,
  },
  completed_at: {
    type: 'timestamp', collation: null,
    ddl: `ADD COLUMN completed_at timestamp NULL DEFAULT NULL
      COMMENT 'first time at least 90% really played (videoService.COMPLETE_PCT), claimed once by conditional UPDATE; before 2026-11-01 backfilled from completion_pct=100, which only meant the player reached the end'`,
  },
  excluded_at: {
    type: 'timestamp', collation: null,
    ddl: `ADD COLUMN excluded_at timestamp NULL DEFAULT NULL
      COMMENT 'staff excluded this view from stats (test view, scanner); NULL = counted; reversible, never a delete'`,
  },
  excluded_by: {
    type: 'int', collation: null,
    ddl: `ADD COLUMN excluded_by int DEFAULT NULL
      COMMENT 'users.user who excluded it'`,
  },
};
const WATCH_COMMENT = 'seconds really played since 2026-11-01; before that the furthest position reached, so dragging the bar counted';

async function columnsNow(conn) {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, COLLATION_NAME AS collation, IS_NULLABLE AS nullable,
            COLUMN_DEFAULT AS dflt, EXTRA AS extra, COLUMN_COMMENT AS comment
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'video_views'`);
  return new Map(rows.map((r) => [r.name, r]));
}

function missingColumns(live) {
  const missing = [];
  for (const [name, want] of Object.entries(COLUMNS)) {
    const got = live.get(name);
    if (!got) { missing.push(name); continue; }
    const bad = got.type !== want.type || got.collation !== want.collation
      || got.nullable !== 'YES' || got.dflt != null || /on update/i.test(got.extra);
    if (bad) throw new Error(`video_views.${name} exists with the wrong shape (${got.type}, ${got.extra || 'no extra'})`);
  }
  return missing;
}

async function writeBackup(conn, dir, log) {
  if (!dir || !path.isAbsolute(dir)) throw new Error('--apply needs --backup-dir <absolute path>');
  fs.mkdirSync(dir, { recursive: true });
  const [rows] = await conn.query('SELECT * FROM video_views');
  const takenAt = new Date().toISOString();
  const body = JSON.stringify({ taken_at: takenAt, video_views: rows }, null, 1);
  const file = path.join(dir, `yisravid-s2-${takenAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, body, { mode: 0o600, flag: 'wx' });
  const back = fs.readFileSync(file, 'utf8');
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  if (crypto.createHash('sha256').update(back).digest('hex') !== sha) throw new Error('the backup did not read back identically');
  if (JSON.parse(back).video_views.length !== rows.length) throw new Error('the backup row count does not match');
  log(`  ✓ backup ${file}`);
  log(`    sha256 ${sha} — ${rows.length} views`);
  return rows.length;
}

async function run(conn, { apply, backupDir, log = console.log }) {
  await conn.query('SET SESSION lock_wait_timeout = 5');

  const live = await columnsNow(conn);
  for (const need of ['completion_pct', 'played_at', 'opened_at', 'watch_seconds']) {
    if (!live.has(need)) throw new Error(`video_views.${need} is missing — this is not the expected table`);
  }
  const missing = missingColumns(live);
  const watchDone = live.get('watch_seconds').comment === WATCH_COMMENT;
  const [[{ total }]] = await conn.query('SELECT COUNT(*) AS total FROM video_views');
  const [[{ hundred }]] = await conn.query('SELECT COUNT(*) AS hundred FROM video_views WHERE completion_pct = 100');
  const toFill = missing.includes('completed_at')
    ? hundred
    : (await conn.query('SELECT COUNT(*) AS n FROM video_views WHERE completion_pct = 100 AND completed_at IS NULL'))[0][0].n;

  log(`video_views: ${total} rows, ${hundred} at completion_pct = 100`);
  log(`Columns to add: ${missing.length ? missing.join(', ') : 'none'}`);
  log(`watch_seconds comment: ${watchDone ? 'done' : 'to set'}`);
  log(`completed_at to backfill: ${toFill}`);

  const nothingLeft = !missing.length && watchDone && !toFill;
  if (!apply) {
    log(nothingLeft
      ? '\nGO — CHECK passed, nothing left to do.'
      : '\nGO — CHECK passed, nothing written. Next: node scripts/yisravidS2Columns.js --apply --backup-dir <abs dir>');
    return { ok: true };
  }
  if (nothingLeft) {
    log('\nGO — nothing left to do.');
    return { ok: true };
  }

  await writeBackup(conn, backupDir, log);

  if (missing.length) {
    await conn.query(`ALTER TABLE video_views ${missing.map((m) => COLUMNS[m].ddl).join(', ')}, ALGORITHM=INSTANT`);
    log(`  ✓ added ${missing.join(', ')}`);
  }
  if (!watchDone) {
    await conn.query(
      `ALTER TABLE video_views MODIFY COLUMN watch_seconds int NOT NULL DEFAULT '0' COMMENT ?, ALGORITHM=INSTANT`,
      [WATCH_COMMENT]);
    log('  ✓ watch_seconds comment set');
  }
  const [fill] = await conn.query(
    `UPDATE video_views SET completed_at = COALESCE(played_at, opened_at)
      WHERE completion_pct = 100 AND completed_at IS NULL`);
  log(`  ✓ backfilled completed_at on ${fill.affectedRows} view(s)`);

  // End state, read fresh.
  const after = await columnsNow(conn);
  if (missingColumns(after).length) throw new Error('a column is still missing');
  if (after.get('watch_seconds').comment !== WATCH_COMMENT) throw new Error('the watch_seconds comment did not land');
  const [[end]] = await conn.query(
    `SELECT COUNT(*) AS total, SUM(completed_at IS NOT NULL) AS completed,
            SUM(completion_pct = 100 AND completed_at IS NULL) AS unfilled
       FROM video_views`);
  if (Number(end.total) < total) throw new Error(`row count fell from ${total} to ${end.total}`);
  if (Number(end.unfilled) !== 0) throw new Error(`${end.unfilled} view(s) at 100% have no completed_at`);
  log(`\nGO — columns live, ${end.completed} view(s) carry completed_at. If the S2 code is not deployed yet: land it, then rerun this --apply once.`);
  return { ok: true };
}

module.exports = { run, COLUMNS, WATCH_COMMENT };

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
