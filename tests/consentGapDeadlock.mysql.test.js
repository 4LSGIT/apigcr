// tests/consentGapDeadlock.mysql.test.js
//
/**
 * YisraMail P1-fix — the comm_consent_state GAP deadlock (found by P4 r2,
 * ref/YISRAMAIL_DESIGN.md §4.4 "As built") on a REAL engine.
 *
 * The cycle: a row writer reads its destination's state with a locking read
 * (`optoutService.stateFlag`, FOR SHARE — from decideRowFlag and bornRow). For
 * a destination with NO state row yet that is a GAP lock on
 * comm_consent_state's primary key. Two transactions holding the same gap that
 * both go on to insert their seed row (recordConsent) wait on each other;
 * InnoDB rolls one back. The same gap closes a second cycle with any direct
 * writer (the P4 import): a form save of two rows holds row A, then the gap,
 * then asks for row B, while the import holds row B and inserts its seed.
 *
 * The fix (§4.4): the consent-bearing save spans — contactService.createContact
 * / updateContact and the per-row phone / email create / update — re-run their
 * PURE-DB transaction once on ER_LOCK_DEADLOCK (lib/withTransaction
 * retryOnDeadlock). What it guarantees, and what these tests assert: no save
 * SURFACES a deadlock — each one lands, or answers a clean 409
 * consent_changed when the other side's decision moved its base. InnoDB's own
 * deadlock counter still moves (a deadlock happens and is retried); the tests
 * assert it DID move, which proves each race really exercises the cycle.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3322/yc_gap_test npx jest tests/consentGapDeadlock.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates its
 * tables — contacts / contact_phones / contact_emails / users / field_defs
 * cloned line-by-line from ref/database.sql, the comm_* tables from the P1
 * migration (tests/helpers/consentSchema) — and drops, first, any table a
 * sibling twin left holding an FK into them, and its own tables again in
 * afterAll. Run it on a server started with --default-time-zone=+00:00 and the
 * production sql_mode, with the server to itself (the deadlock counter is
 * server-global). Never point it at port 3306 (the production proxy).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const { withTransaction } = require('../lib/withTransaction');
const phoneSvc = require('../services/contactPhoneService');
const emailSvc = require('../services/contactEmailService');
const contactService = require('../services/contactService');
const { importConsent } = require('../routes/api.consent');
const { CONSENT_TABLES: COMM, consentStatements } = require('./helpers/consentSchema');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['contacts', 'contact_phones', 'contact_emails', 'users', 'field_defs'];
const ROUNDS = 30;
const STAFF6 = { kind: 'user', userId: 6 };

// Line-based extraction of each table's CREATE block AND its ALTER blocks (the
// keys live there) — consentCore.mysql's extractor. FK clauses naming a table
// outside the list are dropped.
function schemaFor(tables) {
  const lines = fs.readFileSync(path.join(__dirname, '..', 'ref', 'database.sql'), 'utf8').split('\n');
  const creates = [];
  const alters = [];
  for (let i = 0; i < lines.length; i++) {
    for (const t of tables) {
      if (lines[i].startsWith(`CREATE TABLE \`${t}\` (`)) {
        const buf = [];
        for (; i < lines.length; i++) { buf.push(lines[i]); if (/^\) ENGINE=.*;$/.test(lines[i])) break; }
        creates.push(buf.join('\n'));
      } else if (lines[i] === `ALTER TABLE \`${t}\``) {
        const buf = [];
        for (; i < lines.length; i++) { buf.push(lines[i]); if (/;\s*$/.test(lines[i])) break; }
        const clauses = buf.slice(1).map((l) => l.replace(/[,;]\s*$/, ''))
          .filter((l) => { const m = /REFERENCES `([a-z_]+)`/.exec(l); return !m || tables.includes(m[1]); });
        if (clauses.length) alters.push(`${buf[0]}\n${clauses.join(',\n')};`);
      }
    }
  }
  if (creates.length !== tables.length) throw new Error(`schema extraction found ${creates.length} CREATE blocks of ${tables.length}`);
  alters.sort((a, b) => /FOREIGN KEY/.test(a) - /FOREIGN KEY/.test(b));
  return [...creates, ...alters];
}

const PAT = '3135550001';   // contact 1, row 11
const SAM = '3135550002';   // contact 2, row 12
const P2 = '3135550004';    // contact 1, row 14 (its second number)

d('comm_consent_state gap deadlock on real MySQL', () => {
  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];

  async function reset() {
    await q('SET FOREIGN_KEY_CHECKS = 0');
    const holders = await q(`SELECT DISTINCT TABLE_NAME AS t FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IN (?)`, [TABLES]);
    for (const t of [...COMM, ...holders.map((h) => h.t), ...TABLES]) await q(`DROP TABLE IF EXISTS \`${t}\``);
    await q('SET FOREIGN_KEY_CHECKS = 1');
    for (const sql of schemaFor(TABLES)) await q(sql);
    for (const sql of consentStatements()) await q(sql);
    await q(`INSERT INTO contacts (contact_id, contact_name, contact_fname, contact_lname, contact_phone, contact_email) VALUES
      (1, 'Pat One', 'Pat', 'One', '${PAT}', 'pat@example.com'), (2, 'Sam Two', 'Sam', 'Two', '${SAM}', 'sam@example.com')`);
    await q(`INSERT INTO contact_phones (id, contact_id, phone, is_primary) VALUES (11, 1, '${PAT}', 1), (12, 2, '${SAM}', 1), (14, 1, '${P2}', 0)`);
    await q(`INSERT INTO contact_emails (id, contact_id, email, is_primary) VALUES (21, 1, 'pat@example.com', 1), (22, 2, 'sam@example.com', 1)`);
    await q("INSERT INTO users (user, username, user_name, user_fname, user_lname, user_initials, user_auth, ringcentral) VALUES (6, 'fred', 'Fred', 'Fred', 'F', 'FF', 'authorized', 0)");
  }
  // InnoDB's own deadlock counter (server-global, enabled by default).
  const deadlocks = async () => Number((await q("SELECT COUNT FROM information_schema.INNODB_METRICS WHERE NAME = 'lock_deadlocks'"))[0].COUNT);
  const stateOf = async (channel, dest, scope) => ((await q('SELECT state FROM comm_consent_state WHERE channel = ? AND destination = ? AND scope = ?', [channel, dest, scope]))[0] || {}).state || null;
  const settle = (p) => p.then((v) => ({ ok: v }), (e) => ({ err: e }));
  const code = (r) => (r.err ? (r.err.code || r.err.message) : 'ok');

  // Run `make(round)` → [promiseA, promiseB] for ROUNDS rounds on a fresh
  // schema each; every outcome must be ok or a clean 409 consent_changed.
  async function race(make, check) {
    const dl0 = await deadlocks();
    const outcomes = [];
    for (let round = 0; round < ROUNDS; round++) {
      await reset();
      const rs = await Promise.all(make(round).map(settle));
      for (const r of rs) {
        outcomes.push(code(r));
        if (r.err) expect([round, r.err.code, r.err.status]).toEqual([round, 'consent_changed', 409]);
      }
      await check(round, rs);
    }
    return { outcomes, deadlocks: (await deadlocks()) - dl0 };
  }

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    if (new URL(URL_).port === '3306') throw new Error('refusing to run against the production proxy port');
    pool = mysql.createPool({ uri: URL_, connectionLimit: 8, timezone: 'Z' });
    pool.on('connection', (conn) => conn.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    pool.withTransaction = (fn, opts) => withTransaction(pool, fn, opts);
  });
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    if (!pool) return;
    try {
      await q('SET FOREIGN_KEY_CHECKS = 0');
      for (const t of [...COMM, ...TABLES]) await q(`DROP TABLE IF EXISTS \`${t}\``);
      await q('SET FOREIGN_KEY_CHECKS = 1');
    } finally {
      await pool.end();
    }
  });

  test(`contact form vs contact form, two contacts, never-recorded numbers (${ROUNDS} rounds): the cycle happens, every save lands`, async () => {
    const r = await race(() => [
      contactService.updateContact(pool, 1, { phones: [{ id: 11, phone: PAT, sms_optout: 1, sms_optout_base: 0, is_primary: 1 }] }, { userId: 6, consentActor: STAFF6 }),
      contactService.updateContact(pool, 2, { phones: [{ id: 12, phone: SAM, sms_optout: 1, sms_optout_base: 0, is_primary: 1 }] }, { userId: 6, consentActor: STAFF6 }),
    ], async (round) => {
      expect([round, await stateOf('sms', PAT, 'all'), await stateOf('sms', SAM, 'all')]).toEqual([round, 'opted_out', 'opted_out']);
    });
    expect(r.outcomes.filter((o) => o !== 'ok')).toEqual([]);   // different numbers: nothing to 409 on
    expect(r.deadlocks).toBeGreaterThan(0);                       // the race really ran into the gap cycle
  }, 120000);

  test(`email: the per-row PATCH route path on two contacts (${ROUNDS} rounds): every save lands`, async () => {
    const r = await race(() => [
      emailSvc.updateContactEmail(pool, 21, { email_optout: 1, email_optout_base: 0 }, { updatedBy: 6, consentActor: STAFF6 }),
      emailSvc.updateContactEmail(pool, 22, { email_optout: 1, email_optout_base: 0 }, { updatedBy: 6, consentActor: STAFF6 }),
    ], async (round) => {
      expect([round, await stateOf('email', 'pat@example.com', 'marketing'), await stateOf('email', 'sam@example.com', 'marketing')])
        .toEqual([round, 'opted_out', 'opted_out']);
    });
    expect(r.outcomes.filter((o) => o !== 'ok')).toEqual([]);
    expect(r.deadlocks).toBeGreaterThan(0);
  }, 120000);

  test(`create: two new never-recorded numbers born opted out on two contacts (bornRow) (${ROUNDS} rounds): every create lands`, async () => {
    const r = await race(() => [
      phoneSvc.createContactPhone(pool, 1, { phone: '3135550101', label: 'Work', sms_optout: 1 }, { createdBy: 6, consentActor: STAFF6 }),
      phoneSvc.createContactPhone(pool, 2, { phone: '3135550102', label: 'Work', sms_optout: 1 }, { createdBy: 6, consentActor: STAFF6 }),
    ], async (round) => {
      expect([round, await stateOf('sms', '3135550101', 'all'), await stateOf('sms', '3135550102', 'all')]).toEqual([round, 'opted_out', 'opted_out']);
    });
    expect(r.outcomes.filter((o) => o !== 'ok')).toEqual([]);
    expect(r.deadlocks).toBeGreaterThan(0);
  }, 120000);

  test(`form save of two rows vs the P4 import of the same contact's two numbers (${ROUNDS} rounds): no deadlock surfaces on either side`, async () => {
    const r = await race((round) => [
      new Promise((res) => setTimeout(res, round % 3)).then(() => importConsent(pool,
        { channel: 'sms', scope: 'all', rows: [{ destination: P2 }, { destination: PAT }] }, { actorUserId: 6 })),
      new Promise((res) => setTimeout(res, round % 2 ? 2 : 0)).then(() => contactService.updateContact(pool, 1, { phones: [
        { id: 11, phone: PAT, sms_optout: 1, sms_optout_base: 0, is_primary: 1 },
        { id: 14, phone: P2, sms_optout: 1, sms_optout_base: 0, is_primary: 0 },
      ] }, { userId: 6, consentActor: STAFF6 })),
    ], async (round, [imp]) => {
      expect([round, code(imp)]).toEqual([round, 'ok']);           // the import never 409s
      expect(imp.ok.recorded + imp.ok.unchanged).toBe(2);
      expect([round, await stateOf('sms', PAT, 'all'), await stateOf('sms', P2, 'all')]).toEqual([round, 'opted_out', 'opted_out']);
    });
    expect(r.outcomes.every((o) => o === 'ok' || o === 'consent_changed')).toBe(true);
  }, 120000);
});
