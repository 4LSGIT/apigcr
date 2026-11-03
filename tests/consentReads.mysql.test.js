// tests/consentReads.mysql.test.js
//
/**
 * YisraMail P4 — the staff consent reads, the SU import and the campaign
 * preview on a REAL engine (ref/YISRAMAIL_DESIGN.md §4.7 "As built"):
 * optoutService.consentSummary across 'all' / 'marketing' / a topic (the
 * event join for `source`, the topic join for the label), consentHistory's
 * order and redaction, routes/api.consent's importConsent (recorded /
 * unchanged / invalid counts, all-or-nothing validation, opt-in refused, a
 * second run records nothing, a batch boundary, the cache sync, and an
 * import racing a contact-form toggle of the same number without a deadlock)
 * and previewConsent against executeSend's own per-contact reader call.
 * Nothing is mocked: the code runs on a pool against the scratch DB.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3322/yc_p4consent_test npx jest tests/consentReads.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates its
 * tables — contacts / contact_phones / contact_emails / users / field_defs
 * cloned line-by-line from ref/database.sql, the comm_* tables from the P1
 * migration (tests/helpers/consentSchema) — and drops, first, any table a
 * sibling twin left holding an FK into them (found in information_schema),
 * and its own tables again in afterAll. Run it on a server started with
 * --default-time-zone=+00:00 and the production sql_mode (the pool also sets
 * the session sql_mode). Never point it at port 3306 (the production proxy).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const { withTransaction } = require('../lib/withTransaction');
const optout = require('../services/optoutService');
const contactService = require('../services/contactService');
const { importConsent, previewConsent, campaignConsent } = require('../routes/api.consent');
const { CONSENT_TABLES: COMM, consentStatements } = require('./helpers/consentSchema');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['contacts', 'contact_phones', 'contact_emails', 'users', 'field_defs'];

// Line-based extraction (column COMMENTs may hold ';') of each table's CREATE
// block AND its ALTER blocks (the keys live there) — consentCore.mysql's
// extractor. FK clauses naming a table outside the list are dropped.
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

const PAT = '3135550001';   // contact 1, opted out (state + flag)
const SAM = '3135550002';   // contact 2, clear
const ANN = '3135550003';   // contact 3, state opted_out with a CLEAR row flag (the state is the truth)
const GHOST = '3135550009'; // no row anywhere
const STAFF6 = { kind: 'user', userId: 6 };

d('staff consent reads, import and preview on real MySQL', () => {
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
      (1, 'Pat One', 'Pat', 'One', '${PAT}', 'pat@example.com'),
      (2, 'Sam Two', 'Sam', 'Two', '${SAM}', 'sam@example.com'),
      (3, 'Ann Three', 'Ann', 'Three', '${ANN}', ''),
      (4, 'No Phone', 'No', 'Phone', '', 'none@example.com')`);
    await q(`INSERT INTO contact_phones (id, contact_id, phone, is_primary) VALUES (11, 1, '${PAT}', 1), (12, 2, '${SAM}', 1), (13, 3, '${ANN}', 1)`);
    await q(`INSERT INTO contact_emails (id, contact_id, email, is_primary) VALUES (21, 1, 'pat@example.com', 1), (22, 2, 'sam@example.com', 1)`);
    await q("INSERT INTO users (user, username, user_name, user_fname, user_lname, user_initials, user_auth, ringcentral) VALUES (6, 'fred', 'Fred', 'Fred', 'F', 'FF', 'authorized', 0)");
    await q("INSERT INTO comm_topics (topic_key, channel, label, consent_model, active) VALUES ('events', 'email', 'Events', 'opt_in', 0)");
  }
  // Seed consent through the ONE writer, as production does.
  const record = (o) => withTransaction(pool, (conn) => optout.recordConsent(conn, o), { retries: 1 });
  const events = () => q('SELECT id, channel, destination, scope, action, source, contact_id, actor_user_id, evidence FROM comm_consent_events ORDER BY id');
  // InnoDB's own deadlock counter (server-global, enabled by default): the race
  // tests assert it does not move, because consentTx RETRIES a deadlocked
  // import — an import chosen as the victim would otherwise pass unseen.
  // Server-global, so this twin needs its server to itself (--runInBand).
  const deadlocks = async () => Number((await q("SELECT COUNT FROM information_schema.INNODB_METRICS WHERE NAME = 'lock_deadlocks'"))[0].COUNT);
  const flag = async (table, id) => Number((await q(`SELECT ${table === 'contact_phones' ? 'sms_optout' : 'email_optout'} AS f FROM ${table} WHERE id = ?`, [id]))[0].f);

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    if (new URL(URL_).port === '3306') throw new Error('refusing to run against the production proxy port');
    pool = mysql.createPool({ uri: URL_, connectionLimit: 8, timezone: 'Z' });
    pool.on('connection', (conn) => conn.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    pool.withTransaction = (fn, opts) => withTransaction(pool, fn, opts);
  });
  beforeEach(async () => {
    await reset();
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

  // ───────────────────────────────────────────────────────────────────────
  test('consentSummary: every scope with a state row (all / marketing / topics), its event\'s source, the topic label; {} for none', async () => {
    await record({ channel: 'sms', destination: PAT, scope: 'all', action: 'opt_out', source: 'sms_keyword', occurredAt: new Date('2026-10-29T08:00:00Z'), providerEventId: 'quo:1' });
    await record({ channel: 'email', destination: 'pat@example.com', scope: 'marketing', action: 'opt_out', source: 'unsub_page', occurredAt: new Date('2026-10-29T09:00:00Z') });
    await record({ channel: 'email', destination: 'pat@example.com', scope: 'newsletter', action: 'opt_out', source: 'one_click', occurredAt: new Date('2026-10-29T10:00:00Z') });
    await record({ channel: 'email', destination: 'pat@example.com', scope: 'events', action: 'opt_in', source: 'pref_page', occurredAt: new Date('2026-10-29T11:00:00Z') });
    await record({ channel: 'email', destination: 'pat@example.com', scope: 'newsletter', action: 'opt_in', source: 'pref_page', occurredAt: new Date('2026-10-28T00:00:00Z') });  // older: loses
    const sms = await optout.consentSummary(pool, 'sms', [PAT, SAM, '(313) 555-0009']);
    expect(sms.get(PAT)).toEqual({ version: '1', scopes: { all: { opted_out: true, state: 'opted_out', occurred_at: '2026-10-29T08:00:00.000Z', source: 'sms_keyword' } } });
    expect(sms.get(SAM)).toEqual({ version: '0', scopes: {} });
    expect(sms.get(GHOST)).toEqual({ version: '0', scopes: {} });
    const email = await optout.consentSummary(pool, 'email', ['PAT@example.com']);
    // version = the newest event a STATE row points at: the older newsletter opt_in (#5) lost the guard.
    expect(email.get('pat@example.com')).toEqual({ version: '4', scopes: {
      events: { opted_out: false, state: 'opted_in', occurred_at: '2026-10-29T11:00:00.000Z', source: 'pref_page', label: 'Events', active: false, consent_model: 'opt_in' },
      marketing: { opted_out: true, state: 'opted_out', occurred_at: '2026-10-29T09:00:00.000Z', source: 'unsub_page' },
      newsletter: { opted_out: true, state: 'opted_out', occurred_at: '2026-10-29T10:00:00.000Z', source: 'one_click', label: 'Newsletter', active: true, consent_model: 'opt_out' },
    } });
    // version agrees with consentVersions (Casey's stamp)
    expect((await optout.consentVersions(pool, 'email', ['pat@example.com'])).get('pat@example.com').version).toBe('4');
  });

  test('consentHistory: newest first by (occurred_at, id), the staff actor named, evidence redacted on the way out', async () => {
    const at = new Date('2026-10-30T12:00:00Z');
    await record({ channel: 'email', destination: 'pat@example.com', scope: 'marketing', action: 'opt_out', source: 'unsub_page', occurredAt: at,
      evidence: { token: 'AbCdEfGhIjKlMnOpQrStUv', via: 'unsub_page', ip: '203.0.113.9', user_agent: 'Mozilla/5.0', note: 'n'.repeat(1100) } });
    await record({ channel: 'email', destination: 'pat@example.com', scope: 'marketing', action: 'opt_in', source: 'staff', occurredAt: at, actorUserId: 6,
      evidence: { row_id: 21, via: 'aggregate', note: 'asked to resume' } });   // same instant: the higher id is newer
    await record({ channel: 'email', destination: 'pat@example.com', scope: 'newsletter', action: 'opt_out', source: 'one_click', occurredAt: new Date('2026-10-01T00:00:00Z'),
      evidence: { via: { token: 'NeStEdToKeNnEsTeDtOkEn' }, note: ['x', 'y'], keyword: { k: 1 }, ip: '198.51.100.7' } });   // objects / arrays under allowed keys
    const h = await optout.consentHistory(pool, 'email', ' Pat@Example.com ');
    expect(h.map((e) => [e.id, e.action, e.source, e.actor, e.actor_user_id])).toEqual([[2, 'opt_in', 'staff', 'Fred', 6], [1, 'opt_out', 'unsub_page', null, null], [3, 'opt_out', 'one_click', null, null]]);
    expect(h[0].evidence).toEqual({ via: 'aggregate', note: 'asked to resume' });
    expect(h[1].evidence).toEqual({ via: 'unsub_page', ip: '203.0.113.9', note: `${'n'.repeat(1000)}…` });
    expect(h[1].occurred_at).toBe('2026-10-30T12:00:00.000Z');
    expect(h[2].evidence).toEqual({ ip: '198.51.100.7' });   // scalars only — the JSON column came back as objects / arrays
    expect(JSON.stringify(h)).not.toContain('NeStEdToKeN');
    expect(await optout.consentHistory(pool, 'email', 'pat@example.com', { limit: 1 })).toHaveLength(1);
    expect(await optout.consentHistory(pool, 'sms', 'not a number')).toEqual([]);
  });

  test('import: one opt_out per destination (source import, the SU, contact attribution, cache sync); unchanged for one already out; counts; a second run records nothing', async () => {
    await record({ channel: 'sms', destination: PAT, scope: 'all', action: 'opt_out', source: 'staff', actorUserId: 6 });
    const body = { channel: 'sms', scope: 'all', source: 'import',
      rows: [{ destination: PAT }, { destination: '+1 313-555-0002', note: 'from the old list' }, { destination: GHOST }, { destination: SAM }] };
    const r = await importConsent(pool, body, { actorUserId: 6 });
    expect(r).toMatchObject({ recorded: 2, unchanged: 1, invalid: 0, duplicates: 1 });
    const ev = (await events()).slice(1);
    expect(ev.map((e) => [e.destination, e.scope, e.action, e.source, e.contact_id, e.actor_user_id])).toEqual([
      [SAM, 'all', 'opt_out', 'import', 2, 6], [GHOST, 'all', 'opt_out', 'import', null, 6]]);
    expect(ev[0].evidence).toEqual({ via: 'import', batch_id: r.batch_id, note: 'from the old list' });
    expect(await flag('contact_phones', 12)).toBe(1);                       // recordConsent synced the active row's cache
    expect((await q("SELECT state FROM comm_consent_state WHERE channel='sms' AND destination=? AND scope='all'", [GHOST]))[0].state).toBe('opted_out');
    const again = await importConsent(pool, body, { actorUserId: 6 });
    expect(again).toMatchObject({ recorded: 0, unchanged: 3, duplicates: 1 });
    expect(await events()).toHaveLength(3);
  });

  test('import: an opted-IN state is recorded over (a suppression wins); a topic scope never touches the cache flag', async () => {
    await record({ channel: 'email', destination: 'sam@example.com', scope: 'marketing', action: 'opt_out', source: 'unsub_page', occurredAt: new Date('2026-10-01T00:00:00Z') });
    await record({ channel: 'email', destination: 'sam@example.com', scope: 'marketing', action: 'opt_in', source: 'staff', actorUserId: 6, occurredAt: new Date('2026-10-02T00:00:00Z') });
    expect(await flag('contact_emails', 22)).toBe(0);
    expect(await importConsent(pool, { channel: 'email', scope: 'marketing', rows: [{ destination: 'Sam@Example.com' }] }, { actorUserId: 6 }))
      .toMatchObject({ recorded: 1, unchanged: 0 });
    expect(await flag('contact_emails', 22)).toBe(1);
    expect(await importConsent(pool, { channel: 'email', scope: 'newsletter', rows: [{ destination: 'pat@example.com' }] }, { actorUserId: 6 }))
      .toMatchObject({ recorded: 1 });
    expect(await flag('contact_emails', 21)).toBe(0);
  });

  test('import validation is all-or-nothing; an opt-in and a bad scope are refused; nothing reaches the ledger', async () => {
    const bad = { channel: 'email', scope: 'marketing', rows: [{ destination: 'sam@example.com' }, { destination: 'a@x.com,b@y.com' }] };
    await expect(importConsent(pool, bad)).rejects.toMatchObject({ status: 400, code: 'invalid_rows', extra: { recorded: 0, unchanged: 0, invalid: 1 } });
    await expect(importConsent(pool, { channel: 'sms', scope: 'all', action: 'opt_in', rows: [{ destination: SAM }] })).rejects.toMatchObject({ status: 422 });
    await expect(importConsent(pool, { channel: 'sms', scope: 'all', rows: [{ destination: SAM, action: 'opt_in' }] })).rejects.toMatchObject({ status: 422 });
    await expect(importConsent(pool, { channel: 'email', scope: 'all', rows: [{ destination: 'sam@example.com' }] })).rejects.toMatchObject({ status: 400, code: 'bad_scope' });
    await expect(importConsent(pool, { channel: 'sms', scope: 'newsletter', rows: [{ destination: SAM }] })).rejects.toMatchObject({ status: 400, code: 'bad_scope' });
    expect(await events()).toEqual([]);
    expect(await q('SELECT * FROM comm_consent_state')).toEqual([]);
  });

  test('a 150-destination import (one transaction each) lands every one under one batch_id', async () => {
    const rows = Array.from({ length: 150 }, (_, i) => ({ destination: `248555${String(i).padStart(4, '0')}` }));
    const r = await importConsent(pool, { channel: 'sms', scope: 'all', rows }, { actorUserId: 6 });
    expect(r).toMatchObject({ recorded: 150, unchanged: 0 });
    expect(Number((await q("SELECT COUNT(*) AS n FROM comm_consent_state WHERE channel='sms' AND scope='all' AND state='opted_out'"))[0].n)).toBe(150);
    expect(new Set((await events()).map((e) => e.evidence.batch_id))).toEqual(new Set([r.batch_id]));
  });

  // Whichever commits first decides: the form's toggle either lands (then the
  // import finds the number already out → unchanged) or meets the import's
  // committed opt-out as a moved base → 409 consent_changed (the three-way
  // compare, as designed). Never a deadlock, never a lost opt-out.
  test('an import racing a contact-form toggle of the same number: no deadlock; the toggle lands or is a clean 409; the state ends on the newest event', async () => {
    const dl0 = await deadlocks();
    for (let round = 0; round < 8; round++) {
      await reset();
      const base = await flag('contact_phones', 12);
      // Odd rounds give the form a head start (a few ms), so both orders run.
      const [imp, saved] = await Promise.allSettled([
        new Promise((r) => setTimeout(r, round % 2 ? 4 : 0))
          .then(() => importConsent(pool, { channel: 'sms', scope: 'all', rows: [{ destination: SAM }, { destination: PAT }, { destination: ANN }] }, { actorUserId: 6 })),
        contactService.updateContact(pool, 2, { phones: [{ id: 12, phone: SAM, sms_optout: 1, sms_optout_base: base, sms_optout_note: `round ${round}` }] },
          { userId: 6, consentActor: STAFF6 }),
      ]);
      expect([round, imp.status, imp.reason && imp.reason.code]).toEqual([round, 'fulfilled', undefined]);
      if (saved.status === 'rejected') expect([round, saved.reason.code, saved.reason.status]).toEqual([round, 'consent_changed', 409]);
      expect(imp.value.recorded + imp.value.unchanged).toBe(3);
      const st = (await q("SELECT state, last_event_id FROM comm_consent_state WHERE channel='sms' AND destination=? AND scope='all'", [SAM]))[0];
      const last = (await q("SELECT id FROM comm_consent_events WHERE channel='sms' AND destination=? ORDER BY occurred_at DESC, id DESC LIMIT 1", [SAM]))[0];
      expect([st.state, Number(st.last_event_id)]).toEqual(['opted_out', Number(last.id)]);
      expect(await flag('contact_phones', 12)).toBe(1);
    }
    expect(await deadlocks()).toBe(dl0);
  }, 30000);

  // Review r2: a batch transaction held up to 100 contact rows in FILE order to
  // commit; a form save changing two rows of one contact locks them by id —
  // the other order — and InnoDB rolled back the form ("Save failed", nothing
  // retries it). One transaction per destination holds one row at a time.
  // Here the file lists the contact's two numbers in the reverse of the
  // save's id order; the form either lands or gets a clean 409 — never a
  // deadlock on either side.
  test('an import over two numbers of ONE contact racing a form save of both rows: no deadlock on either side', async () => {
    const P2 = '3135550004';
    for (let round = 0; round < 12; round++) {
      await reset();
      await q(`INSERT INTO contact_phones (id, contact_id, phone, is_primary) VALUES (14, 1, '${P2}', 0)`);
      const [imp, saved] = await Promise.allSettled([
        new Promise((r) => setTimeout(r, round % 3)).then(() => importConsent(pool,
          { channel: 'sms', scope: 'all', rows: [{ destination: P2 }, { destination: PAT }] }, { actorUserId: 6 })),
        new Promise((r) => setTimeout(r, round % 2 ? 2 : 0)).then(() => contactService.updateContact(pool, 1, { phones: [
          { id: 11, phone: PAT, sms_optout: 1, sms_optout_base: 0, is_primary: 1 },
          { id: 14, phone: P2, sms_optout: 1, sms_optout_base: 0, is_primary: 0 },
        ] }, { userId: 6, consentActor: STAFF6 })),
      ]);
      expect([round, imp.status, imp.reason && imp.reason.code]).toEqual([round, 'fulfilled', undefined]);
      if (saved.status === 'rejected') expect([round, saved.reason.code, saved.reason.status]).toEqual([round, 'consent_changed', 409]);
      expect(imp.value.recorded + imp.value.unchanged).toBe(2);
      for (const [id, dest] of [[11, PAT], [14, P2]]) {
        const st = (await q("SELECT state FROM comm_consent_state WHERE channel='sms' AND destination=? AND scope='all'", [dest]))[0];
        expect([round, dest, st && st.state, await flag('contact_phones', id)]).toEqual([round, dest, 'opted_out', 1]);
      }
    }
    // NOT asserted here: InnoDB's deadlock counter. Free-running, it does move —
    // a cycle that is P1's, not the import's: the form holds row 11, then a
    // FOR SHARE GAP lock on comm_consent_state (stateFlag on a number with no
    // state row yet), then asks for row 14; an import transaction holding row
    // 14 (its ONE destination) that inserts its state seed into that gap
    // closes it. InnoDB rolls back the lighter side — the one-row import, in
    // every round measured — and consentTx retries it. ref/plans.md (P4 r2).
  }, 60000);

  // The same interleave forced, not left to the scheduler: the import is
  // paused just before it locks its SECOND number until the form save has
  // locked row 11 and is WAITING (performance_schema.data_lock_waits, bounded
  // poll) — or, when nothing waits because the import already released row 14
  // (one transaction per destination), until the poll gives up. An import
  // still holding row 14 here would close the cycle (14 → 11 vs 11 → 14).
  test('forced interleave: the import between its two numbers while the form holds the other row — no deadlock', async () => {
    const P2 = '3135550004';
    await q(`INSERT INTO contact_phones (id, contact_id, phone, is_primary) VALUES (14, 1, '${P2}', 0)`);
    let release;
    const paused = new Promise((r) => { release = r; });
    let reached;
    const atSecond = new Promise((r) => { reached = r; });
    const wrap = (c) => ({
      query: async (sql, p) => {
        if (/_active_uniq = \? FOR UPDATE$/.test(sql) && p && p[0] === PAT) { reached(); await paused; }
        return c.query(sql, p);
      },
      beginTransaction: () => c.beginTransaction(), commit: () => c.commit(), rollback: () => c.rollback(),
      release: () => c.release(), destroy: () => c.destroy(),
    });
    const db = { query: (sql, p) => pool.query(sql, p), getConnection: async () => wrap(await pool.getConnection()) };
    const dl0 = await deadlocks();
    const imp = importConsent(db, { channel: 'sms', scope: 'all', rows: [{ destination: P2 }, { destination: PAT }] }, { actorUserId: 6 });
    await atSecond;
    const saved = contactService.updateContact(pool, 1, { phones: [
      { id: 11, phone: PAT, sms_optout: 1, sms_optout_base: 0, is_primary: 1 },
      { id: 14, phone: P2, sms_optout: 1, sms_optout_base: 0, is_primary: 0 },
    ] }, { userId: 6, consentActor: STAFF6 }).then((v) => ({ ok: v }), (e) => ({ err: e }));
    for (let i = 0; i < 40; i++) {                       // ≤ 2 s: until the form waits on a lock, or give up
      const [[w]] = await pool.query('SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits');
      if (Number(w.n) > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    release();
    const [r1, r2] = await Promise.all([imp.then((v) => ({ ok: v }), (e) => ({ err: e })), saved]);
    expect([r1.err && r1.err.code, r2.err && r2.err.code]).toEqual([undefined, r2.err ? 'consent_changed' : undefined]);
    expect(r1.ok.recorded + r1.ok.unchanged).toBe(2);
    expect([await flag('contact_phones', 11), await flag('contact_phones', 14)]).toEqual([1, 1]);
    expect(await deadlocks()).toBe(dl0);
  }, 30000);

  test('preview counts = executeSend\'s own per-contact reader call (contacts.contact_phone / contact_email; the question by class — C1); the STATE decides, not the row flag', async () => {
    await record({ channel: 'sms', destination: PAT, scope: 'all', action: 'opt_out', source: 'staff', actorUserId: 6 });
    // ANN: opted out in the STATE with the row flag forced clear (a drifted cache) — still skipped.
    await record({ channel: 'sms', destination: ANN, scope: 'all', action: 'opt_out', source: 'sms_keyword', providerEventId: 'rc:9' });
    await q('UPDATE contact_phones SET sms_optout = 0 WHERE id = 13');
    await record({ channel: 'email', destination: 'pat@example.com', scope: 'marketing', action: 'opt_out', source: 'unsub_page' });
    await record({ channel: 'email', destination: 'sam@example.com', scope: 'newsletter', action: 'opt_out', source: 'one_click' });   // a topic: not a campaign skip
    const ids = [1, 2, 3, 4, 99];
    for (const [channel, klass] of [['sms', 'operational'], ['email', 'operational'], ['email', 'marketing']]) {
      const pv = await previewConsent(pool, { channel, class: klass, contact_ids: ids });
      // executeSend's consent step, per contact, verbatim reader call (none for operational email, D18).
      const consent = campaignConsent(channel, klass, null);
      const want = { skipped_optout: 0, missing_destination: 0, will_send: 0, not_found: 0 };
      for (const id of ids) {
        const [[c]] = await pool.query('SELECT contact_id, contact_name, contact_phone, contact_email FROM contacts WHERE contact_id = ?', [id]);
        if (!c) { want.not_found++; continue; }
        const dest = channel === 'sms' ? c.contact_phone : c.contact_email;
        const hits = consent ? await optout.findOptedOut(pool, channel, dest, consent) : [];
        if (hits.length) want.skipped_optout++;
        else if (!dest) want.missing_destination++;
        else want.will_send++;
      }
      expect([channel, klass, pv]).toEqual([channel, klass, { channel, class: klass, topic: null, selected: 5, ...want }]);
    }
    expect(await previewConsent(pool, { channel: 'sms', contact_ids: [1, 2, 3, 4, 99] })).toMatchObject({ skipped_optout: 2, will_send: 1, missing_destination: 1, not_found: 1 });
    // operational (the default): Pat's marketing opt-out skips nothing (D18); marketing skips her
    expect(await previewConsent(pool, { channel: 'email', contact_ids: [1, 2, 3, 4, 99] })).toMatchObject({ skipped_optout: 0, will_send: 3, missing_destination: 1, not_found: 1 });
    expect(await previewConsent(pool, { channel: 'email', class: 'marketing', contact_ids: [1, 2, 3, 4, 99] })).toMatchObject({ skipped_optout: 1, will_send: 2, missing_destination: 1, not_found: 1 });
    expect(campaignConsent('email', 'operational', null)).toBeNull();
  });
});
