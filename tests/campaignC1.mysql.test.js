/**
 * YisraMail C1 — campaign hardening on REAL MySQL (ref/YISRAMAIL_DESIGN.md §6.1, §6.4).
 *
 *   R  the send reservation (at most once): a crash between reserve and send → the retry
 *      records 'unknown' with NO provider call; a crash after the provider call → 'unknown',
 *      still one call; a definite 4xx → reservation cleared, retried and resent; a permanent
 *      5xx → 'failed'; an ambiguous timeout → 'unknown', never retried; a terminal row is never
 *      touched by a replay; provider_message_id lands on the row
 *   K  checkCompletion: a 'sending' row is not done (no premature finalize); 'unknown' is, and
 *      counts like failed; result_summary carries it
 *   W  the per-transport rate window (real DATETIMEs against NOW()); the over-cap bulk send
 *      goes through sendEmailDirect with bulk:true and nothing else
 *   C  createCampaign: the cap counts DEDUPED ids; over it → 403 without campaigns.bulk, 409
 *      naming the real count, then created paced + pump + audited; the T1 fence within the cap
 *   O  D18: an OPERATIONAL email reaches a marketing opt-out; a marketing campaign is skipped
 *      marketing_disabled while the switch is not exactly '1' and never sent (switched on, the
 *      C2 send path — tests/campaignC2.mysql.test.js)
 *   M  marketing create refused while the switch is not exactly '1'; topic validation
 *   D  a deferral (paused) leaves attempts / execution_count untouched, no job_results row
 *   Q  the cron batch claims at most CAMPAIGN_SEND_QUOTA campaign_send rows, other jobs first
 *   P  pause defers, the pump stops; resume re-inserts the pump and re-rings, bounded by the
 *      rate; an older pump retires; cancel deletes the pump row
 *
 * NOTHING CAN SEND: emailService.sendEmail / sendEmailDirect and phoneService.sendSms are
 * spied; below them nodemailer and fetch refuse and afterAll asserts neither was reached.
 * lib/taskQueue.enqueueJobDispatch is a recorder.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3321/yc_c1_test npx jest tests/campaignC1.mysql.test.js --runInBand
 * Its OWN *_test DB family: it drops and rebuilds every table it touches (cloned from
 * ref/database.sql, the consent tables from the P1 migration, then the C1 and C2 migration
 * scripts — idempotent, so the twin is independent of whether the dump carries them yet).
 */
'use strict';

const escaped = { fetch: [], smtp: [] };
jest.mock('nodemailer', () => {
  const actual = jest.requireActual('nodemailer');
  return { ...actual, createTransport: jest.fn(() => { escaped.smtp.push('createTransport'); throw new Error('test: SMTP is unreachable'); }) };
});
jest.mock('../lib/taskQueue', () => {
  const actual = jest.requireActual('../lib/taskQueue');
  return { ...actual, enqueueJobDispatch: jest.fn(async () => true) };
});
const realFetch = global.fetch;
global.fetch = async (url) => { escaped.fetch.push(String(url)); throw new Error('test: network is unreachable'); };

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

const TABLES = ['campaigns', 'campaign_contacts', 'campaign_results', 'scheduled_jobs', 'job_results',
  'contacts', 'contact_phones', 'contact_emails', 'app_settings', 'email_credentials', 'admin_audit_log',
  'users', 'workflow_executions', 'domain_event_queue', 'hook_executions', 'hooks'];

d('C1 campaign hardening on real MySQL', () => {
  const mysql = require('mysql2/promise');
  const schema = require('./helpers/commsArchiveSchema');
  const { buildConsentTables } = require('./helpers/consentSchema');
  const { withTransaction } = require('../lib/withTransaction');
  const c1Migrate = require('../scripts/yisramailC1Migrate');
  const c2Migrate = require('../scripts/yisramailC2Migrate');
  const c3Migrate = require('../scripts/yisramailC3Migrate');
  const campaignService = require('../services/campaignService');
  const emailService = require('../services/emailService');
  const phoneService = require('../services/phoneService');
  const taskQueue = require('../lib/taskQueue');
  const processJobs = require('../routes/process_jobs');

  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const ADMIN = { type: 'jwt', roles: ['admin'], userId: 6, username: 'fred' };
  const STAFF = { type: 'jwt', roles: ['staff'], userId: 9, username: 'sam' };
  let sendEmail, sendDirect;

  async function setSettings(map) {
    await q("DELETE FROM app_settings WHERE `key` IN ('marketing_send_enabled', 'campaign_operational_cap', 'campaign_marketing_rate')");
    for (const [k, v] of Object.entries(map)) await q('INSERT INTO app_settings (`key`, `value`) VALUES (?, ?)', [k, v]);
  }
  async function seedCampaign({ id, type = 'email', klass = 'operational', status = 'sending', sender = 'ops@firm.test', contacts = [2], over = null, topic = null }) {
    await q(`INSERT INTO campaigns (campaign_id, type, class, topic_key, bulk_confirmed_count, sender, subject, body, status, contact_count, created_by)
             VALUES (?, ?, ?, ?, ?, ?, 'S', '<p>Hi</p>', ?, ?, 6)`, [id, type, klass, topic, over, sender, status, contacts.length]);
    if (contacts.length) await q('INSERT INTO campaign_contacts (campaign_id, contact_id) VALUES ?', [contacts.map((c) => [id, c])]);
  }
  async function sendJob(campaignId, contactId, { due = 'NOW()', attempts = 0 } = {}) {
    const [r] = await pool.query(
      `INSERT INTO scheduled_jobs (type, scheduled_time, status, name, data, max_attempts, backoff_seconds, idempotency_key, attempts, execution_count)
       VALUES ('one_time', ${due}, 'pending', ?, ?, 3, 60, ?, ?, 0)`,
      [`campaign:${campaignId}:send:${contactId}`, JSON.stringify({ type: 'campaign_send', campaign_id: campaignId, contact_id: contactId }), `campaign:${campaignId}:${contactId}`, attempts]);
    return r.insertId;
  }
  const row = async (cid, ctid) => (await q('SELECT * FROM campaign_results WHERE campaign_id = ? AND contact_id = ?', [cid, ctid]))[0];
  const camp = async (cid) => (await q('SELECT status, result_summary, class, topic_key, bulk_confirmed_count FROM campaigns WHERE campaign_id = ?', [cid]))[0];
  /** A pool whose query throws a transient error ONCE, on the first statement matching re. */
  function failingOnce(re) {
    let thrown = false;
    return {
      withTransaction: pool.withTransaction,
      query: async (sql, p) => {
        if (!thrown && re.test(sql.replace(/\s+/g, ' '))) { thrown = true; throw Object.assign(new Error('Connection lost: The server closed the connection.'), { code: 'PROTOCOL_CONNECTION_LOST' }); }
        return pool.query(sql, p);
      },
    };
  }

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    if (new URL(URL_).port === '3306') throw new Error('refusing to run against the production proxy port');
    pool = mysql.createPool({ uri: URL_, connectionLimit: 6, timezone: 'Z' });
    pool.on('connection', (c) => c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    pool.withTransaction = (fn, opts) => withTransaction(pool, fn, opts);
    await schema.build(pool, TABLES);
    await buildConsentTables(q);
    const c = await pool.getConnection();
    try {
      expect((await c1Migrate.run(c, { apply: true, say: () => {} })).ok).toBe(true);
      // C2's columns too (campaignService reads send_snapshot / held_at) — idempotent, like C1's.
      expect((await c2Migrate.run(c, { apply: true, say: () => {} })).ok).toBe(true);
      // C3's campaigns.design_id (createCampaign INSERTs it) + email_designs — idempotent.
      expect((await c3Migrate.run(c, { apply: true, say: () => {} })).ok).toBe(true);
    } finally { c.release(); }
    await q('SET FOREIGN_KEY_CHECKS = 1');
    await q(`INSERT INTO contacts (contact_id, contact_name, contact_fname, contact_lname, contact_phone, contact_email) VALUES
      (1, 'Pat One', 'Pat', 'One', '3135550001', 'pat@example.com'),
      (2, 'Sam Two', 'Sam', 'Two', '3135550002', 'sam@example.com'),
      (3, 'Ann Three', 'Ann', 'Three', '3135550003', 'ann@example.com'),
      (4, 'Bo Four', 'Bo', 'Four', '3135550004', 'bo@example.com'),
      (5, 'Cy Five', 'Cy', 'Five', '3135550005', 'cy@example.com')`);
    await q(`INSERT INTO contact_emails (id, contact_id, email, label, is_primary, email_optout, end_date) VALUES
      (21, 1, 'pat@example.com', 'Personal', 1, 1, NULL), (22, 2, 'sam@example.com', 'Personal', 1, 0, NULL)`);
    // Pat opted out of MARKETING email (the state, with the row cache agreeing)
    await q(`INSERT INTO comm_consent_events (id, channel, destination, scope, action, source, occurred_at) VALUES (1, 'email', 'pat@example.com', 'marketing', 'opt_out', 'unsub_page', NOW())`);
    await q(`INSERT INTO comm_consent_state (channel, destination, scope, state, occurred_at, last_event_id) VALUES ('email', 'pat@example.com', 'marketing', 'opted_out', NOW(), 1)`);
    await q(`INSERT INTO email_credentials (id, email, smtp_host, smtp_port, smtp_user, smtp_pass, provider, from_name, bulk_ok, events_driver) VALUES
      (4, 'ops@firm.test', 'mail.firm.test', 587, 'ops@firm.test', 'x', 'smtp', 'Ops', 0, NULL),
      (17, 'news@news.test', 'email-smtp.test', 587, 'AKIA', 'x', 'smtp', 'News', 1, 'ses')`);
    await q("INSERT INTO comm_topics (topic_key, channel, label, consent_model, active) VALUES ('sms_promo', 'sms', 'SMS promo', 'opt_in', 1), ('old_news', 'email', 'Old', 'opt_out', 0) ON DUPLICATE KEY UPDATE label = VALUES(label)");
  });

  beforeEach(async () => {
    for (const t of ['campaigns', 'campaign_contacts', 'campaign_results', 'scheduled_jobs', 'job_results', 'admin_audit_log']) await q(`DELETE FROM ${t}`);
    await setSettings({});
    taskQueue.enqueueJobDispatch.mockClear();
    sendEmail = jest.spyOn(emailService, 'sendEmail').mockImplementation(async (db, o) => ({ messageId: `<m-${o.to}>`, provider: 'smtp' }));
    sendDirect = jest.spyOn(emailService, 'sendEmailDirect').mockImplementation(async (db, r, o) => ({ messageId: `<d-${o.to}>`, providerMessageId: `ses-${o.to}` }));
    jest.spyOn(phoneService, 'sendSms').mockImplementation(async () => ({ id: 'p1' }));
    for (const m of ['log', 'warn', 'error']) jest.spyOn(console, m).mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    global.fetch = realFetch;
    if (pool) await pool.end();
    expect(escaped).toEqual({ fetch: [], smtp: [] });
  });

  // ───────────────────────────────────────────────────────────────────────
  describe('R: the send reservation', () => {
    test('crash between reserve and send → the retry records unknown, and the provider is NEVER called', async () => {
      await seedCampaign({ id: 10, status: 'scheduled', contacts: [2] });
      const dying = failingOnce(/^UPDATE campaigns SET status = 'sending'/);
      await expect(campaignService.executeSend(dying, 10, 2, { attempt: 1, maxAttempts: 3, jobId: 501 })).rejects.toMatchObject({ code: 'PROTOCOL_CONNECTION_LOST' });
      const r1 = await row(10, 2);
      expect([r1.status, r1.result_meta]).toEqual(['sending', { attempt_id: '501:1' }]);
      expect(await campaignService.executeSend(pool, 10, 2, { attempt: 2, maxAttempts: 3, jobId: 501 })).toEqual({ unknown: true, reason: 'reservation_unfinished' });
      const r2 = await row(10, 2);
      expect(r2.status).toBe('unknown');
      expect(r2.result_meta).toMatchObject({ attempt_id: '501:1', unknown_note: expect.stringContaining('501:2') });
      expect(sendEmail).not.toHaveBeenCalled();
      expect(await camp(10)).toMatchObject({ status: 'failed', result_summary: { sent: 0, failed: 0, skipped: 0, unknown: 1 } });
    });

    test('crash AFTER the provider call (the sent update dies) → unknown on retry, exactly one provider call', async () => {
      await seedCampaign({ id: 11, contacts: [2] });
      const dying = failingOnce(/^UPDATE campaign_results SET status = 'sent'/);
      await expect(campaignService.executeSend(dying, 11, 2, { attempt: 1, maxAttempts: 3, jobId: 502 })).rejects.toBeTruthy();
      expect((await row(11, 2)).status).toBe('sending');
      expect(await campaignService.executeSend(pool, 11, 2, { attempt: 2, maxAttempts: 3, jobId: 502 })).toMatchObject({ unknown: true });
      expect(sendEmail).toHaveBeenCalledTimes(1);
      expect((await row(11, 2)).status).toBe('unknown');
    });

    test('the sent update dies on the FINAL attempt (or with a permanent error) → unknown, the campaign finalizes; one provider call', async () => {
      await seedCampaign({ id: 16, contacts: [2] });
      const dying = failingOnce(/^UPDATE campaign_results SET status = 'sent'/);
      expect(await campaignService.executeSend(dying, 16, 2, { attempt: 3, maxAttempts: 3, jobId: 506 })).toMatchObject({ unknown: true, reason: 'reservation_unresolved' });
      expect(await row(16, 2)).toMatchObject({ status: 'unknown', result_meta: { attempt_id: '506:3' } });
      expect(sendEmail).toHaveBeenCalledTimes(1);
      expect(await camp(16)).toMatchObject({ status: 'failed', result_summary: { sent: 0, failed: 0, skipped: 0, unknown: 1 } });
      // permanent (non-transient) error at attempt 1 of 3: same outcome
      await seedCampaign({ id: 17, contacts: [2] });
      const odd = { withTransaction: pool.withTransaction, query: async (sql, p) => { if (/^UPDATE campaign_results SET status = 'sent'/.test(sql.replace(/\s+/g, ' ').trim())) throw new Error('weird driver state'); return pool.query(sql, p); } };
      expect(await campaignService.executeSend(odd, 17, 2, { attempt: 1, maxAttempts: 3, jobId: 507 })).toMatchObject({ unknown: true });
      expect((await row(17, 2)).status).toBe('unknown');
      expect((await camp(17)).status).toBe('failed');
    });

    test('a definite 4xx → the reservation is cleared, the job retries and RESENDS → sent (provider_message_id stored)', async () => {
      await seedCampaign({ id: 12, contacts: [2] });
      sendEmail.mockRejectedValueOnce(Object.assign(new Error('421 4.7.0 try again later'), { responseCode: 421, code: 'EENVELOPE' }))
        .mockResolvedValueOnce({ messageId: '<ok>', provider: 'smtp', providerMessageId: 'pm-12' });
      await expect(campaignService.executeSend(pool, 12, 2, { attempt: 1, maxAttempts: 3, jobId: 503 })).rejects.toMatchObject({ responseCode: 421 });
      expect(await row(12, 2)).toBeUndefined();
      expect(await campaignService.executeSend(pool, 12, 2, { attempt: 2, maxAttempts: 3, jobId: 503 })).toEqual({ sent: true, messageId: '<ok>' });
      const r = await row(12, 2);
      expect([r.status, r.provider_message_id, r.result_meta]).toEqual(['sent', 'pm-12', { attempt_id: '503:2', messageId: '<ok>', provider: 'smtp' }]);
      expect(sendEmail).toHaveBeenCalledTimes(2);
      expect((await camp(12)).status).toBe('sent');
    });

    test('a permanent 5xx → failed (one call, no retry)', async () => {
      await seedCampaign({ id: 13, contacts: [2] });
      sendEmail.mockRejectedValueOnce(Object.assign(new Error('550 5.1.1 no such user'), { responseCode: 550, code: 'EENVELOPE' }));
      expect(await campaignService.executeSend(pool, 13, 2, { attempt: 1, maxAttempts: 3, jobId: 504 })).toMatchObject({ failed: true });
      expect((await row(13, 2)).status).toBe('failed');
      expect(sendEmail).toHaveBeenCalledTimes(1);
    });

    test('an ambiguous timeout → unknown, returned (never thrown for a retry); a later replay sends nothing', async () => {
      await seedCampaign({ id: 14, contacts: [2] });
      sendEmail.mockRejectedValueOnce(Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' }));
      expect(await campaignService.executeSend(pool, 14, 2, { attempt: 1, maxAttempts: 3, jobId: 505 })).toEqual({ unknown: true, reason: 'provider_ambiguous' });
      const r = await row(14, 2);
      expect([r.status, r.error]).toEqual(['unknown', 'Timeout']);
      expect(await campaignService.executeSend(pool, 14, 2, { attempt: 2, maxAttempts: 3, jobId: 505 })).toEqual({ replay: true, status: 'unknown' });
      expect(sendEmail).toHaveBeenCalledTimes(1);
    });

    test('a replay on a TERMINAL row (sent / failed / skipped / unknown) touches nothing and sends nothing', async () => {
      await seedCampaign({ id: 15, contacts: [1, 2, 3, 4] });
      const statuses = { 1: 'sent', 2: 'failed', 3: 'skipped', 4: 'unknown' };
      for (const [c, s] of Object.entries(statuses)) {
        await q("INSERT INTO campaign_results (campaign_id, contact_id, status, error, result_meta, sent_at) VALUES (15, ?, ?, 'e', '{\"attempt_id\":\"9:1\"}', '2026-01-02 03:04:05')", [c, s]);
      }
      const before = await q('SELECT * FROM campaign_results WHERE campaign_id = 15 ORDER BY contact_id');
      for (const c of [1, 2, 3, 4]) {
        expect(await campaignService.executeSend(pool, 15, c, { attempt: 1, maxAttempts: 3, jobId: 600 + c })).toEqual({ replay: true, status: statuses[c] });
      }
      expect(await q('SELECT * FROM campaign_results WHERE campaign_id = 15 ORDER BY contact_id')).toEqual(before);
      expect(sendEmail).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  describe('K: checkCompletion', () => {
    test('a sending row is NOT done (no premature finalize); unknown IS done and counts like failed', async () => {
      await seedCampaign({ id: 20, contacts: [1, 2] });
      await q("INSERT INTO campaign_results (campaign_id, contact_id, status, result_meta) VALUES (20, 1, 'sending', '{\"attempt_id\":\"77:1\"}')");
      expect(await campaignService.executeSend(pool, 20, 2, { attempt: 1, maxAttempts: 3, jobId: 78 })).toMatchObject({ sent: true });
      expect((await camp(20)).status).toBe('sending');
      expect(await campaignService.getCampaign(pool, 20)).toMatchObject({ results: { sent: 1, sending: 1, unknown: 0, pending: 0 } });
      expect(await campaignService.executeSend(pool, 20, 1, { attempt: 2, maxAttempts: 3, jobId: 77 })).toMatchObject({ unknown: true });
      expect(await camp(20)).toMatchObject({ status: 'partial_fail', result_summary: { sent: 1, failed: 0, skipped: 0, unknown: 1 } });
      const list = await campaignService.listCampaigns(pool, {});
      expect(list.campaigns.find((c) => c.campaign_id === 20)).toMatchObject({ sent_count: '1', unknown_count: '1', sending_count: '0', class: 'operational' });
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  describe('W: the per-transport rate window + the over-cap bulk send (D16)', () => {
    test('≥ rate sends (sending or sent) on the transport in the last 60 s → defer, no reservation; older ones do not count', async () => {
      await setSettings({ campaign_marketing_rate: '2' });
      await seedCampaign({ id: 30, sender: 'news@news.test', contacts: [1, 2, 3], over: 3 });
      await seedCampaign({ id: 31, sender: 'news@news.test', contacts: [4, 5], over: 2 });
      await q("INSERT INTO campaign_results (campaign_id, contact_id, status, sent_at) VALUES (31, 4, 'sent', NOW()), (31, 5, 'sending', NOW() - INTERVAL 30 SECOND)");
      const out = await campaignService.executeSend(pool, 30, 2, { attempt: 1, maxAttempts: 3, jobId: 801 });
      expect(out).toMatchObject({ deferred: true, reason: 'rate_window' });
      expect(out.retryAtMs - Date.now()).toBeGreaterThanOrEqual(1500);
      expect(out.retryAtMs - Date.now()).toBeLessThanOrEqual(8500);
      expect(await row(30, 2)).toBeUndefined();
      await q('UPDATE campaign_results SET sent_at = NOW() - INTERVAL 61 SECOND WHERE campaign_id = 31 AND contact_id = 5');
      expect(await campaignService.executeSend(pool, 30, 2, { attempt: 1, maxAttempts: 3, jobId: 801 })).toMatchObject({ sent: true });
      // the bulk path: sendEmailDirect on the bulk row, bulk:true, and NOTHING marketing (no footer path exists here)
      expect(sendEmail).not.toHaveBeenCalled();
      expect(sendDirect).toHaveBeenCalledTimes(1);
      const [, emailRow, opts] = sendDirect.mock.calls[0];
      expect(emailRow).toMatchObject({ id: 17, bulk_ok: 1 });
      expect(opts).toMatchObject({ from: 'news@news.test', to: 'sam@example.com', bulk: true });
      for (const k of ['headers', 'reply_to']) expect(opts).not.toHaveProperty(k);
      const r30 = await row(30, 2);
      expect(opts.tags).toEqual({ campaign_id: '30', result_id: String(r30.result_id) });   // T2 correlation before the sent update lands
      expect(r30.provider_message_id).toBe('ses-sam@example.com');
    });

    test('a within-cap campaign whose sender row turned bulk later goes through the public sendEmail (which refuses it)', async () => {
      await seedCampaign({ id: 32, sender: 'news@news.test', contacts: [2] });
      sendEmail.mockRestore();
      expect(await campaignService.executeSend(pool, 32, 2, { attempt: 1, maxAttempts: 3, jobId: 802 })).toMatchObject({ failed: true, reason: expect.stringContaining('bulk_sender_refused') });
      expect(sendDirect).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  describe('C: createCampaign — the cap, the over-cap path, the T1 fence', () => {
    const base = { type: 'email', subject: 'Office closed', body: '<p>Closed Friday</p>', sender: 'ops@firm.test', createdBy: 6 };
    test('the cap counts DEDUPED ids; over it: 403 without campaigns.bulk, 409 naming the real count, then created paced + pump + audited', async () => {
      await setSettings({ campaign_operational_cap: '3', campaign_marketing_rate: '60' });
      const ok = await campaignService.createCampaign(pool, { ...base, contactIds: [2, 2, 3, 3, 4], auth: STAFF });
      expect(ok).toMatchObject({ contactCount: 3, overCap: false, paced: false, class: 'operational' });
      expect(await camp(ok.campaignId)).toMatchObject({ class: 'operational', bulk_confirmed_count: null });
      const within = await q('SELECT name, scheduled_time FROM scheduled_jobs ORDER BY id');
      expect(within.map((j) => j.name)).toEqual([2, 3, 4].map((c) => `campaign:${ok.campaignId}:send:${c}`));
      expect(new Set(within.map((j) => j.scheduled_time.getTime())).size).toBe(1);
      expect(await q('SELECT * FROM admin_audit_log')).toEqual([]);

      const n0 = (await q('SELECT COUNT(*) n FROM campaigns'))[0].n;
      await expect(campaignService.createCampaign(pool, { ...base, contactIds: [2, 3, 4, 5, 5], auth: STAFF, confirmCount: 4 }))
        .rejects.toMatchObject({ status: 403, code: 'bulk_capability_required', extra: { count: 4, cap: 3 } });
      await expect(campaignService.createCampaign(pool, { ...base, contactIds: [2, 3, 4, 5, 5], auth: ADMIN }))
        .rejects.toMatchObject({ status: 409, code: 'over_cap_confirmation', extra: { count: 4 } });
      await expect(campaignService.createCampaign(pool, { ...base, contactIds: [2, 3, 4, 5, 5], auth: ADMIN, confirmCount: 5 }))
        .rejects.toMatchObject({ status: 409, extra: { count: 4 } });
      expect((await q('SELECT COUNT(*) n FROM campaigns'))[0].n).toBe(n0);

      const over = await campaignService.createCampaign(pool, { ...base, contactIds: [2, 3, 4, 5, 5], auth: ADMIN, confirmCount: 4, request: { route: '/api/campaigns', method: 'POST', ip: '203.0.113.9' } });
      expect(over).toMatchObject({ contactCount: 4, overCap: true, paced: true });
      expect(await camp(over.campaignId)).toMatchObject({ class: 'operational', bulk_confirmed_count: 4 });
      const jobs = await q('SELECT name, scheduled_time, status, idempotency_key, data FROM scheduled_jobs WHERE name LIKE ? ORDER BY id', [`campaign:${over.campaignId}:%`]);
      const sends = jobs.filter((j) => /:send:/.test(j.name));
      const gaps = sends.slice(1).map((j, i) => (j.scheduled_time - sends[i].scheduled_time) / 1000);
      expect(gaps.every((g) => g >= 0 && g <= 2)).toBe(true);                       // ~1 s apart at 60/min (DATETIME seconds)
      expect((sends[3].scheduled_time - sends[0].scheduled_time) / 1000).toBeGreaterThanOrEqual(2);
      const pump = jobs.filter((j) => j.name === `campaign:${over.campaignId}:pump`);
      expect(pump).toHaveLength(1);
      expect(pump[0]).toMatchObject({ status: 'pending', idempotency_key: `campaign:${over.campaignId}:pump`, data: { type: 'campaign_pump', campaign_id: over.campaignId } });
      const audit = await q('SELECT tool, user_id, username, route, method, status, ip_address, details FROM admin_audit_log');
      expect(audit).toEqual([{ tool: 'campaign_over_cap', user_id: 6, username: 'fred', route: '/api/campaigns', method: 'POST', status: 'success', ip_address: '203.0.113.9',
        details: expect.objectContaining({ campaign_id: over.campaignId, count: 4, confirmed_count: 4, cap: 3, sender: 'ops@firm.test', type: 'email', class: 'operational' }) }]);
      expect(taskQueue.enqueueJobDispatch).toHaveBeenCalledTimes(1);               // the pump's doorbell (due now)
    });

    test('the T1 fence within the cap; over the cap a bulk_ok sender is allowed (D16)', async () => {
      await setSettings({ campaign_operational_cap: '2' });
      await expect(campaignService.createCampaign(pool, { ...base, sender: 'news@news.test', contactIds: [2, 3], auth: ADMIN }))
        .rejects.toMatchObject({ status: 400, code: 'bulk_sender_refused' });
      const r = await campaignService.createCampaign(pool, { ...base, sender: 'news@news.test', contactIds: [2, 3, 4], auth: ADMIN, confirmCount: 3 });
      expect(r).toMatchObject({ overCap: true });
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  describe('O: D18 — operational email reaches a marketing opt-out; marketing never sends in C1', () => {
    test('operational email to Pat (opted out of marketing) SENDS', async () => {
      await seedCampaign({ id: 40, contacts: [1] });
      expect(await campaignService.executeSend(pool, 40, 1, { attempt: 1, maxAttempts: 3, jobId: 900 })).toMatchObject({ sent: true });
      expect(sendEmail.mock.calls[0][1]).toMatchObject({ to: 'pat@example.com' });
    });

    // Switched on (exactly '1') a marketing recipient takes the C2 send path —
    // tests/campaignC2.mysql.test.js (S); C1 pins only the switch's fail-closed reads.
    test('a marketing campaign is recorded skipped marketing_disabled unless the switch is exactly 1', async () => {
      const cases = [[{}, 'marketing_disabled'], [{ marketing_send_enabled: '0' }, 'marketing_disabled'], [{ marketing_send_enabled: ' 1' }, 'marketing_disabled'],
        [{ marketing_send_enabled: 'true' }, 'marketing_disabled'], [{ marketing_send_enabled: '' }, 'marketing_disabled']];
      let id = 41;
      for (const [settings, reason] of cases) {
        await setSettings(settings);
        await seedCampaign({ id, klass: 'marketing', topic: 'newsletter', sender: 'news@news.test', contacts: [2] });
        expect(await campaignService.executeSend(pool, id, 2, { attempt: 1, maxAttempts: 3, jobId: id })).toEqual({ skipped: true, reason });
        expect(await row(id, 2)).toMatchObject({ status: 'skipped', result_meta: { reason } });
        id++;
      }
      expect(sendEmail).not.toHaveBeenCalled();
      expect(sendDirect).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  describe('M: marketing create — the kill switch, then the rules', () => {
    const mk = { type: 'email', subject: 'News', body: '<p>Hi</p>', sender: 'news@news.test', contactIds: [2, 3], createdBy: 6, klass: 'marketing', topicKey: 'newsletter', auth: ADMIN };
    test('refused 422 while marketing_send_enabled is not exactly 1 — nothing written', async () => {
      for (const s of [{}, { marketing_send_enabled: '0' }, { marketing_send_enabled: '' }, { marketing_send_enabled: 'true' }, { marketing_send_enabled: '1 ' }]) {
        await setSettings(s);
        await expect(campaignService.createCampaign(pool, mk)).rejects.toMatchObject({ status: 422, code: 'marketing_disabled' });
      }
      expect(await q('SELECT * FROM campaigns')).toEqual([]);
    });

    test('switch on: capability, topic (exists, email, active), bulk sender — then created paced, pump, audited', async () => {
      await setSettings({ marketing_send_enabled: '1', campaign_marketing_rate: '30' });
      await expect(campaignService.createCampaign(pool, { ...mk, auth: STAFF })).rejects.toMatchObject({ status: 403 });
      for (const topicKey of ['sms_promo', 'old_news', 'nope', 'marketing', null]) {
        await expect(campaignService.createCampaign(pool, { ...mk, topicKey })).rejects.toMatchObject({ status: 400 });
      }
      await expect(campaignService.createCampaign(pool, { ...mk, sender: 'ops@firm.test' })).rejects.toMatchObject({ status: 400, code: 'marketing_requires_bulk_sender' });
      await expect(campaignService.createCampaign(pool, { ...mk, type: 'sms', sender: '2485550000' })).rejects.toMatchObject({ status: 422, code: 'marketing_sms_refused' });
      const r = await campaignService.createCampaign(pool, mk);
      expect(r).toMatchObject({ class: 'marketing', paced: true, overCap: false });
      expect(await camp(r.campaignId)).toMatchObject({ class: 'marketing', topic_key: 'newsletter', bulk_confirmed_count: null });
      const sends = await q("SELECT scheduled_time FROM scheduled_jobs WHERE name LIKE '%:send:%' ORDER BY id");
      expect((sends[1].scheduled_time - sends[0].scheduled_time) / 1000).toBeGreaterThanOrEqual(1);   // 2 s apart at 30/min
      expect(await q("SELECT COUNT(*) n FROM scheduled_jobs WHERE name LIKE '%:pump'")).toEqual([{ n: 1 }]);
      expect(await q('SELECT tool, details FROM admin_audit_log')).toEqual([{ tool: 'campaign_marketing_create', details: expect.objectContaining({ campaign_id: r.campaignId, topic_key: 'newsletter', count: 2 }) }]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  describe('D: a deferral consumes nothing', () => {
    test('a paused campaign (the backstop: a job pause did not park): back to pending ~5 min out; attempts and execution_count untouched; no job_results row', async () => {
      await seedCampaign({ id: 50, status: 'paused', contacts: [2] });
      const jobId = await sendJob(50, 2, { attempts: 1 });
      const out = await processJobs.runJobPass(pool, { jobId });
      expect(out.results).toEqual([expect.objectContaining({ id: jobId, status: 'deferred', reason: 'campaign_paused' })]);
      const [j] = await q('SELECT status, attempts, execution_count, TIMESTAMPDIFF(SECOND, NOW(), scheduled_time) AS ahead FROM scheduled_jobs WHERE id = ?', [jobId]);
      expect([j.status, j.attempts, j.execution_count]).toEqual(['pending', 1, 0]);
      expect(j.ahead).toBeGreaterThanOrEqual(295);
      expect(j.ahead).toBeLessThanOrEqual(335);
      expect(await q('SELECT * FROM job_results')).toEqual([]);
      expect(await row(50, 2)).toBeUndefined();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  describe('Q: the cron batch quota', () => {
    test(`at most ${'CAMPAIGN_SEND_QUOTA'} campaign_send rows per batch; other due jobs claim first even when later`, async () => {
      expect(processJobs.CAMPAIGN_SEND_QUOTA).toBe(5);
      await seedCampaign({ id: 60, status: 'paused', contacts: [1, 2, 3, 4, 5] });
      const sends = [];
      for (let i = 0; i < 8; i++) sends.push(await sendJob(60, (i % 5) + 1, { due: 'NOW() - INTERVAL 10 MINUTE' }));
      const others = [];
      for (let i = 0; i < 3; i++) {
        const [r] = await pool.query(`INSERT INTO scheduled_jobs (type, scheduled_time, status, name, data, max_attempts) VALUES ('one_time', NOW() - INTERVAL 1 MINUTE, 'pending', ?, '{"type":"webhook"}', 1)`, [`other ${i}`]);
        others.push(r.insertId);
      }
      const out = await processJobs.runJobPass(pool);
      const claimed = out.results.map((r) => r.id);
      expect(claimed.slice(0, 3)).toEqual(others);
      expect(claimed.slice(3)).toEqual(sends.slice(0, 5));
      expect(out.results.slice(3).every((r) => r.status === 'deferred')).toBe(true);
      expect((await q("SELECT COUNT(*) n FROM scheduled_jobs WHERE name LIKE 'campaign:60:send:%' AND scheduled_time < NOW()"))[0].n).toBe(3);
    });

    test('the locking read re-checks the claim predicate: a row another pass claimed and finished between the candidate read and the lock is not run twice', async () => {
      const [r] = await pool.query(`INSERT INTO scheduled_jobs (type, scheduled_time, status, name, data, max_attempts) VALUES ('one_time', NOW() - INTERVAL 1 MINUTE, 'pending', 'raced', '{"type":"webhook"}', 1)`);
      const jobId = r.insertId;
      let interleaved = 0;
      const racing = {
        query: (sql, p) => pool.query(sql, p),
        withTransaction: (fn, opts) => withTransaction(pool, (conn) => fn({
          query: async (sql, p) => {
            if (!interleaved && /^SELECT \* FROM scheduled_jobs WHERE id IN/.test(sql.trim())) {
              interleaved++;
              await processJobs.runJobPass(pool);                                    // a whole second pass, committed, in between
            }
            return conn.query(sql, p);
          },
        }), opts),
      };
      const first = await processJobs.runJobPass(racing);
      expect(interleaved).toBe(1);
      expect(first.results.map((x) => x.id)).not.toContain(jobId);
      expect(await q('SELECT COUNT(*) n FROM job_results WHERE job_id = ?', [jobId])).toEqual([{ n: 1 }]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  describe('P: pause / resume / the pump / cancel', () => {
    const base = { type: 'email', subject: 'S', body: '<p>B</p>', sender: 'ops@firm.test', createdBy: 6, auth: ADMIN };
    test('pause: sends defer, the pump stops; resume: a new pump, rung, re-rings the sends; the old pump retires', async () => {
      await setSettings({ campaign_operational_cap: '1', campaign_marketing_rate: '60' });
      const c = await campaignService.createCampaign(pool, { ...base, contactIds: [2, 3, 4], confirmCount: 3 });
      // DATETIME rounds the JS due time to the second (up to +0.5 s): step past it, as a real
      // doorbell's DISPATCH_BUFFER_MS does, so the targeted claims below find the rows due.
      await q("UPDATE scheduled_jobs SET scheduled_time = scheduled_time - INTERVAL 3 SECOND WHERE name LIKE ?", [`campaign:${c.campaignId}:%`]);
      const [pump1] = await q("SELECT id FROM scheduled_jobs WHERE name LIKE '%:pump'");
      expect(await campaignService.pauseCampaign(pool, c.campaignId)).toEqual({ paused: true, parked: 3 });
      expect((await processJobs.runJobPass(pool, { jobId: pump1.id })).results[0].status).toBe('completed');   // runPump: paused → done
      // parked: still pending, never due — a doorbell / the cron finds nothing to claim
      expect(await q("SELECT COUNT(*) n FROM scheduled_jobs WHERE name LIKE '%:send:%' AND status = 'pending' AND YEAR(scheduled_time) >= 3000")).toEqual([{ n: 3 }]);
      const [s1] = await q("SELECT id FROM scheduled_jobs WHERE name LIKE '%:send:2'");
      expect((await processJobs.runJobPass(pool, { jobId: s1.id })).results[0]).toMatchObject({ status: 'already_claimed' });
      await expect(campaignService.pauseCampaign(pool, c.campaignId)).rejects.toMatchObject({ status: 409 });
      taskQueue.enqueueJobDispatch.mockClear();
      const res = await campaignService.resumeCampaign(pool, c.campaignId);
      expect(res.pumpJobId).toBeGreaterThan(pump1.id);
      expect((await camp(c.campaignId)).status).toBe('sending');
      expect(taskQueue.enqueueJobDispatch.mock.calls.map((x) => x[0])).toEqual([res.pumpJobId]);
      await expect(campaignService.resumeCampaign(pool, c.campaignId)).rejects.toMatchObject({ status: 409 });

      taskQueue.enqueueJobDispatch.mockClear();
      // resume pulled the rows back, re-staggered from now at 60/min
      const back = await q("SELECT TIMESTAMPDIFF(SECOND, NOW(), scheduled_time) AS ahead FROM scheduled_jobs WHERE name LIKE '%:send:%' ORDER BY scheduled_time, id");
      expect(back.map((b) => b.ahead - back[0].ahead)).toEqual([0, 1, 2]);      // 1 s apart from now (a second may tick)
      expect(back[0].ahead).toBeGreaterThanOrEqual(-1);
      expect(back[0].ahead).toBeLessThanOrEqual(0);
      await q("UPDATE scheduled_jobs SET scheduled_time = scheduled_time - INTERVAL 3 SECOND WHERE id = ?", [res.pumpJobId]);
      const tick = await processJobs.runJobPass(pool, { jobId: res.pumpJobId });
      expect(tick.results[0]).toMatchObject({ status: 'deferred', reason: 'pump_tick' });
      const rung = taskQueue.enqueueJobDispatch.mock.calls.map((x) => x[0]).filter((id) => id !== res.pumpJobId).sort((a, b) => a - b);
      const due = (await q("SELECT id FROM scheduled_jobs WHERE name LIKE '%:send:%' AND status = 'pending' AND scheduled_time <= NOW() + INTERVAL 90 SECOND ORDER BY id")).map((r) => r.id);
      expect(rung).toEqual(due);
      expect(rung.length).toBeGreaterThanOrEqual(2);
      const [p2] = await q('SELECT status, attempts, execution_count, TIMESTAMPDIFF(SECOND, NOW(), scheduled_time) AS ahead FROM scheduled_jobs WHERE id = ?', [res.pumpJobId]);
      expect([p2.status, p2.attempts, p2.execution_count]).toEqual(['pending', 0, 0]);
      expect(p2.ahead).toBeGreaterThanOrEqual(53);
      expect(p2.ahead).toBeLessThanOrEqual(56);
      // an older pump woken by recovery sees the newer live one and retires
      await q("UPDATE scheduled_jobs SET status = 'pending', scheduled_time = NOW() WHERE id = ?", [pump1.id]);
      expect(await campaignService.runPump(pool, c.campaignId, { jobId: pump1.id })).toEqual({ done: true, reason: 'superseded' });
    });

    test('BLOCKER fix: a paused campaign\'s overdue rows are parked — they never hold the cron\'s campaign-send quota', async () => {
      await seedCampaign({ id: 80, contacts: [1, 2, 3, 4, 5], over: 5 });
      for (let i = 0; i < 15; i++) await sendJob(80, (i % 5) + 1, { due: 'NOW() - INTERVAL 10 MINUTE' });
      await seedCampaign({ id: 81, contacts: [2] });
      const other = await sendJob(81, 2, { due: 'NOW() - INTERVAL 1 MINUTE' });
      expect(await campaignService.pauseCampaign(pool, 80)).toEqual({ paused: true, parked: 15 });
      const out = await processJobs.runJobPass(pool);
      expect(out.results.map((r) => r.id)).toEqual([other]);                       // the paused rows are not due
      expect(out.results[0]).toMatchObject({ status: 'completed' });
      expect((await row(81, 2)).status).toBe('sent');
      expect(await q("SELECT COUNT(*) n FROM scheduled_jobs WHERE name LIKE 'campaign:80:send:%' AND status = 'pending'")).toEqual([{ n: 15 }]);   // nothing lost
    });

    test('the backstop: a job claimed BEFORE the pause is not parked; it defers itself, and resume pulls it back first', async () => {
      await setSettings({ campaign_marketing_rate: '60' });
      await seedCampaign({ id: 82, contacts: [2, 3, 4], over: 3 });
      const straggler = await sendJob(82, 2, { due: 'NOW() - INTERVAL 5 MINUTE' });
      const parkedA = await sendJob(82, 3, { due: 'NOW() - INTERVAL 4 MINUTE' });
      const parkedB = await sendJob(82, 4, { due: 'NOW() - INTERVAL 3 MINUTE' });
      await q("UPDATE scheduled_jobs SET status = 'running' WHERE id = ?", [straggler]);   // claimed by a pass already in flight
      expect(await campaignService.pauseCampaign(pool, 82)).toEqual({ paused: true, parked: 2 });
      await q("UPDATE scheduled_jobs SET status = 'pending' WHERE id = ?", [straggler]);   // recovered: due again
      expect((await processJobs.runJobPass(pool, { jobId: straggler })).results[0]).toMatchObject({ status: 'deferred', reason: 'campaign_paused' });
      const [st] = await q('SELECT attempts, TIMESTAMPDIFF(SECOND, NOW(), scheduled_time) AS ahead FROM scheduled_jobs WHERE id = ?', [straggler]);
      expect(st.attempts).toBe(0);
      expect(st.ahead).toBeGreaterThanOrEqual(295);
      expect(sendEmail).not.toHaveBeenCalled();
      await campaignService.resumeCampaign(pool, 82);
      const back = await q("SELECT id, TIMESTAMPDIFF(SECOND, NOW(), scheduled_time) AS ahead FROM scheduled_jobs WHERE name LIKE 'campaign:82:send:%' ORDER BY scheduled_time, id");
      expect(back.map((b) => b.id)).toEqual([straggler, parkedA, parkedB]);
      expect(back.map((b) => b.ahead - back[0].ahead)).toEqual([0, 1, 2]);
      expect(back[0].ahead).toBeGreaterThanOrEqual(-1);
      expect(back[0].ahead).toBeLessThanOrEqual(0);
    });

    test('resume keeps the start of a campaign paused before it began (parked rows return to their own times)', async () => {
      await setSettings({ campaign_marketing_rate: '60' });
      await seedCampaign({ id: 83, status: 'scheduled', contacts: [2, 3], over: 2 });
      await sendJob(83, 2, { due: 'NOW() + INTERVAL 1 HOUR' });
      await sendJob(83, 3, { due: 'NOW() + INTERVAL 1 HOUR + INTERVAL 1 SECOND' });
      const before = (await q("SELECT scheduled_time t FROM scheduled_jobs WHERE name LIKE 'campaign:83:send:%' ORDER BY id")).map((r) => r.t.getTime());
      await campaignService.pauseCampaign(pool, 83);
      await campaignService.resumeCampaign(pool, 83);
      expect((await q("SELECT scheduled_time t FROM scheduled_jobs WHERE name LIKE 'campaign:83:send:%' ORDER BY id")).map((r) => r.t.getTime())).toEqual(before);
    });

    test('the pump re-arms its own row ~55 s out AND rings that row\'s doorbell for the same instant (no half-rate wait for the next cron tick)', async () => {
      await seedCampaign({ id: 84, contacts: [2], over: 1 });
      await sendJob(84, 2, { due: 'NOW() + INTERVAL 10 MINUTE' });
      const t0 = Date.now();
      const out = await campaignService.runPump(pool, 84, { jobId: 4242 });
      expect(out).toMatchObject({ deferred: true, rung: 0 });
      expect(out.retryAtMs - t0).toBeGreaterThanOrEqual(campaignService.PUMP_REARM_MS);
      expect(out.retryAtMs - Date.now()).toBeLessThanOrEqual(campaignService.PUMP_REARM_MS);
      expect(campaignService.PUMP_REARM_MS).toBe(55000);
      expect(campaignService.PUMP_REARM_MS).toBeLessThan(taskQueue.ACCEL_WINDOW_MS);      // invariant 3: a doorbell, not a calendar
      expect(taskQueue.enqueueJobDispatch.mock.calls).toEqual([[4242, out.retryAtMs]]);
    });

    test('the pump bound: at most `rate` doorbells per tick, overdue ones included — never all of them', async () => {
      await setSettings({ campaign_marketing_rate: '4' });
      await seedCampaign({ id: 70, contacts: [1, 2, 3, 4, 5], over: 5 });
      const ids = [];
      for (const ct of [1, 2, 3, 4, 5]) ids.push(await sendJob(70, ct, { due: 'NOW() - INTERVAL 1 HOUR' }));
      const out = await campaignService.runPump(pool, 70, { jobId: null });
      expect(out).toMatchObject({ deferred: true, rung: 3 });                     // floor(4 × 55/60): ≤ rate per minute at the 55 s re-arm
      expect(taskQueue.enqueueJobDispatch.mock.calls.map((x) => x[0])).toEqual(ids.slice(0, 3));
      // far-future sends are never rung (a doorbell, not a calendar)
      taskQueue.enqueueJobDispatch.mockClear();
      await q("UPDATE scheduled_jobs SET scheduled_time = NOW() + INTERVAL 10 MINUTE WHERE name LIKE 'campaign:70:send:%'");
      expect(await campaignService.runPump(pool, 70, { jobId: null })).toMatchObject({ deferred: true, rung: 0 });
      // no sends left → done
      await q("UPDATE scheduled_jobs SET status = 'completed' WHERE name LIKE 'campaign:70:send:%'");
      expect(await campaignService.runPump(pool, 70, { jobId: null })).toEqual({ done: true, reason: 'no_sends_left', rung: 0 });
    });

    test('cancel deletes the pump row with the pending sends (the campaign:{id}: prefix)', async () => {
      await setSettings({ campaign_operational_cap: '1' });
      const c = await campaignService.createCampaign(pool, { ...base, contactIds: [2, 3], confirmCount: 2 });
      expect(await q("SELECT COUNT(*) n FROM scheduled_jobs WHERE name = ?", [`campaign:${c.campaignId}:pump`])).toEqual([{ n: 1 }]);
      await campaignService.pauseCampaign(pool, c.campaignId);
      expect(await campaignService.cancelCampaign(pool, c.campaignId)).toEqual({ canceled: true, jobsRemoved: 3 });
      expect(await q('SELECT COUNT(*) n FROM scheduled_jobs WHERE name LIKE ?', [`campaign:${c.campaignId}:%`])).toEqual([{ n: 0 }]);
    });
  });
});
