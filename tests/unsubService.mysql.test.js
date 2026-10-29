// tests/unsubService.mysql.test.js
//
/**
 * YisraMail P3 — the unsubscribe substrate on a REAL engine
 * (services/unsubService.js over services/optoutService.recordConsent;
 * ref/YISRAMAIL_DESIGN.md §4.5). Nothing in the code under test is mocked:
 * the services run on a pool against the scratch DB (only the alert sink is
 * stubbed).
 *
 * WHAT IS HELD TO THE ENGINE
 *   - comm_unsub_tokens as the migration script creates it: the token is
 *     utf8mb4_bin — the same token with one letter's case flipped is a
 *     different token (lookup → null; mint inserts both).
 *   - mint: collision retry on ER_DUP_ENTRY, the topic checks (exists, email,
 *     active), refusals.
 *   - oneClick / applyPage through the real recordConsent: the state ends
 *     opted_out, `marketing` syncs the active contact_emails row's cache flag
 *     (a topic never does), send_ref / contact_id copied onto the event,
 *     used_at first use only, a second request writes nothing.
 *   - CONCURRENCY (the token lock + plain-read design in unsubService's
 *     header): two one-clicks on the SAME token at once record exactly ONE
 *     event; requests on DIFFERENT tokens for one address — with and without
 *     an active contact row, and multi-scope page requests — never deadlock.
 *   - scripts/yisramailP3Migrate.js run(): CHECK, --apply, re-apply, and its
 *     rolled-back case probe on the engine.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3377/yc_p3_test npx jest tests/unsubService.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates
 * contacts / contact_emails (cloned from ref/database.sql), the three comm_*
 * consent tables (tests/helpers/consentSchema.js — siblings create them too,
 * so they are dropped first) and comm_unsub_tokens (from the P3 migration
 * file, through the script). Run it on a server started with
 * --default-time-zone=+00:00 and the production sql_mode (the pool also sets
 * the session sql_mode). Never point it at port 3306 (the production proxy).
 */
'use strict';

jest.mock('../lib/alerting', () => ({ alert: jest.fn(async () => {}) }));

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const unsub = require('../services/unsubService');
const migrate = require('../scripts/yisramailP3Migrate');
const { CONSENT_TABLES, buildConsentTables } = require('./helpers/consentSchema');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['contacts', 'contact_emails'];

// CREATE + ALTER blocks for `tables` from ref/database.sql (the consentCore
// twin's extraction: the ALTER blocks carry every key, incl. the active-only
// unique key recordConsent locks through).
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

const ADDR = 'pat@example.com';
const ROWLESS = 'nobody@example.com';
const seq = (() => { let n = 0; return () => `TwinTok${String(++n).padStart(15, '0')}`; })();   // 22 chars, distinct

d('unsubscribe substrate on real MySQL', () => {
  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const events = () => q('SELECT id, destination, scope, action, source, contact_id, send_ref, evidence FROM comm_consent_events ORDER BY id');
  const stateOf = async (destination, scope) => {
    const r = (await q("SELECT state FROM comm_consent_state WHERE channel = 'email' AND destination = ? AND scope = ?", [destination, scope]))[0];
    return r ? r.state : null;
  };
  const flag = async (id) => Number((await q('SELECT email_optout AS f FROM contact_emails WHERE id = ?', [id]))[0].f);
  const tokenRow = async (t) => (await q('SELECT * FROM comm_unsub_tokens WHERE token = ?', [t]))[0] || null;

  async function reset() {
    await q('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of [migrate.TABLE, ...CONSENT_TABLES, ...TABLES]) await q(`DROP TABLE IF EXISTS \`${t}\``);
    await q('SET FOREIGN_KEY_CHECKS = 1');
    for (const sql of schemaFor(TABLES)) await q(sql);
    await buildConsentTables(q);                          // fresh, seeded with 'newsletter'
    const conn = await pool.getConnection();
    try {
      const r = await migrate.run(conn, { apply: true, say: () => {} });
      if (!r.ok) throw new Error(r.line);
    } finally { conn.release(); }
    await q("INSERT INTO comm_topics (topic_key, channel, label, consent_model) VALUES ('events', 'email', 'Events', 'opt_out'), ('old_list', 'email', 'Old', 'opt_out'), ('sms_marketing', 'sms', 'Texts', 'opt_in')");
    await q("UPDATE comm_topics SET active = 0 WHERE topic_key = 'old_list'");
    await q("INSERT INTO contacts (contact_id, contact_name, contact_fname, contact_lname) VALUES (1, 'Pat Doe', 'Pat', 'Doe')");
    await q(`INSERT INTO contact_emails (id, contact_id, email, email_optout, end_date) VALUES (21, 1, '${ADDR}', 0, NULL)`);
  }

  /** Mint on a connection of its own (C2 mints on the caller's connection). */
  async function mint(destination, topicKey = 'newsletter', extra = {}, seam) {
    const conn = await pool.getConnection();
    try { return await unsub.mintUnsubToken(conn, { destination, topicKey, ...extra }, seam); } finally { conn.release(); }
  }

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    if (new URL(URL_).port === '3306') throw new Error('refusing to run against the production proxy port');
    pool = mysql.createPool({ uri: URL_, connectionLimit: 8, timezone: 'Z' });
    pool.on('connection', (conn) => conn.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
  });
  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await reset();
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { if (pool) await pool.end(); });

  // ───────────────────────────────────────────────────────────────────────
  describe('the table and the migration script', () => {
    test('CHECK is GO with nothing to apply; a re-apply verifies again; the case probe left no row behind', async () => {
      const conn = await pool.getConnection();
      const lines = [];
      try {
        const check = await migrate.run(conn, { say: (l) => lines.push(l) });
        expect(check.ok).toBe(true);
        expect(check.line).toMatch(/^CHECK OK — comm_unsub_tokens is in place/);
        const again = await migrate.run(conn, { apply: true, say: (l) => lines.push(l) });
        expect(again).toMatchObject({ ok: true, created: false });
        expect(again.line).toMatch(/^ALREADY IN PLACE/);
      } finally { conn.release(); }
      expect(await q('SELECT COUNT(*) AS n FROM comm_unsub_tokens')).toEqual([{ n: 0 }]);
    });

    test('a token column that is NOT case-sensitive is refused by CHECK (NO-GO, nothing altered)', async () => {
      await q('ALTER TABLE comm_unsub_tokens MODIFY token char(22) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL');
      const conn = await pool.getConnection();
      try {
        const r = await migrate.run(conn, { say: () => {} });
        expect(r.ok).toBe(false);
        expect(r.line).toMatch(/^NO-GO — comm_unsub_tokens exists with another shape/);
        expect(await migrate.shapeProblems(conn)).toEqual(['token collation utf8mb4_general_ci, expected utf8mb4_bin']);
      } finally { conn.release(); }
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  describe('mint + lookup', () => {
    test('lookup is CASE-SENSITIVE: one letter flipped is null — and both spellings insert as two rows', async () => {
      const a = 'CaseTokenAbcdefghijklm';
      const b = 'CaseTokenAbcdefghijklM';
      expect(await mint(ADDR, 'newsletter', {}, { generate: () => a })).toBe(a);
      expect(await mint(ADDR, 'newsletter', {}, { generate: () => b })).toBe(b);
      expect((await q('SELECT COUNT(*) AS n FROM comm_unsub_tokens'))[0].n).toBe(2);
      await q('DELETE FROM comm_unsub_tokens WHERE token = ?', [b]);
      expect(await unsub.lookupToken(pool, b)).toBeNull();
      const info = await unsub.lookupToken(pool, a);
      expect(info).toMatchObject({ token: a, destination: ADDR, topic_key: 'newsletter', topic_label: 'Newsletter', topic_exists: true });
    });

    test('mint stores the row as given (normalized address, ids, send_ref)', async () => {
      const t = await mint('  Pat@Example.COM ', 'newsletter', { campaignId: 85, contactId: 1, sendRef: 'cr-1' });
      expect(t).toMatch(/^[0-9A-Za-z]{22}$/);
      expect(await tokenRow(t)).toMatchObject({ token: t, channel: 'email', destination: ADDR, topic_key: 'newsletter', campaign_id: 85, contact_id: 1, send_ref: 'cr-1', used_at: null });
    });

    test('collision retry: a taken token is retried (ER_DUP_ENTRY); five collisions throw', async () => {
      const taken = 'TakenTokenAbcdefghijkl';
      await mint(ADDR, 'newsletter', {}, { generate: () => taken });
      const fresh = 'FreshTokenAbcdefghijkl';
      const gen = [taken, taken, fresh];
      let n = 0;
      expect(await mint(ADDR, 'newsletter', {}, { generate: () => gen[n++] })).toBe(fresh);
      expect(n).toBe(3);
      await expect(mint(ADDR, 'newsletter', {}, { generate: () => taken })).rejects.toThrow(/no unique token after 5 attempts/);
    });

    test('refusals: an inactive topic, an SMS topic, an unknown topic, the marketing scope, a bad address', async () => {
      await expect(mint(ADDR, 'old_list')).rejects.toThrow(/not active/);
      await expect(mint(ADDR, 'sms_marketing')).rejects.toThrow(/not a email topic/);
      await expect(mint(ADDR, 'nope')).rejects.toThrow(/not a email topic/);
      await expect(mint(ADDR, 'marketing')).rejects.toThrow(/one marketing topic/);
      await expect(mint('not-an-address', 'newsletter')).rejects.toThrow(/not a valid address/);
      expect((await q('SELECT COUNT(*) AS n FROM comm_unsub_tokens'))[0].n).toBe(0);
    });

    test('lookupToken is READ ONLY and reads the states it renders from', async () => {
      const t = await mint(ADDR);
      await q("INSERT INTO comm_consent_state (channel, destination, scope, state, occurred_at, last_event_id, updated_at) VALUES ('email', ?, 'events', 'opted_out', NOW(3), 99, NOW(3))", [ADDR]);
      const info = await unsub.lookupToken(pool, t);
      expect(info.states).toEqual({ marketing: null, events: 'opted_out', newsletter: null });
      expect(info.receives).toEqual({ events: false, newsletter: true });
      expect(info.topics.map((x) => x.topic_key)).toEqual(['events', 'newsletter']);
      expect(await events()).toEqual([]);
      expect((await tokenRow(t)).used_at).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  describe('oneClick / applyPage through the real recordConsent', () => {
    test('one-click: the topic ends opted_out; the topic never touches the row cache; a 2nd writes nothing', async () => {
      const t = await mint(ADDR, 'newsletter', { campaignId: 85, contactId: 1, sendRef: 'cr-7' });
      expect(await unsub.oneClick(pool, t, { ip: '203.0.113.9', userAgent: 'UA' })).toEqual({ ok: true, applied: true });
      expect(await stateOf(ADDR, 'newsletter')).toBe('opted_out');
      expect(await flag(21)).toBe(0);
      const ev = await events();
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ destination: ADDR, scope: 'newsletter', action: 'opt_out', source: 'one_click', contact_id: 1, send_ref: 'cr-7' });
      expect(ev[0].evidence).toEqual({ token: t, via: 'rfc8058', ip: '203.0.113.9', user_agent: 'UA', campaign_id: 85 });
      expect((await tokenRow(t)).used_at).toBeInstanceOf(Date);
      // used_at is the FIRST use only: pin it in the past, use the link again (a
      // one-click and a page POST), and it must not move.
      await q("UPDATE comm_unsub_tokens SET used_at = '2026-01-02 03:04:05' WHERE token = ?", [t]);
      expect(await unsub.oneClick(pool, t, {})).toEqual({ ok: true, applied: false });
      await unsub.applyPage(pool, t, { action: 'unsubscribe' });
      expect(await events()).toHaveLength(1);
      expect((await tokenRow(t)).used_at).toEqual(new Date('2026-01-02T03:04:05Z'));
    });

    test('"stop all" (scope marketing): the state ends opted_out and the ACTIVE row\'s cache flag ends 1', async () => {
      const t = await mint(ADDR, 'newsletter', { contactId: 1 });
      const out = await unsub.applyPage(pool, t, { action: 'all' });
      expect(out).toMatchObject({ ok: true, changed: [{ scope: 'marketing', action: 'opt_out' }] });
      expect(await stateOf(ADDR, 'marketing')).toBe('opted_out');
      expect(await flag(21)).toBe(1);
    });

    test('a topic deleted since mint: the one-click falls back to marketing (cache 1), evidence names the topic', async () => {
      const t = await mint(ADDR, 'events');
      await q("DELETE FROM comm_topics WHERE topic_key = 'events'");
      await unsub.oneClick(pool, t, {});
      const ev = await events();
      expect(ev.map((e) => [e.scope, e.source])).toEqual([['marketing', 'one_click']]);
      expect(ev[0].evidence.topic_missing).toBe('events');
      expect(await flag(21)).toBe(1);
    });

    test('prefs after stop-all: marketing opted back in, the unticked topic opted out — the cache follows', async () => {
      const t = await mint(ADDR, 'newsletter', { contactId: 1 });
      await unsub.applyPage(pool, t, { action: 'all' });
      const out = await unsub.applyPage(pool, t, { action: 'prefs', topics: { events: 'in' } });
      expect(out.changed).toEqual([{ scope: 'marketing', action: 'opt_in' }, { scope: 'newsletter', action: 'opt_out' }]);
      expect(await stateOf(ADDR, 'marketing')).toBe('opted_in');
      expect(await stateOf(ADDR, 'newsletter')).toBe('opted_out');
      expect(await flag(21)).toBe(0);
      expect((await events()).map((e) => e.source)).toEqual(['unsub_page', 'pref_page', 'pref_page']);
    });

    test('an unknown topic is refused before anything is written (and the transaction never opened)', async () => {
      const t = await mint(ADDR);
      await expect(unsub.applyPage(pool, t, { action: 'prefs', topics: { old_list: 'in' } })).rejects.toMatchObject({ status: 422, code: 'bad_topic' });
      expect(await events()).toEqual([]);
      expect((await tokenRow(t)).used_at).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  describe('concurrency — no deadlock, no double record on one token', () => {
    test('two one-clicks on the SAME token at once: exactly ONE event (the token lock serializes; the 2nd reads after the 1st commits)', async () => {
      const t = await mint(ADDR, 'newsletter');
      for (let round = 0; round < 5; round++) {
        await q('DELETE FROM comm_consent_events'); await q('DELETE FROM comm_consent_state');
        const results = await Promise.all([unsub.oneClick(pool, t, {}), unsub.oneClick(pool, t, {})]);
        expect(results.filter((r) => r.applied)).toHaveLength(1);
        expect(await events()).toHaveLength(1);
        expect(await stateOf(ADDR, 'newsletter')).toBe('opted_out');
      }
    });

    test.each([
      ['an active contact row', ADDR],
      ['no contact row (an outside-list address)', ROWLESS],
    ])('one-clicks on DIFFERENT tokens for one address — %s: all succeed, the state ends opted_out', async (_, addr) => {
      const toks = [];
      for (let i = 0; i < 6; i++) toks.push(await mint(addr, 'newsletter', {}, { generate: seq }));
      const results = await Promise.all(toks.map((t) => unsub.oneClick(pool, t, {})));
      expect(results.every((r) => r.ok)).toBe(true);
      expect(await stateOf(addr, 'newsletter')).toBe('opted_out');
      const ev = (await events()).filter((e) => e.destination === addr);
      expect(ev.length).toBeGreaterThanOrEqual(1);
      expect(ev.every((e) => e.action === 'opt_out' && e.scope === 'newsletter')).toBe(true);
    });

    test.each([
      ['an active contact row', ADDR],
      ['no contact row', ROWLESS],
    ])('multi-scope page requests racing on different tokens — %s: no deadlock', async (_, addr) => {
      const toks = [];
      for (let i = 0; i < 4; i++) toks.push(await mint(addr, 'newsletter', {}, { generate: seq }));
      await unsub.applyPage(pool, toks[0], { action: 'all' });
      const results = await Promise.allSettled([
        unsub.applyPage(pool, toks[1], { action: 'prefs', topics: { events: 'in' } }),
        unsub.applyPage(pool, toks[2], { action: 'prefs', topics: { newsletter: 'in' } }),
        unsub.applyPage(pool, toks[3], { action: 'all' }),
        unsub.oneClick(pool, toks[1], {}),
      ]);
      const failed = results.filter((r) => r.status === 'rejected').map((r) => r.reason && (r.reason.code || r.reason.message));
      expect(failed).toEqual([]);
    });
  });
});
