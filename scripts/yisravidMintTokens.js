#!/usr/bin/env node
// scripts/yisravidMintTokens.js
//
/**
 * YisraVideo — give the five contacts with no contact_token one.
 *
 * They predate minting at creation. Their sequence video links resolve to an
 * empty ?ct= and open anonymously; a token makes those views attributed. Same
 * guarded UPDATE as POST /api/contacts/:id/booking-link. The list is fixed: a
 * contact outside it is reported, never touched.
 *
 *   node scripts/yisravidMintTokens.js                             # CHECK — read-only
 *   node scripts/yisravidMintTokens.js --apply --backup-dir <dir>  # run it
 *
 * Ends on ONE GO / NO-GO line, resumable. A token is a bearer credential: this
 * prints none, and the backup holds only which contacts had none.
 */
'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const { generateToken, PUBLIC_TOKEN_RE } = require('../lib/token');

const CONTACT_IDS = [1998, 1999, 2005, 2041, 2043];

async function tokenless(conn) {
  const [rows] = await conn.query(
    `SELECT contact_id FROM contacts WHERE contact_token IS NULL OR contact_token = '' ORDER BY contact_id`);
  return rows.map((r) => r.contact_id);
}

async function run(conn, { apply, backupDir, log = console.log }) {
  await conn.query('SET SESSION lock_wait_timeout = 5');

  const now = await tokenless(conn);
  const todo = now.filter((id) => CONTACT_IDS.includes(id));
  const others = now.filter((id) => !CONTACT_IDS.includes(id));
  const [found] = await conn.query('SELECT contact_id FROM contacts WHERE contact_id IN (?)', [CONTACT_IDS]);
  if (found.length !== CONTACT_IDS.length) throw new Error(`only ${found.length} of the ${CONTACT_IDS.length} listed contacts exist`);
  log(`To mint: ${todo.length ? todo.join(', ') : 'none'}`);
  if (others.length) log(`Also tokenless and left alone: ${others.join(', ')}`);

  if (!apply) {
    log(`\nGO — CHECK passed, nothing written. Next: node scripts/yisravidMintTokens.js --apply --backup-dir <abs dir>`);
    return { ok: true };
  }
  if (!todo.length) {
    log('\nGO — nothing left to do.');
    return { ok: true };
  }

  if (!backupDir || !path.isAbsolute(backupDir)) throw new Error('--apply needs --backup-dir <absolute path>');
  fs.mkdirSync(backupDir, { recursive: true });
  const takenAt = new Date().toISOString();
  const body = JSON.stringify({ taken_at: takenAt, had_no_token: todo });
  const file = path.join(backupDir, `yisravid-tokens-${takenAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, body, { mode: 0o600, flag: 'wx' });
  if (fs.readFileSync(file, 'utf8') !== body) throw new Error('the backup did not read back identically');
  log(`  ✓ backup ${file}`);
  log(`    sha256 ${crypto.createHash('sha256').update(body).digest('hex')}`);

  await conn.beginTransaction();
  try {
    for (const id of todo) {
      const [r] = await conn.query(
        'UPDATE contacts SET contact_token = ? WHERE contact_id = ? AND contact_token IS NULL',
        [generateToken(), id]);
      if (r.affectedRows !== 1) throw new Error(`contact ${id} changed under the mint`);
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  }

  const [rows] = await conn.query('SELECT contact_id, contact_token FROM contacts WHERE contact_id IN (?)', [CONTACT_IDS]);
  const bad = rows.filter((r) => !PUBLIC_TOKEN_RE.test(String(r.contact_token || ''))).map((r) => r.contact_id);
  if (bad.length) throw new Error(`no valid token on: ${bad.join(', ')}`);
  log(`\nGO — all ${CONTACT_IDS.length} listed contacts hold a valid token.`);
  return { ok: true };
}

module.exports = { run, CONTACT_IDS };

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
      console.log(`\n${err.message}\n\nNO-GO — stopped. The mint commits whole or not at all; rerun to resume.`);
      process.exitCode = 1;
    } finally {
      if (conn) await conn.end().catch(() => {});
      process.exit();
    }
  })();
}
