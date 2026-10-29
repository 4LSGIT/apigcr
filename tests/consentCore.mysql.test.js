// tests/consentCore.mysql.test.js
//
/**
 * YisraMail P1 — consent core on a REAL engine (ref/YISRAMAIL_DESIGN.md §4.2–§4.4):
 * the migration SQL itself, optoutService's scope predicates (findOptedOut AND
 * the *OptedOutSql twins, held to agreement), the guarded upsert under real
 * row locks (an out-of-order pair, a tie, two racing transactions), ledger
 * idempotency, recordConsent committing or rolling back WITH its caller, every
 * row writer through the real services, and the migration script's run().
 * Nothing is mocked: the services run on a pool against the scratch DB.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3377/yc_consent_test npx jest tests/consentCore.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates the
 * tables below in it — contacts / contact_phones / contact_emails / users /
 * field_defs cloned line-by-line from ref/database.sql, the three comm_* tables
 * from ref/migrations/2026-10-29_yisramail_p1_consent_core.sql (they reach
 * ref/database.sql only once the migration has run live). Run it on a server
 * started with --default-time-zone=+00:00 and the production sql_mode (the
 * pool also sets the session sql_mode). Never point it at port 3306 (the
 * production proxy).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const { withTransaction } = require('../lib/withTransaction');
const optout = require('../services/optoutService');
const phoneSvc = require('../services/contactPhoneService');
const emailSvc = require('../services/contactEmailService');
const contactService = require('../services/contactService');
const migrateScript = require('../scripts/yisramailP1MigrateConsent');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['contacts', 'contact_phones', 'contact_emails', 'users', 'field_defs'];
const { CONSENT_TABLES: COMM, consentStatements: migrationStatements } = require('./helpers/consentSchema');

// Line-based extraction (column COMMENTs may hold ';'); constraint clauses
// naming a table outside the list are dropped — this suite tests predicates.
function schemaFor(tables) {
  const lines = fs.readFileSync(path.join(__dirname, '..', 'ref', 'database.sql'), 'utf8').split('\n');
  const creates = [];
  for (let i = 0; i < lines.length; i++) {
    for (const t of tables) {
      if (lines[i].startsWith(`CREATE TABLE \`${t}\` (`)) {
        const buf = [];
        for (; i < lines.length; i++) { buf.push(lines[i]); if (/^\) ENGINE=.*;$/.test(lines[i])) break; }
        creates.push(buf.join('\n'));
      }
    }
  }
  if (creates.length !== tables.length) throw new Error(`schema extraction found ${creates.length} CREATE blocks of ${tables.length}`);
  return creates;
}

const PAT = '3135550001';
const SAM = '3135550002';
const ANN = '3135550003';
const GHOST = '3135550009';
const T1 = new Date('2026-10-01T10:00:00.000Z');
const T2 = new Date('2026-10-02T10:00:00.000Z');

d('consent core on real MySQL', () => {
  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];

  async function reset() {
    await q('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of [...COMM, ...TABLES]) await q(`DROP TABLE IF EXISTS \`${t}\``);
    await q('SET FOREIGN_KEY_CHECKS = 1');
    for (const sql of schemaFor(TABLES)) await q(sql);
    for (const sql of migrationStatements()) await q(sql);
  }
  async function seedContacts(n = 4) {
    const vals = [];
    for (let i = 1; i <= n; i++) vals.push(`(${i}, 'Person ${i}', 'P${i}', 'L${i}')`);
    await q(`INSERT INTO contacts (contact_id, contact_name, contact_fname, contact_lname) VALUES ${vals.join(', ')}`);
  }
  const events = () => q('SELECT id, channel, destination, scope, action, source, provider_event_id, contact_id, actor_user_id, evidence FROM comm_consent_events ORDER BY id');
  const stateOf = async (channel, destination, scope) => (await q('SELECT state, last_event_id, occurred_at FROM comm_consent_state WHERE channel = ? AND destination = ? AND scope = ?', [channel, destination, scope]))[0] || null;
  const flag = async (table, id) => {
    const col = table === 'contact_phones' ? 'sms_optout' : 'email_optout';
    return Number((await q(`SELECT ${col} AS f FROM ${table} WHERE id = ?`, [id]))[0].f);
  };

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    if (new URL(URL_).port === '3306') throw new Error('refusing to run against the production proxy port');
    pool = mysql.createPool({ uri: URL_, connectionLimit: 6, timezone: 'Z' });
    pool.on('connection', (conn) => conn.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    pool.withTransaction = (fn, opts) => withTransaction(pool, fn, opts);
  });
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { if (pool) await pool.end(); });

  // ───────────────────────────────────────────────────────────────────────
  describe('the migration SQL', () => {
    test('applies, is re-runnable, seeds the newsletter topic once; destination matches the row columns\' collation', async () => {
      await reset();
      for (const sql of migrationStatements()) await q(sql);           // a second run is a no-op
      expect(await q('SELECT topic_key, channel, consent_model, active FROM comm_topics')).toEqual([
        { topic_key: 'newsletter', channel: 'email', consent_model: 'opt_out', active: 1 }]);
      const coll = await q(`SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLLATION_NAME AS k FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND ((TABLE_NAME IN ('comm_consent_events','comm_consent_state') AND COLUMN_NAME = 'destination')
          OR (TABLE_NAME = 'contact_phones' AND COLUMN_NAME = 'phone') OR (TABLE_NAME = 'contact_emails' AND COLUMN_NAME = 'email'))
        ORDER BY TABLE_NAME`);
      expect(new Set(coll.map((r) => r.k))).toEqual(new Set(['utf8mb4_general_ci']));
      expect(coll).toHaveLength(4);
      const keys = await q(`SELECT INDEX_NAME AS i, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS c, MIN(NON_UNIQUE) AS nu
        FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('comm_consent_events','comm_consent_state')
        GROUP BY TABLE_NAME, INDEX_NAME ORDER BY TABLE_NAME, INDEX_NAME`);
      expect(keys.map((k) => [k.i, k.c, Number(k.nu)])).toEqual([
        ['ix_dest', 'channel,destination,occurred_at', 1], ['PRIMARY', 'id', 0], ['uk_source_event', 'source,provider_event_id', 0],
        ['PRIMARY', 'channel,destination,scope', 0]]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  describe('the reader: scopes, dual-read, hit shape — and the SQL twins agree', () => {
    beforeAll(async () => {
      await reset();
      await seedContacts(6);
      await q(`INSERT INTO contact_phones (id, contact_id, phone, sms_optout, end_date) VALUES
        (11, 1, '${PAT}', 1, NULL), (12, 2, '${SAM}', 0, NULL), (13, 3, '${ANN}', 0, NULL), (14, 3, '${GHOST}', 1, '2026-01-01')`);
      await q(`INSERT INTO contact_emails (id, contact_id, email, email_optout, end_date) VALUES
        (21, 1, 'Pat@Example.com', 1, NULL), (22, 2, 'sam@example.com', 0, NULL), (23, 3, 'ann@example.com', 0, NULL), (24, 4, 'zed@example.com', 0, NULL)`);
      await q("INSERT INTO comm_topics (topic_key, channel, label, consent_model) VALUES ('vip', 'email', 'VIP', 'opt_in'), ('sms_marketing', 'sms', 'Texts', 'opt_in'), ('old', 'email', 'Old', 'opt_out')");
      await q("UPDATE comm_topics SET active = 0 WHERE topic_key = 'old'");
      for (const [channel, destination, scope, state, id] of [
        ['sms', SAM, 'all', 'opted_out', 5], ['sms', ANN, 'all', 'opted_in', 6], ['sms', GHOST, 'all', 'opted_out', 7],
        ['email', 'sam@example.com', 'marketing', 'opted_out', 8], ['email', 'ann@example.com', 'newsletter', 'opted_out', 9],
        ['email', 'ghost@example.com', 'marketing', 'opted_out', 10], ['email', 'zed@example.com', 'vip', 'opted_in', 11],
      ]) {
        await q('INSERT INTO comm_consent_state (channel, destination, scope, state, occurred_at, last_event_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, NOW(3))',
          [channel, destination, scope, state, T1, id]);
      }
      // The preview filter reads contacts.contact_phone / contact_email: one contact per destination.
      await q(`UPDATE contacts SET contact_phone = CASE contact_id WHEN 1 THEN '${PAT}' WHEN 2 THEN '${SAM}' WHEN 3 THEN '${ANN}' WHEN 4 THEN '${GHOST}' WHEN 5 THEN '3135550005' ELSE '' END,
        contact_email = CASE contact_id WHEN 1 THEN 'pat@example.com' WHEN 2 THEN 'sam@example.com' WHEN 3 THEN 'ann@example.com' WHEN 4 THEN 'zed@example.com'
          WHEN 5 THEN 'ghost@example.com' ELSE 'new@example.com' END`);
    });

    test('operational SMS: the cache flag OR the state; the hit shape is typed; a row-less destination has null ids', async () => {
      expect(await optout.findOptedOut(pool, 'sms', [PAT, '+1 (313) 555-0002', ANN, GHOST])).toEqual([
        { channel: 'sms', destination: PAT, contact_id: 1, contact_name: 'Person 1', row_id: 11 },
        { channel: 'sms', destination: SAM, contact_id: 2, contact_name: 'Person 2', row_id: 12 },
        { channel: 'sms', destination: GHOST, contact_id: null, contact_name: null, row_id: null },
      ]);
    });

    test('operational email reads nothing and blocks nothing (D18)', async () => {
      const spy = jest.spyOn(pool, 'query');
      expect(await optout.findOptedOut(pool, 'email', ['pat@example.com', 'sam@example.com', 'ghost@example.com'])).toEqual([]);
      expect(spy).not.toHaveBeenCalled();
    });

    const CASES = [
      ['sms', {}, ['1', '2', '4']],
      ['sms', { klass: 'marketing', topic: 'sms_marketing' }, ['1', '2', '3', '4', '5']],   // opt_in topic: nobody has opted in
      ['email', {}, []],
      ['email', { klass: 'marketing' }, ['1', '2', '5']],
      ['email', { klass: 'marketing', topic: 'newsletter' }, ['1', '2', '3', '5']],
      ['email', { klass: 'marketing', topic: 'vip' }, ['1', '2', '3', '5', '6']],             // only zed opted in
      ['email', { klass: 'marketing', topic: 'old' }, ['1', '2', '3', '4', '5', '6']],          // inactive → all
      ['email', { klass: 'marketing', topic: 'nope' }, ['1', '2', '3', '4', '5', '6']],         // unknown → all
      ['sms', { klass: 'marketing', topic: 'newsletter' }, ['1', '2', '3', '4', '5']],          // other channel's topic → all
    ];
    test.each(CASES)('%s %j: findOptedOut and the SQL predicate pick the same contacts', async (channel, opts, expected) => {
      const col = channel === 'sms' ? 'c.contact_phone' : 'c.contact_email';
      const pred = channel === 'sms' ? optout.smsOptedOutSql(col, opts) : optout.emailOptedOutSql(col, opts);
      const rows = await q(`SELECT c.contact_id, ${col} AS dest, ${pred} AS o FROM contacts c WHERE ${col} <> '' ORDER BY c.contact_id`);
      const bySql = rows.filter((r) => Number(r.o) === 1).map((r) => String(r.contact_id));
      const hits = await optout.findOptedOut(pool, channel, rows.map((r) => r.dest), opts);
      const hitDests = new Set(hits.map((h) => h.destination));
      const byService = rows.filter((r) => hitDests.has(channel === 'sms' ? r.dest : String(r.dest).toLowerCase())).map((r) => String(r.contact_id));
      expect([bySql, byService]).toEqual([expected, expected]);
    });

    test('consentVersions reads the newest event id per destination across scopes', async () => {
      const v = await optout.consentVersions(pool, 'email', ['zed@example.com', 'ann@example.com', 'none@example.com']);
      expect([...v]).toEqual([['zed@example.com', { opted_out: false, version: '11' }], ['ann@example.com', { opted_out: false, version: '9' }],
        ['none@example.com', { opted_out: false, version: '0' }]]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  describe('recordConsent: guarded upsert, idempotency, the caller\'s transaction', () => {
    beforeEach(async () => {
      await reset();
      await seedContacts(2);
      await q(`INSERT INTO contact_phones (id, contact_id, phone, sms_optout) VALUES (11, 1, '${PAT}', 0)`);
    });
    const rec = (conn, over) => optout.recordConsent(conn, { channel: 'sms', destination: PAT, scope: 'all', action: 'opt_out', source: 'staff', ...over });

    test('an out-of-order pair: the OLDER event recorded second loses; the cache follows the state', async () => {
      await pool.withTransaction((c) => rec(c, { action: 'opt_out', occurredAt: T2 }), { retries: 1 });
      const late = await pool.withTransaction((c) => rec(c, { action: 'opt_in', occurredAt: T1 }), { retries: 1 });
      expect(late).toEqual({ event_id: 2, duplicate: false, applied: false, state: 'opted_out' });
      expect(await stateOf('sms', PAT, 'all')).toEqual({ state: 'opted_out', last_event_id: 1, occurred_at: T2 });
      expect(await flag('contact_phones', 11)).toBe(1);
      expect((await events()).map((e) => e.action)).toEqual(['opt_out', 'opt_in']);
    });

    test('a tie on occurred_at (millisecond precision) goes to the later id', async () => {
      await pool.withTransaction((c) => rec(c, { occurredAt: T1 }));
      const r = await pool.withTransaction((c) => rec(c, { action: 'opt_in', occurredAt: T1 }));
      expect(r).toMatchObject({ applied: true, state: 'opted_in' });
      const later = new Date(T1.getTime() + 1);
      await pool.withTransaction((c) => rec(c, { occurredAt: T1 }));          // same instant, later id → wins again
      await pool.withTransaction((c) => rec(c, { action: 'opt_in', occurredAt: later }));
      expect(await stateOf('sms', PAT, 'all')).toMatchObject({ state: 'opted_in', last_event_id: 4 });
    });

    test('two racing transactions commit in either order and the state lands on the NEWER event', async () => {
      for (const newerFirst of [true, false]) {
        await q('DELETE FROM comm_consent_state'); await q('DELETE FROM comm_consent_events');
        const a = await pool.getConnection(); const b = await pool.getConnection();
        try {
          await a.beginTransaction(); await b.beginTransaction();
          // A takes the state row first; B's upsert waits on A's row lock.
          await rec(a, newerFirst ? { action: 'opt_in', occurredAt: T2 } : { action: 'opt_in', occurredAt: T1 });
          const bDone = rec(b, newerFirst ? { action: 'opt_out', occurredAt: T1 } : { action: 'opt_out', occurredAt: T2 });
          await new Promise((r) => setTimeout(r, 150));
          await a.commit();
          await bDone; await b.commit();
        } finally { a.release(); b.release(); }
        expect([newerFirst, (await stateOf('sms', PAT, 'all')).state, await flag('contact_phones', 11)])
          .toEqual([newerFirst, newerFirst ? 'opted_in' : 'opted_out', newerFirst ? 0 : 1]);
      }
    });

    test('(source, provider_event_id) twice is a no-op — and the CALLER\'s transaction lives on to commit', async () => {
      const args = { source: 'migration', providerEventId: 'migration:phone:11', occurredAt: T1 };
      await pool.withTransaction((c) => rec(c, args));
      const out = await pool.withTransaction(async (c) => {
        const r = await rec(c, args);
        await c.query("UPDATE contacts SET contact_notes = 'after the dup' WHERE contact_id = 1");
        return r;
      });
      expect(out).toEqual({ event_id: null, duplicate: true, applied: false, state: null });
      expect(await events()).toHaveLength(1);
      expect((await q('SELECT contact_notes FROM contacts WHERE contact_id = 1'))[0].contact_notes).toBe('after the dup');
    });

    test('it rolls back WITH its caller: a failure later in the span leaves no event, no state, no cache change', async () => {
      await expect(pool.withTransaction(async (c) => {
        await rec(c, { occurredAt: T1 });
        expect(await flag('contact_phones', 11)).toBe(0);          // not visible outside the span yet
        throw new Error('the contact save failed');
      }, { retries: 1 })).rejects.toThrow('the contact save failed');
      expect([await events(), await stateOf('sms', PAT, 'all'), await flag('contact_phones', 11)]).toEqual([[], null, 0]);
    });

    test('validation writes nothing; the dup catch never swallows another error', async () => {
      await expect(pool.withTransaction((c) => rec(c, { scope: 'marketing' }))).rejects.toThrow(/email scope/);
      await expect(pool.withTransaction((c) => rec(c, { channel: 'email', destination: 'a@b.co', scope: 'vip' }))).rejects.toThrow(/not a email topic/);
      // a real engine error (the table gone) surfaces, it is not read as a duplicate
      await q('RENAME TABLE comm_consent_state TO comm_consent_state_x');
      try {
        await expect(pool.withTransaction((c) => rec(c, { occurredAt: T1 }))).rejects.toThrow(/comm_consent_state/);
      } finally { await q('RENAME TABLE comm_consent_state_x TO comm_consent_state'); }
      expect(await events()).toEqual([]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  describe('every row writer, through the real services', () => {
    beforeEach(async () => { await reset(); await seedContacts(3); await q("INSERT INTO users (user, user_name) VALUES (6, 'fred')").catch(() => {}); });
    const optedState = async (channel, destination, scope) => pool.withTransaction((c) => optout.recordConsent(c,
      { channel, destination, scope, action: 'opt_out', source: 'sms_keyword', occurredAt: T1 }));

    test('create ticked → ONE event; re-creating for an opted-out number with the flag omitted / 0 → none, still opted out', async () => {
      const { phone } = await phoneSvc.createContactPhone(pool, 1, { phone: PAT, sms_optout: true }, { createdBy: 6 });
      expect(phone.sms_optout).toBe(1);
      const ev = await events();
      expect(ev).toEqual([expect.objectContaining({ channel: 'sms', destination: PAT, scope: 'all', action: 'opt_out', source: 'staff',
        contact_id: 1, actor_user_id: 6, evidence: { row_id: phone.id, via: 'row_create' } })]);
      await phoneSvc.updateContactPhone(pool, phone.id, { end_date: '2026-10-01', end_reason: 'gone' });
      for (const fields of [{ phone: PAT }, { phone: PAT, sms_optout: 0 }]) {
        const r = await phoneSvc.createContactPhone(pool, 2, fields, { createdBy: 6, force: true });
        expect(r.phone.sms_optout).toBe(1);
        await phoneSvc.updateContactPhone(pool, r.phone.id, { end_date: '2026-10-02', end_reason: 'gone' });
      }
      expect(await events()).toHaveLength(1);
      expect((await stateOf('sms', PAT, 'all')).state).toBe('opted_out');
    });

    test('update: a change is one event each way; an echo or an unrelated edit records nothing', async () => {
      const { phone } = await phoneSvc.createContactPhone(pool, 1, { phone: PAT }, { createdBy: 6 });
      await phoneSvc.updateContactPhone(pool, phone.id, { sms_optout: 0, label: 'Work' }, { updatedBy: 6 });
      await phoneSvc.updateContactPhone(pool, phone.id, { notes: 'evenings' }, { updatedBy: 6 });
      expect(await events()).toEqual([]);
      await phoneSvc.updateContactPhone(pool, phone.id, { sms_optout: 1 }, { updatedBy: 6 });
      await phoneSvc.updateContactPhone(pool, phone.id, { sms_optout: 0 }, { updatedBy: 6 });
      expect((await events()).map((e) => e.action)).toEqual(['opt_out', 'opt_in']);
      expect([(await stateOf('sms', PAT, 'all')).state, await flag('contact_phones', phone.id)]).toEqual(['opted_in', 0]);
    });

    test('a transfer keeps the opt-out (the row the number lands on is born opted out)', async () => {
      await optedState('sms', PAT, 'all');
      await q(`INSERT INTO contact_phones (id, contact_id, phone, is_primary, sms_optout) VALUES (40, 2, '${PAT}', 1, 1)`);
      const { phone } = await phoneSvc.createContactPhone(pool, 1, { phone: PAT }, { force: true, createdBy: 6 });
      expect([phone.contact_id, phone.sms_optout]).toEqual([1, 1]);
      expect((await q('SELECT end_reason FROM contact_phones WHERE id = 40'))[0].end_reason).toBe('transferred');
      expect(await events()).toHaveLength(1);   // only the seeded keyword event
    });

    test('aggregate end-and-replace records row_replace for the NEW number; the old number keeps its own state', async () => {
      await optedState('sms', PAT, 'all');
      await q(`INSERT INTO contact_phones (id, contact_id, phone, is_primary, sms_optout) VALUES (40, 1, '${PAT}', 1, 1)`);
      await contactService.updateContact(pool, 1, { phones: [{ id: 40, phone: SAM }] }, { userId: 6 });
      const [fresh] = await q(`SELECT id, sms_optout FROM contact_phones WHERE phone = '${SAM}' AND end_date IS NULL`);
      expect(fresh.sms_optout).toBe(1);
      const ev = await events();
      expect(ev[1]).toMatchObject({ destination: SAM, action: 'opt_out', source: 'row_replace', actor_user_id: 6,
        evidence: { from_destination: PAT, from_row_id: 40, row_id: fresh.id, via: 'aggregate' } });
      expect((await stateOf('sms', PAT, 'all')).state).toBe('opted_out');
    });

    test('email: create ticked, replace, and createContact born from the marketing state', async () => {
      const { email } = await emailSvc.createContactEmail(pool, 1, { email: 'Pat@Example.com', email_optout: 1 }, { createdBy: 6 });
      await contactService.updateContact(pool, 1, { emails: [{ id: email.id, email: 'pat.new@example.com' }] }, { userId: 6 });
      expect((await events()).map((e) => [e.channel, e.scope, e.destination, e.source])).toEqual([
        ['email', 'marketing', 'pat@example.com', 'staff'], ['email', 'marketing', 'pat.new@example.com', 'row_replace']]);
      await optedState('sms', '3135550077', 'all');
      const { contact_id } = await contactService.createContact(pool, { fname: 'Old', lname: 'Address', phone: '313-555-0077', email: 'PAT@example.com' }, { userId: 6 });
      const [p] = await q('SELECT sms_optout FROM contact_phones WHERE contact_id = ?', [contact_id]);
      const [e] = await q('SELECT email_optout FROM contact_emails WHERE contact_id = ?', [contact_id]);
      expect([p.sms_optout, e.email_optout]).toEqual([1, 1]);   // both destinations' states stand
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  describe('scripts/yisramailP1MigrateConsent.js run()', () => {
    test('CHECK lists, --apply migrates (occurred_at = updated_at), a re-run is a no-op, a bypassed flag is NO-GO', async () => {
      await reset(); await seedContacts(3);
      const conn = await pool.getConnection();
      try {
        await q(`INSERT INTO contact_phones (id, contact_id, phone, sms_optout, end_date, updated_at) VALUES
          (11, 1, '${PAT}', 1, NULL, '2026-06-20 19:46:28'), (12, 2, '${SAM}', 0, NULL, NOW()), (13, 3, '${ANN}', 1, '2026-01-01', NOW())`);
        await q("INSERT INTO contact_emails (id, contact_id, email, email_optout, updated_at) VALUES (21, 1, 'Pat@Example.com', 1, '2026-07-01 08:00:00')");
        const said = [];
        const say = (l) => said.push(l);
        const check = await migrateScript.run(conn, { say });
        expect(check).toMatchObject({ ok: true, migrated: 0 });
        expect(check.line).toMatch(/^CHECK OK — GO\. Next: node scripts\/yisramailP1MigrateConsent\.js --apply \(2 row\(s\) to migrate\)/);
        expect(await events()).toEqual([]);
        const run1 = await migrateScript.run(conn, { apply: true, say });
        expect(run1).toMatchObject({ ok: true, migrated: 2 });
        expect(run1.line).toMatch(/^MIGRATED 2 row\(s\); every active flag agrees with the consent state — GO\./);
        expect((await events()).map((e) => [e.channel, e.destination, e.scope, e.source, e.provider_event_id, e.contact_id, e.evidence])).toEqual([
          ['sms', PAT, 'all', 'migration', 'migration:phone:11', 1, { row_id: 11, column: 'contact_phones.sms_optout' }],
          ['email', 'pat@example.com', 'marketing', 'migration', 'migration:email:21', 1, { row_id: 21, column: 'contact_emails.email_optout' }]]);
        expect((await stateOf('sms', PAT, 'all')).occurred_at).toEqual(new Date('2026-06-20T19:46:28.000Z'));
        expect(await migrateScript.run(conn, { apply: true, say })).toMatchObject({ ok: true, migrated: 0 });
        expect(await events()).toHaveLength(2);
        // a flag cleared OUTSIDE the ledger (the old code, in the deploy gap) is a decision, not a migration
        await q('UPDATE contact_phones SET sms_optout = 0 WHERE id = 11');
        const bad = await migrateScript.run(conn, { apply: true, say });
        expect(bad.ok).toBe(false);
        expect(bad.line).toMatch(/^NO-GO — the end state does not verify \(0 unmigrated, 1 disagreeing row\(s\) above\)/);
        expect(said.join('\n')).toContain(`contact_phones #11 (contact 1) ${PAT}: flag 0 but the state says opted_out`);
        // and before the tables exist the script says so and writes nothing
        await q('DROP TABLE comm_consent_state');
        const none = await migrateScript.run(conn, { apply: true, say });
        expect(none.line).toMatch(/^NO-GO — missing table\(s\) comm_consent_state/);
      } finally { conn.release(); }
    });
  });
});
