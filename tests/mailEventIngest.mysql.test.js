// tests/mailEventIngest.mysql.test.js
//
/**
 * YisraMail T2 — mail_event_ingest + transportHealth on REAL MySQL
 * (services/mailEventService.js, lib/internal_functions/mail.js).
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3321/yc_mailevt_test npx jest tests/mailEventIngest.mysql.test.js --runInBand
 * Fresh *_test DB, mysqld --default-time-zone=+00:00, prod sql_mode.
 * SELF-BUILDING: it drops and rebuilds every table it touches (campaign_results
 * via scripts/yisramailT2Migrate.js on a pre-T2 clone, the P1 consent tables
 * from their migration file, the rest from ref/database.sql) — and first drops
 * any table a SIBLING left that holds a foreign key into one of them (found in
 * information_schema, e.g. consentCore's contact_phones → contacts), or the
 * rebuild of the referenced table is refused.
 * ORDER-INDEPENDENCE, proved on ONE fresh _test DB (2026-11-02, r2): consentCore
 * → mailEventIngest → consentCore → mailEventIngest, and mailEventIngest →
 * consentCore → mailEventIngest → consentCore — every run exit 0.
 *
 * Mocked at the module boundary: lib/alerting (alert calls are asserted —
 * severity and dedup key) and services/taskService.createTask (a stand-in
 * that writes the tasks row, so the dedupe key lives on a real row; the real
 * one schedules post-commit email work that would outlive the suite).
 *
 * LOCKED: correlation by result_id tag (of the tagged campaign) first, the
 * provider message id second; delivery columns with precedence, set-once
 * timestamps and Date types; a hard bounce → ledger event + state + the
 * cached row flag; a replay → duplicate no-op; a complaint → ledger + warning;
 * a soft bounce → no ledger; a client's bounce → one task, a non-client's →
 * none; the bounce-rate error alert; transportHealth from seeded rows.
 */

'use strict';

jest.mock('../lib/alerting', () => ({ alert: jest.fn(async () => ({ inserted: true })) }));
jest.mock('../services/taskService', () => ({ createTask: jest.fn() }));

const fs = require('fs');
const path = require('path');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const FIX = path.join(__dirname, 'fixtures', 'ses-events');
const load = (n) => {   // the captured event when step 0 produced one, else the documented shape
  const real = path.join(FIX, `${n}.json`);
  return JSON.parse(fs.readFileSync(fs.existsSync(real) ? real : path.join(FIX, `${n}.assumed.json`), 'utf8'));
};

maybe('mail_event_ingest on real MySQL', () => {
  const mysql = require('mysql2/promise');
  const schema = require('./helpers/commsArchiveSchema');
  const { buildConsentTables, CONSENT_TABLES } = require('./helpers/consentSchema');
  const migrate = require('../scripts/yisramailT2Migrate');
  const migrateC6 = require('../scripts/yisramailC6Migrate');
  const { alert } = require('../lib/alerting');
  const { createTask } = require('../services/taskService');
  const svc = require('../services/mailEventService');
  const fns = require('../lib/internal_functions/mail');
  const TABLES = ['campaign_results', 'campaigns', 'email_credentials', 'contacts', 'contact_emails', 'case_relate', 'cases', 'tasks', 'app_settings', 'users', 'system_alerts'];
  const MID = '0100019a3c2b1a00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-000000';
  const CAPTURED_DIAG = 'smtp; 550 5.1.1 As requested: user unknown <bounce@simulator.amazonses.com>';
  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const row = async (id) => (await q('SELECT * FROM campaign_results WHERE result_id = ?', [id]))[0];
  const events = () => q('SELECT destination, scope, action, source, provider_event_id, contact_id, send_ref, evidence FROM comm_consent_events ORDER BY id');

  /** A fixture with its recipient / tags / ids swapped. */
  function ev(name, { to, resultId = '41', campaignId = '7', id, messageId = MID, subtype } = {}) {
    const b = load(name);
    if (id) b.id = id;
    b.detail.mail.messageId = messageId;
    b.detail.mail.tags.result_id = [resultId];
    if (campaignId === null) delete b.detail.mail.tags.campaign_id; else b.detail.mail.tags.campaign_id = [campaignId];
    if (subtype && b.detail.bounce) b.detail.bounce.bounceSubType = subtype;
    if (to) {
      b.detail.mail.destination = [to];
      for (const k of ['bounce', 'complaint', 'deliveryDelay']) {
        const sub = b.detail[k];
        const list = sub && (sub.bouncedRecipients || sub.complainedRecipients || sub.delayedRecipients);
        if (list) list.forEach((r) => { r.emailAddress = to; });
      }
      if (b.detail.delivery) b.detail.delivery.recipients = [to];
    }
    return b;
  }

  /** Drop every table outside TABLES that holds a foreign key into one of TABLES (a sibling's leftovers), until none is left. */
  async function dropReferencing() {
    for (let round = 0; round < 10; round++) {
      const refs = (await q(`SELECT DISTINCT TABLE_NAME AS t FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IN (?) AND TABLE_NAME NOT IN (?)`, [TABLES, TABLES])).map((r) => r.t);
      if (!refs.length) return;
      const conn = await pool.getConnection();
      try {
        await conn.query('SET FOREIGN_KEY_CHECKS = 0');
        for (const t of refs) await conn.query(`DROP TABLE IF EXISTS \`${t}\``);
      } finally { await conn.query('SET FOREIGN_KEY_CHECKS = 1').catch(() => {}); conn.release(); }
    }
    throw new Error('dropReferencing: still referenced after 10 rounds');
  }

  async function reset() {
    await dropReferencing();
    await q('SET FOREIGN_KEY_CHECKS = 0');
    await schema.build(pool, TABLES);
    // the pre-T2 shape whatever the dump says (post-land dumps carry the columns)
    const t2 = (await q(`SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaign_results' AND COLUMN_NAME IN (?)`,
      [Object.keys(migrate.EXPECTED_COLUMNS)])).map((r) => r.n);
    if (t2.length) await q(`ALTER TABLE campaign_results ${t2.map((n) => `DROP COLUMN ${n}`).join(', ')}`);
    // C6 (engagement): same treatment — drop whatever the dump carried, so the
    // C6 migration script itself runs and verifies on the real engine below.
    const c6 = (await q(`SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaign_results' AND COLUMN_NAME IN (?)`,
      [Object.keys(migrateC6.EXPECTED_RESULT_COLUMNS)])).map((r) => r.n);
    if (c6.length) await q(`ALTER TABLE campaign_results ${c6.map((n) => `DROP COLUMN ${n}`).join(', ')}`);
    await q('DROP TABLE IF EXISTS campaign_clicks');
    await buildConsentTables(q);
    await q('SET FOREIGN_KEY_CHECKS = 1');
    const conn = await pool.getConnection();
    try {
      const r = await migrate.run(conn, { apply: true, say: () => {} });
      if (!r.ok) throw new Error(r.line);
      const r6 = await migrateC6.run(conn, { apply: true, say: () => {} });
      if (!r6.ok) throw new Error(r6.line);
    } finally { conn.release(); }
    await q("INSERT INTO email_credentials (id, email, smtp_host, smtp_port, smtp_user, smtp_pass, provider, from_name) VALUES (17, 'news@news.test', 'email-smtp.us-east-2.amazonaws.com', 587, 'AKIAX', 'x', 'smtp', 'News')");
    await q("INSERT INTO campaigns (campaign_id, type, sender, body, status) VALUES (7, 'email', 'news@news.test', 'b', 'sent'), (8, 'email', 'news@news.test', 'b', 'sent'), (9, 'email', 'other@firm.test', 'b', 'sent')");
    await q(`INSERT INTO campaign_results (result_id, campaign_id, contact_id, status) VALUES (41, 7, 1, 'sent'), (42, 7, 2, 'sent'), (43, 8, 3, 'sent')`);
    await q('UPDATE campaign_results SET provider_message_id = ? WHERE result_id = 43', ['msg-forty-three']);
    await q("INSERT INTO contacts (contact_id, contact_name, contact_fname, contact_lname) VALUES (1, 'Cli Ent', 'Cli', 'Ent'), (2, 'Non Client', 'Non', 'Client')");
    await q("INSERT INTO contact_emails (id, contact_id, email, email_optout, end_date) VALUES (11, 1, 'bounce@example.com', 0, NULL), (12, 2, 'nonclient@example.com', 0, NULL), (13, 1, 'complaint@example.com', 0, NULL)");
    await q("INSERT INTO cases (case_id, case_stage) VALUES ('C1', 'Open')");
    await q("INSERT INTO case_relate (case_relate_id, case_relate_case_id, case_relate_client_id, case_relate_type) VALUES (1, 'C1', 1, 'Primary')");
    await q("INSERT INTO users (user, username, user_auth) VALUES (6, 'fred', 'authorized')");
    await q("INSERT INTO app_settings (`key`, `value`) VALUES ('consent_task_user_id', '6')");
  }

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    if (new URL(URL_).port === '3306') throw new Error('refusing to run against the production proxy port');
    pool = mysql.createPool({ uri: URL_, connectionLimit: 8, timezone: 'Z' });
    pool.on('connection', (c) => c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
  });
  beforeEach(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    alert.mockClear();
    createTask.mockReset();
    createTask.mockImplementation(async (db, o) => {
      const [r] = await db.query("INSERT INTO tasks (task_from, task_to, task_title, task_desc, task_link, task_link_type, task_link_id, task_source, task_status) VALUES (?, ?, ?, ?, '', ?, ?, ?, 'Pending')",
        [o.from, o.to, o.title, o.desc, o.link_type, String(o.link_id), o.source]);
      return { task_id: r.insertId };
    });
    await reset();
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    if (!pool) return;
    await q('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of [...TABLES, ...CONSENT_TABLES, 'campaign_clicks']) await q(`DROP TABLE IF EXISTS \`${t}\``);
    await pool.end();
  });

  test('a delivery correlates by the result_id tag: delivered, delivered_at (a real Date), the message id filled', async () => {
    const out = await svc.ingest(pool, ev('delivery', { to: 'x@example.com' }));
    expect(out).toMatchObject({ parsed: 1, updated: 1, unknown: 0, ledger: { recorded: 0, duplicate: 0 } });
    const r = await row(41);
    expect(r.delivery_status).toBe('delivered');
    expect(r.delivered_at).toBeInstanceOf(Date);
    expect(r.delivered_at.toISOString()).toBe('2026-11-01T23:20:40.776Z');
    expect(r.provider_message_id).toBe(MID);
    expect((await row(42)).delivery_status).toBe('unknown');
  });

  test('the result_id tag wins even when the message id names another row; no row / another campaign → the message id', async () => {
    await svc.ingest(pool, ev('delivery', { to: 'x@example.com', messageId: 'msg-forty-three' }));
    expect((await row(41)).delivery_status).toBe('delivered');
    expect((await row(41)).provider_message_id).toBeNull();          // 43 already carries that id: never made ambiguous
    expect((await row(43)).delivery_status).toBe('unknown');
    await svc.ingest(pool, ev('bounce-transient', { to: 'x@example.com', resultId: '999', messageId: 'msg-forty-three', id: 'e-2' }));
    expect((await row(43)).delivery_status).toBe('bounced_soft');
    await svc.ingest(pool, ev('complaint', { to: 'q@example.com', resultId: '41', campaignId: '8', messageId: 'msg-forty-three', id: 'e-3' }));
    expect((await row(43)).delivery_status).toBe('complained');
    expect((await row(41)).delivery_status).toBe('delivered');      // its campaign tag did not match 41's campaign
  });

  test('a non-campaign send (acceptance tags t2 / t2-1) is unknown: no row touched, yet a hard bounce still records the opt-out', async () => {
    const out = await svc.ingest(pool, ev('bounce-permanent', { to: 'sim@example.com', resultId: 't2-1', campaignId: 't2', messageId: 'no-such' }));
    expect(out).toMatchObject({ updated: 0, unknown: 1, ledger: { recorded: 1 } });
    expect((await events())[0]).toMatchObject({ destination: 'sim@example.com', send_ref: null, contact_id: null });
  });

  test('a hard bounce → ledger (provider_bounce, scope marketing, send_ref, evidence) + state + the cached row flag; a replay is a duplicate no-op', async () => {
    const body = ev('bounce-permanent', { to: 'bounce@example.com' });
    const out = await svc.ingest(pool, body);
    expect(out).toMatchObject({ updated: 1, ledger: { recorded: 1, duplicate: 0 } });
    const [e] = await events();
    expect(e).toMatchObject({ destination: 'bounce@example.com', scope: 'marketing', action: 'opt_out', source: 'provider_bounce',
      provider_event_id: `${body.id}:bounce@example.com`, contact_id: 1, send_ref: '41' });
    expect(e.evidence).toEqual({ via: 'ses', event_type: 'bounce_hard', bounce_type: 'Permanent', diagnostic: CAPTURED_DIAG, message_id: MID });
    expect((await q("SELECT state FROM comm_consent_state WHERE channel='email' AND destination='bounce@example.com' AND scope='marketing'"))[0].state).toBe('opted_out');
    expect(Number((await q('SELECT email_optout FROM contact_emails WHERE id = 11'))[0].email_optout)).toBe(1);
    const r = await row(41);
    expect(r).toMatchObject({ delivery_status: 'bounced_hard', delivery_diag: CAPTURED_DIAG });
    expect(r.bounced_at.toISOString()).toBe('2026-11-01T23:20:48.898Z');

    const again = await svc.ingest(pool, body);
    expect(again).toMatchObject({ updated: 1, ledger: { recorded: 0, duplicate: 1 }, tasks: 0 });
    expect(await events()).toHaveLength(1);
  });

  test('a complaint → ledger (provider_complaint) + a warning alert, one per address per day', async () => {
    await svc.ingest(pool, ev('complaint', { to: 'complaint@example.com' }));
    expect((await events())[0]).toMatchObject({ source: 'provider_complaint', scope: 'marketing', action: 'opt_out' });
    expect((await row(41)).delivery_status).toBe('complained');
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][1]).toMatchObject({ severity: 'warning', kind: 'mail_complaint',
      dedup_key: `mail_complaint:complaint@example.com:${new Date().toISOString().slice(0, 10)}` });
  });

  test('a soft bounce writes no ledger event; precedence: delivered beats an earlier soft bounce, a later delay never downgrades it', async () => {
    await svc.ingest(pool, ev('bounce-transient', { to: 'x@example.com', id: 's1' }));
    expect(await events()).toEqual([]);
    expect((await row(41)).delivery_status).toBe('bounced_soft');
    const firstBounce = (await row(41)).bounced_at;
    await svc.ingest(pool, ev('delivery', { to: 'x@example.com', id: 's2' }));
    expect((await row(41)).delivery_status).toBe('delivered');
    await svc.ingest(pool, ev('delivery-delay', { to: 'x@example.com', id: 's3' }));
    const r = await row(41);
    expect(r.delivery_status).toBe('delivered');
    expect(r.delivery_diag).toBe('250 Ok');
    expect(r.bounced_at.toISOString()).toBe(firstBounce.toISOString());   // set once
    expect(await events()).toEqual([]);
  });

  test('D17: a client\'s hard bounce → ONE task (deduped across events); a non-client\'s → none', async () => {
    const out = await svc.ingest(pool, ev('bounce-permanent', { to: 'bounce@example.com', id: 'b1' }));
    expect(out.tasks).toBe(1);
    await svc.ingest(pool, ev('bounce-permanent', { to: 'bounce@example.com', id: 'b2' }));   // a second bounce, a new event id
    const tasks = await q('SELECT task_to, task_link_type, task_link_id, task_dedupe_key FROM tasks');
    expect(tasks).toEqual([{ task_to: 6, task_link_type: 'contact', task_link_id: '1', task_dedupe_key: 'mail_bounce:bounce@example.com' }]);
    expect(createTask).toHaveBeenCalledTimes(1);
    const non = await svc.ingest(pool, ev('bounce-permanent', { to: 'nonclient@example.com', resultId: '42', id: 'b3' }));
    expect(non).toMatchObject({ ledger: { recorded: 1 }, tasks: 0 });
    expect(createTask).toHaveBeenCalledTimes(1);
  });

  test('transportHealth: 24 h counts and rates from seeded rows (by transport and by campaign); the bounce-rate alert at > 5 % with ≥ 200 delivered', async () => {
    const now = Date.now();
    const recent = new Date(now - 3600e3);
    const old = new Date(now - 30 * 3600e3);
    const rows = [];
    for (let i = 0; i < 200; i++) rows.push([7, 1000 + i, 'sent', 'delivered', recent, null, null]);
    for (let i = 0; i < 5; i++) rows.push([8, 2000 + i, 'sent', 'bounced_hard', null, recent, null]);
    for (let i = 0; i < 2; i++) rows.push([8, 3000 + i, 'sent', 'complained', recent, null, recent]);
    for (let i = 0; i < 50; i++) rows.push([7, 4000 + i, 'sent', 'delivered', old, null, null]);          // outside the window
    rows.push([9, 5000, 'sent', 'bounced_hard', null, recent, null]);                                      // another transport
    await q('INSERT INTO campaign_results (campaign_id, contact_id, status, delivery_status, delivered_at, bounced_at, complained_at) VALUES ?', [rows]);
    const h = await svc.transportHealth(pool, { credentialId: 17 });
    expect(h).toEqual({ window_h: 24, delivered: 202, bounced_hard: 5, suppressed: 0, complained: 2,
      delivery_rate: 202 / 207, complaint_rate: 2 / 202, bounce_rate: 5 / 207, enough: true });
    expect(await svc.transportHealth(pool, { campaignId: 8 })).toMatchObject({ delivered: 2, bounced_hard: 5, complained: 2, enough: false });
    await expect(svc.transportHealth(pool, {})).rejects.toThrow(/exactly one/);

    // 5/207 is under 5 %: a hard bounce on campaign 7 → 6/208, still under — no alert
    await svc.ingest(pool, ev('bounce-permanent', { to: 'p1@example.com', resultId: '42', id: 'r1' }));
    expect(alert.mock.calls.filter((c) => c[1].kind === 'mail_bounce_rate')).toHaveLength(0);
    // push it over: 10 more hard bounces in the window
    const more = Array.from({ length: 10 }, (_, i) => [8, 6000 + i, 'sent', 'bounced_hard', null, recent, null]);
    await q('INSERT INTO campaign_results (campaign_id, contact_id, status, delivery_status, delivered_at, bounced_at, complained_at) VALUES ?', [more]);
    await svc.ingest(pool, ev('bounce-permanent', { to: 'p2@example.com', resultId: '41', id: 'r2' }));
    const rate = alert.mock.calls.filter((c) => c[1].kind === 'mail_bounce_rate');
    expect(rate).toHaveLength(1);
    expect(rate[0][1]).toMatchObject({ severity: 'error', dedup_key: `mail_bounce_rate:17:${new Date().toISOString().slice(0, 10)}` });
  });

  test('a database failure on one event: the others are applied, then the ingest throws (the hook retries it once — safe)', async () => {
    let failed = false;
    const flaky = {                                   // the first transaction's first query fails, as a dropped lock wait would
      getConnection: async () => {
        const conn = await pool.getConnection();
        if (failed) return conn;
        failed = true;
        return new Proxy(conn, { get: (t, k) => (k === 'query'
          ? async () => { throw Object.assign(new Error('Lock wait timeout exceeded'), { code: 'ER_LOCK_WAIT_TIMEOUT' }); }
          : (typeof t[k] === 'function' ? t[k].bind(t) : t[k])) });
      },
      query: (...a) => pool.query(...a),
    };
    const body = ev('bounce-multi');
    await expect(svc.ingest(flaky, body)).rejects.toThrow(/mail_event_ingest: Lock wait timeout exceeded \(other events were applied; a retry is safe\)/);
    expect((await events()).map((e) => e.destination)).toEqual(['b@example.com']);
    const retry = await svc.ingest(pool, body);
    expect(retry.ledger).toEqual({ recorded: 1, duplicate: 1 });
    expect((await events()).map((e) => e.destination).sort()).toEqual(['a@example.com', 'b@example.com']);
  });

  test('a result_id tag WITHOUT a campaign_id tag does not correlate by result_id — it falls to the message id', async () => {
    await svc.ingest(pool, ev('delivery', { to: 'x@example.com', campaignId: null, messageId: 'msg-forty-three' }));
    expect((await row(41)).delivery_status).toBe('unknown');
    expect((await row(43)).delivery_status).toBe('delivered');
  });

  test('a hard bounce after a soft one stamps bounced_at with the hard bounce\'s time, and its subtype', async () => {
    const soft = ev('bounce-transient', { to: 'x@example.com', id: 'h1' });
    await svc.ingest(pool, soft);
    expect((await row(41)).bounce_subtype).toBe('General');
    const hard = ev('bounce-permanent', { to: 'x@example.com', id: 'h2' });
    hard.detail.bounce.timestamp = '2026-11-02T16:00:00.000Z';
    await svc.ingest(pool, hard);
    const r = await row(41);
    expect(r).toMatchObject({ delivery_status: 'bounced_hard', bounce_subtype: 'General' });
    expect(r.bounced_at.toISOString()).toBe('2026-11-02T16:00:00.000Z');
  });

  test('suppression-list hard bounces: still bounced_hard + an opt-out, but left out of the bounce rate (counted as suppressed)', async () => {
    const out = await svc.ingest(pool, ev('bounce-suppressed', { to: 'sup@example.com' }));     // the captured suppression bounce
    expect(out.ledger.recorded).toBe(1);
    const r = await row(41);
    expect(r).toMatchObject({ delivery_status: 'bounced_hard', bounce_subtype: 'EmailValidationSuppressed' });
    await q('UPDATE campaign_results SET bounced_at = UTC_TIMESTAMP(3) WHERE result_id = 41');
    const recent = new Date(Date.now() - 3600e3);
    const rows = [];
    for (let i = 0; i < 3; i++) rows.push([7, 7000 + i, 'sent', 'bounced_hard', null, recent, null, 'EmailValidationSuppressed']);
    rows.push([7, 7100, 'sent', 'bounced_hard', null, recent, null, 'General']);
    rows.push([7, 7200, 'sent', 'delivered', recent, null, null, null]);
    await q('INSERT INTO campaign_results (campaign_id, contact_id, status, delivery_status, delivered_at, bounced_at, complained_at, bounce_subtype) VALUES ?', [rows]);
    const h = await svc.transportHealth(pool, { campaignId: 7 });
    expect(h).toMatchObject({ bounced_hard: 1, suppressed: 4, delivered: 1, bounce_rate: 0.5 });
  });

  test('a not-spam feedback report is a retraction: ignored — no opt-out, no alert, no status change', async () => {
    const b = ev('complaint', { to: 'complaint@example.com' });
    b.detail.complaint.complaintFeedbackType = 'not-spam';
    const out = await svc.ingest(pool, b);
    expect(out).toMatchObject({ parsed: 0, ignored: 1, alerts: 0 });
    expect(await events()).toEqual([]);
    expect(alert).not.toHaveBeenCalled();
    expect((await row(41)).delivery_status).toBe('unknown');
  });

  test('an address the ledger cannot hold: the delivery columns still commit, no ledger event, counted invalid', async () => {
    const out = await svc.ingest(pool, ev('bounce-permanent', { to: 'not-an-address' }));
    expect(out).toMatchObject({ updated: 1, invalid: 1, ledger: { recorded: 0, duplicate: 0 } });
    expect((await row(41)).delivery_status).toBe('bounced_hard');
    expect(await events()).toEqual([]);
  });

  test('alerts are counted only when raised: a complaint whose alert already exists today is neither sent again nor counted', async () => {
    await q("INSERT INTO system_alerts (source, kind, group_key, severity, title, dedup_key) VALUES ('mail', 'mail_complaint', 'mail_complaint', 'warning', 't', ?)",
      [`mail_complaint:complaint@example.com:${new Date().toISOString().slice(0, 10)}`]);
    const out = await svc.ingest(pool, ev('complaint', { to: 'complaint@example.com' }));
    expect(out.alerts).toBe(0);
    expect(alert).not.toHaveBeenCalled();
    expect(out.ledger.recorded).toBe(1);
  });

  test('the six captured step-0 events, as they arrived: a non-campaign send (tags t2 / t2-n) — opt-outs for the hard, suppressed and complained addresses only', async () => {
    const totals = { parsed: 0, ignored: 0, unknown: 0, recorded: 0, alerts: 0 };
    for (const n of ['send', 'delivery', 'bounce-permanent', 'complaint', 'bounce-transient', 'bounce-suppressed']) {
      const o = await svc.ingest(pool, load(n));
      totals.parsed += o.parsed; totals.ignored += o.ignored; totals.unknown += o.unknown; totals.recorded += o.ledger.recorded; totals.alerts += o.alerts;
      expect(o.updated).toBe(0);
    }
    expect(totals).toEqual({ parsed: 5, ignored: 1, unknown: 5, recorded: 3, alerts: 1 });
    expect((await events()).map((e) => [e.destination, e.source]).sort()).toEqual([
      ['bounce@simulator.amazonses.com', 'provider_bounce'],
      ['complaint@simulator.amazonses.com', 'provider_complaint'],
      ['suppressionlist@simulator.amazonses.com', 'provider_bounce'],
    ]);
  });

  test('the internal function hands the hook body to the ingest; a malformed body is counted, not thrown', async () => {
    const r = await fns.mail_event_ingest({ event: ev('delivery', { to: 'x@example.com' }) }, pool);
    expect(r).toMatchObject({ success: true, output: { parsed: 1, updated: 1 } });
    const bad = await fns.mail_event_ingest({ event: { source: 'aws.ses' } }, pool);
    expect(bad.output).toMatchObject({ parsed: 0, parse_errors: 1, updated: 0 });
  });

  // ── C6 engagement (SES Open / Click): its own axis ────────────────────────

  test('an open sets opened_at once — delivery columns, ledger and alerts untouched; a later open never moves it', async () => {
    const out = await svc.ingest(pool, ev('open', { to: 'x@example.com' }));
    expect(out).toMatchObject({ parsed: 1, opens: 1, clicks: 0, updated: 0, unknown: 0, ledger: { recorded: 0, duplicate: 0 } });
    const r = await row(41);
    expect(r.opened_at).toBeInstanceOf(Date);
    expect(r.opened_at.toISOString()).toBe('2026-11-05T18:30:25.538Z');
    expect(r.clicked_at).toBeNull();
    expect(r.delivery_status).toBe('unknown');
    expect(r.delivered_at).toBeNull();
    expect(await events()).toHaveLength(0);
    expect(alert).not.toHaveBeenCalled();
    const later = ev('open', { to: 'x@example.com', id: 'open-2' });
    later.detail.open.timestamp = '2026-11-05T20:00:00.000Z';
    await svc.ingest(pool, later);
    expect((await row(41)).opened_at.toISOString()).toBe('2026-11-05T18:30:25.538Z');   // set once
  });

  test('a click sets clicked_at AND opened_at (a click proves an open) and writes ONE campaign_clicks row; a hook retry of the same event adds nothing', async () => {
    const body = ev('click', { to: 'x@example.com' });
    const out = await svc.ingest(pool, body);
    expect(out).toMatchObject({ clicks: 1, opens: 0, updated: 0, unknown: 0 });
    const r = await row(41);
    expect(r.clicked_at.toISOString()).toBe('2026-11-05T18:30:29.347Z');
    expect(r.opened_at.toISOString()).toBe('2026-11-05T18:30:29.347Z');
    expect(r.delivery_status).toBe('unknown');
    const clicks = await q('SELECT campaign_id, result_id, link, provider_event_id FROM campaign_clicks');
    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toMatchObject({
      campaign_id: 7, result_id: 41,
      link: 'https://4lsg.com/b/your-booking-slug?c=00000000000000000000000000000000',
      provider_event_id: `${body.id}:x@example.com`,
    });
    await svc.ingest(pool, body);                                     // the drain re-ran the event
    expect(await q('SELECT COUNT(*) AS n FROM campaign_clicks')).toEqual([{ n: 1 }]);
  });

  test('an open then a click: opened_at keeps the open\'s earlier time; a second click on another link adds its own row, clicked_at stays first-click', async () => {
    await svc.ingest(pool, ev('open', { to: 'x@example.com' }));
    await svc.ingest(pool, ev('click', { to: 'x@example.com' }));
    let r = await row(41);
    expect(r.opened_at.toISOString()).toBe('2026-11-05T18:30:25.538Z');
    expect(r.clicked_at.toISOString()).toBe('2026-11-05T18:30:29.347Z');
    const second = ev('click', { to: 'x@example.com', id: 'click-2' });
    second.detail.click.link = 'https://www.4lsg.com/contact';
    second.detail.click.timestamp = '2026-11-05T19:00:00.000Z';
    await svc.ingest(pool, second);
    r = await row(41);
    expect(r.clicked_at.toISOString()).toBe('2026-11-05T18:30:29.347Z');
    const links = await q('SELECT link, COUNT(*) AS n FROM campaign_clicks GROUP BY link ORDER BY link');
    expect(links).toEqual([
      { link: 'https://4lsg.com/b/your-booking-slug?c=00000000000000000000000000000000', n: 1 },
      { link: 'https://www.4lsg.com/contact', n: 1 },
    ]);
  });

  test('an uncorrelated click (foreign tags, unknown message id — a C7 triggered send) stores nothing', async () => {
    const out = await svc.ingest(pool, ev('click', { to: 'x@example.com', resultId: '999', campaignId: '77', messageId: 'no-such' }));
    expect(out).toMatchObject({ clicks: 0, opens: 0, unknown: 1, updated: 0 });
    expect(await q('SELECT COUNT(*) AS n FROM campaign_clicks')).toEqual([{ n: 0 }]);
    expect((await row(41)).opened_at).toBeNull();
  });

  test('engagement never raises delivery_status and a delivery event never clears engagement', async () => {
    await svc.ingest(pool, ev('click', { to: 'x@example.com' }));
    await svc.ingest(pool, ev('delivery', { to: 'x@example.com', id: 'del-after' }));
    const r = await row(41);
    expect(r.delivery_status).toBe('delivered');
    expect(r.clicked_at.toISOString()).toBe('2026-11-05T18:30:29.347Z');
  });

  test('engagement NEVER runs the transport-health sweep: over-threshold seeds + one open → no alert; the control delivery → the bounce-rate alert fires', async () => {
    // Seed campaign 7's transport over the §6.5 line: 200 delivered + 20 hard
    // bounces inside the window. If engagement joined the per-campaign sweep
    // (the reviewer's surviving mutation M2), the OPEN alone would alert.
    const values = [];
    for (let i = 0; i < 220; i++) {
      const rid = 1000 + i;
      values.push(i < 200
        ? `(${rid}, 7, ${rid}, 'sent', 'delivered', UTC_TIMESTAMP(3))`   // distinct contacts: uq_campaign_contact
        : `(${rid}, 7, ${rid}, 'sent', 'bounced_hard', NULL)`);
    }
    await q(`INSERT INTO campaign_results (result_id, campaign_id, contact_id, status, delivery_status, delivered_at) VALUES ${values.join(',')}`);
    await q(`UPDATE campaign_results SET bounced_at = UTC_TIMESTAMP(3) WHERE delivery_status = 'bounced_hard' AND result_id >= 1200`);

    const o = await svc.ingest(pool, ev('open', { to: 'x@example.com' }));
    expect(o).toMatchObject({ opens: 1, alerts: 0 });
    expect(alert).not.toHaveBeenCalled();

    const d = await svc.ingest(pool, ev('delivery', { to: 'x@example.com', id: 'ctl-delivery' }));
    expect(d.alerts).toBe(1);
    expect(alert).toHaveBeenCalledWith(pool, expect.objectContaining({ kind: 'mail_bounce_rate', severity: 'error' }));
  });

  test('the C6 migration resumes from a half state and NO-GOes on a misshapen column (review N1)', async () => {
    await q('ALTER TABLE campaign_results DROP COLUMN clicked_at');
    const conn = await pool.getConnection();
    try {
      let r = await migrateC6.run(conn, { say: () => {} });            // CHECK, read-only
      expect(r).toMatchObject({ ok: true, applied: [] });
      r = await migrateC6.run(conn, { apply: true, say: () => {} });   // resumes: exactly the missing ALTER
      expect(r.ok).toBe(true);
      expect(r.applied).toEqual(['campaign_results.clicked_at']);
      await q("ALTER TABLE campaign_results MODIFY opened_at datetime NULL COMMENT 'wrong'");
      r = await migrateC6.run(conn, { apply: true, say: () => {} });   // misshapen → NO-GO, nothing changed
      expect(r.ok).toBe(false);
      expect(r.applied).toEqual([]);
    } finally { conn.release(); }                                      // reset() rebuilds before the next test
  });

  test('getCampaign (marketing email): delivery block counts opened/clicked; links aggregates clicks and distinct clickers', async () => {
    await q("UPDATE campaigns SET class = 'marketing', type = 'email' WHERE campaign_id = 7");
    await svc.ingest(pool, ev('open', { to: 'o@example.com', resultId: '42' }));
    await svc.ingest(pool, ev('click', { to: 'x@example.com' }));
    const second = ev('click', { to: 'x@example.com', id: 'click-2' });
    second.detail.click.timestamp = '2026-11-05T19:00:00.000Z';
    await svc.ingest(pool, second);                                   // same link, same clicker, new event
    const { getCampaign } = require('../services/campaignService');   // lazy require (convention)
    const c = await getCampaign(pool, 7);
    expect(c.delivery).toMatchObject({ opened: 2, clicked: 1 });
    expect(c.links).toEqual([
      { link: 'https://4lsg.com/b/your-booking-slug?c=00000000000000000000000000000000', clicks: 2, clickers: 1 },
    ]);
  });
});
