/**
 * YisraMail C2 — the marketing send path on REAL MySQL (ref/YISRAMAIL_DESIGN.md §4.5, §6.4, §6.5
 * "As built (C2)").
 *
 *   S  a marketing send end to end — REAL emailService.sendEmailDirect + the REAL smtp adapter and
 *      SES driver; only nodemailer's transport is a recorder: the footer in the html AND the text,
 *      the unsubscribe URL (href + visible), the three headers exactly, the Reply-To, the tags as
 *      strings, the token row with send_ref = the result id, provider_message_id stored, the
 *      email_log row WITHOUT the body, no signature; the switch '0' still records
 *      marketing_disabled
 *   N  the send-start snapshot is written once and reused after a mid-send settings change
 *   O  consent by topic reaches findOptedOut (klass marketing + topic); an opt_in topic blocks a
 *      destination without state opted_in, sends once it has it
 *   H  the HOLD: a held transport pauses the campaign (its pending sends parked), records nothing,
 *      sends nothing, alerts once a day; createCampaign refuses 422; the thresholds SET it
 *      (complaints > 0.3 %, hard bounces > 5 %, ≥ 200 delivered) and pause every marketing
 *      campaign on the transport; below `enough` or under 0.3 % nothing holds (0.1 % warns)
 *   R  the SU release lifts it, audited in the same transaction, info alert; 409 / 404
 *   A  an account-level SES refusal holds the transport, pauses every marketing campaign on it and
 *      puts the recipient back to pending (reservation cleared, a deferral)
 *   F  the post-render assert: a gutted footer → failed footer_missing, NO provider call; a firm
 *      hole (the builder throws) → failed per recipient, the campaign finalizes, no snapshot
 *   T  the test send: [TEST] subject, the same transport + headers, to the caller; no token row, no
 *      result row, body logged; works with the switch off; campaigns.bulk required
 *   U  a definite transient failure clears the reservation; the retry re-uses the unused token
 *
 * NOTHING CAN SEND: nodemailer.createTransport returns a recorder (no socket); fetch refuses.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3321/yc_c2_test npx jest tests/campaignC2.mysql.test.js --runInBand
 * Its OWN *_test DB family: it drops and rebuilds every table it touches (cloned from
 * ref/database.sql, the consent tables from the P1 migration, then the C1 and C2 migration
 * scripts — idempotent, so the twin is independent of whether the dump carries them yet).
 */
'use strict';

const mockSent = [];
let mockSendImpl = null;
jest.mock('nodemailer', () => {
  const actual = jest.requireActual('nodemailer');
  return {
    ...actual,
    createTransport: jest.fn(() => ({
      sendMail: async (o) => {
        mockSent.push(o);
        if (mockSendImpl) return mockSendImpl(o);
        return { messageId: `<m${mockSent.length}@test>`, response: `250 Ok 0100018b5f6a1b2c-c2c2c2c2-0000-0000-0000-00000000000${mockSent.length % 10}-000000`, accepted: [o.to], rejected: [] };
      },
    })),
  };
});
jest.mock('../lib/taskQueue', () => {
  const actual = jest.requireActual('../lib/taskQueue');
  return { ...actual, enqueueJobDispatch: jest.fn(async () => true) };
});
const realFetch = global.fetch;
global.fetch = async (url) => { throw new Error(`test: network is unreachable (${url})`); };

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

const TABLES = ['campaigns', 'campaign_contacts', 'campaign_results', 'scheduled_jobs', 'job_results',
  'contacts', 'contact_phones', 'contact_emails', 'app_settings', 'email_credentials', 'admin_audit_log',
  'users', 'comm_unsub_tokens', 'email_log', 'system_alerts', 'alert_state'];

d('C2 marketing send path on real MySQL', () => {
  const mysql = require('mysql2/promise');
  const schema = require('./helpers/commsArchiveSchema');
  const { buildConsentTables } = require('./helpers/consentSchema');
  const { withTransaction } = require('../lib/withTransaction');
  const { encrypt } = require('../lib/credentialCrypto');
  const firmConfig = require('../lib/firmConfig');
  const complianceFooter = require('../lib/complianceFooter');
  const c1Migrate = require('../scripts/yisramailC1Migrate');
  const c2Migrate = require('../scripts/yisramailC2Migrate');
  const campaignService = require('../services/campaignService');
  const emailService = require('../services/emailService');
  const optout = require('../services/optoutService');
  const unsub = require('../services/unsubService');
  const smtp = require('../services/adapters/email/smtp');

  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const ADMIN = { type: 'jwt', roles: ['admin'], userId: 6, username: 'fred' };
  const STAFF = { type: 'jwt', roles: ['staff'], userId: 9, username: 'sam' };
  const FIRM = {
    firm_name: 'Smith & Jones Law', firm_address: '["100 Main St., #2","Springfield, MI 48000"]',
    'fe-firm_phone': '2485550100', firm_attorney_name: 'Ann Smith', firm_email: 'office@firm.test',
  };
  let direct;

  async function setSettings(map) {
    await q('DELETE FROM app_settings');
    for (const [k, v] of Object.entries(map)) await q('INSERT INTO app_settings (`key`, `value`) VALUES (?, ?)', [k, v]);
    firmConfig._test({ db: pool, resetCache: true });
    await firmConfig.prime();
  }
  const ON = (extra = {}) => setSettings({ marketing_send_enabled: '1', ...FIRM, ...extra });
  async function seedCampaign({ id, klass = 'marketing', status = 'sending', sender = 'news@news.test', contacts = [2], topic = 'newsletter',
    body = '<html><body><p>Hi {{contacts.contact_fname}}, news.</p></body></html>', subject = 'News for {{contacts.contact_fname}}' }) {
    await q(`INSERT INTO campaigns (campaign_id, type, class, topic_key, sender, subject, body, status, contact_count, created_by)
             VALUES (?, 'email', ?, ?, ?, ?, ?, ?, ?, 6)`, [id, klass, klass === 'marketing' ? topic : null, sender, subject, body, status, contacts.length]);
    if (contacts.length) await q('INSERT INTO campaign_contacts (campaign_id, contact_id) VALUES ?', [contacts.map((c) => [id, c])]);
  }
  async function sendJob(campaignId, contactId, due = 'NOW()') {
    const [r] = await pool.query(
      `INSERT INTO scheduled_jobs (type, scheduled_time, status, name, data, max_attempts, backoff_seconds, idempotency_key, attempts, execution_count)
       VALUES ('one_time', ${due}, 'pending', ?, ?, 3, 60, ?, 0, 0)`,
      [`campaign:${campaignId}:send:${contactId}`, JSON.stringify({ type: 'campaign_send', campaign_id: campaignId, contact_id: contactId }), `campaign:${campaignId}:${contactId}`]);
    return r.insertId;
  }
  const send = (cid, ctid, meta = {}) => campaignService.executeSend(pool, cid, ctid, { jobId: 500 + ctid, attempt: 1, maxAttempts: 3, ...meta });
  const row = async (cid, ctid) => (await q('SELECT * FROM campaign_results WHERE campaign_id = ? AND contact_id = ?', [cid, ctid]))[0];
  const camp = async (cid) => (await q('SELECT status, send_snapshot FROM campaigns WHERE campaign_id = ?', [cid]))[0];
  const tokens = async (cid) => q('SELECT * FROM comm_unsub_tokens WHERE campaign_id <=> ? ORDER BY created_at, token', [cid]);
  const held = async () => (await q('SELECT held_at, held_reason FROM email_credentials WHERE id = 17'))[0];
  /** email_log is written fire-and-forget by the adapter — bounded wait for n rows. */
  async function logRows(n) {
    for (let i = 0; i < 50; i++) {
      const rows = await q("SELECT * FROM email_log WHERE source = 'outbound-smtp' ORDER BY id");
      if (rows.length >= n) return rows;
      await new Promise((r) => setTimeout(r, 20));
    }
    return q("SELECT * FROM email_log WHERE source = 'outbound-smtp' ORDER BY id");
  }
  /** delivery rows for the threshold tests: n rows of campaign `cid` with the given status / *_at. */
  async function seedDeliveries(cid, startContact, n, kind) {
    const vals = [];
    for (let i = 0; i < n; i++) {
      const at = 'UTC_TIMESTAMP(3) - INTERVAL 1 HOUR';
      vals.push(`(${cid}, ${startContact + i}, 'sent', NOW() - INTERVAL 2 HOUR, ${kind === 'delivered' ? `'delivered', ${at}, NULL, NULL` : kind === 'complained' ? `'complained', ${at}, NULL, ${at}` : `'bounced_hard', NULL, ${at}, NULL`})`);
    }
    await q(`INSERT INTO campaign_results (campaign_id, contact_id, status, sent_at, delivery_status, delivered_at, bounced_at, complained_at) VALUES ${vals.join(',')}`);
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
      expect((await c2Migrate.run(c, { apply: true, say: () => {} })).ok).toBe(true);
    } finally { c.release(); }
    await q(`INSERT INTO contacts (contact_id, contact_name, contact_fname, contact_lname, contact_phone, contact_email) VALUES
      (1, 'Pat One', 'Pat', 'One', '3135550001', 'pat@example.com'),
      (2, 'Sam Two', 'Sam', 'Two', '3135550002', 'sam@example.com'),
      (3, 'Ann Three', 'Ann', 'Three', '3135550003', 'ann@example.com'),
      (4, 'Bo Four', 'Bo', 'Four', '3135550004', 'bo@example.com')`);
    await q(`INSERT INTO contact_emails (id, contact_id, email, label, is_primary, email_optout, end_date) VALUES
      (21, 1, 'pat@example.com', 'Personal', 1, 1, NULL), (22, 2, 'sam@example.com', 'Personal', 1, 0, NULL),
      (23, 3, 'ann@example.com', 'Personal', 1, 0, NULL), (24, 4, 'bo@example.com', 'Personal', 1, 0, NULL)`);
    await q(`INSERT INTO email_credentials (id, email, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure, provider, from_name, bulk_ok, events_driver, driver_config, signature_html) VALUES
      (4, 'ops@firm.test', 'mail.firm.test', 587, 'ops@firm.test', ?, 0, 'smtp', 'Ops', 0, NULL, NULL, NULL),
      (17, 'news@news.test', 'email-smtp.test', 587, 'AKIA', ?, 0, 'smtp', 'Firm News', 1, 'ses', '{"configuration_set":"yisramail-marketing"}', '<p>SIGNATURE-MUST-NOT-APPEAR</p>')`,
    [encrypt('pw'), encrypt('pw')]);
    await q(`INSERT INTO users (username, user_type, user_name, user_fname, user_lname, user_initials, user_auth, user, email, ringcentral, roles) VALUES
      ('fred', 1, 'Fred', 'Fred', 'F', 'FF', 'authorized', 6, 'fred@firm.test', 0, 'admin'),
      ('sam', 1, 'Sam', 'Sam', 'S', 'SS', 'authorized', 9, 'samstaff@firm.test', 0, 'staff')`);
    await q("INSERT INTO comm_topics (topic_key, channel, label, consent_model, active) VALUES ('vip', 'email', 'VIP list', 'opt_in', 1) ON DUPLICATE KEY UPDATE label = VALUES(label)");
    const [[news]] = await pool.query("SELECT topic_key, consent_model, active FROM comm_topics WHERE topic_key = 'newsletter'");
    expect(news).toMatchObject({ consent_model: 'opt_out', active: 1 });   // seeded by the P1 migration
  });

  beforeEach(async () => {
    for (const t of ['campaigns', 'campaign_contacts', 'campaign_results', 'scheduled_jobs', 'admin_audit_log', 'comm_unsub_tokens', 'email_log', 'system_alerts', 'alert_state']) await q(`DELETE FROM ${t}`);
    await q("DELETE FROM comm_consent_state WHERE destination <> 'pat@example.com'");
    await q("DELETE FROM comm_consent_events WHERE destination <> 'pat@example.com'");
    await q('UPDATE email_credentials SET held_at = NULL, held_reason = NULL');
    await ON();
    mockSent.length = 0;
    mockSendImpl = null;
    direct = jest.spyOn(emailService, 'sendEmailDirect');                    // calls through
    for (const m of ['log', 'warn', 'error']) jest.spyOn(console, m).mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    firmConfig._test({ db: null, resetCache: true });
    global.fetch = realFetch;
    if (pool) await pool.end();
  });

  // ── S ────────────────────────────────────────────────────────────────────
  describe('S: a marketing send end to end', () => {
    test('footer in html AND text, URL href + visible, headers exact, Reply-To, string tags, token send_ref, provider id, email_log without body, no signature', async () => {
      await seedCampaign({ id: 90 });
      const out = await send(90, 2);
      expect(out).toMatchObject({ sent: true });

      const r = await row(90, 2);
      expect(r.status).toBe('sent');
      const [tok] = await tokens(90);
      expect(tok).toMatchObject({ destination: 'sam@example.com', topic_key: 'newsletter', campaign_id: 90, contact_id: 2, send_ref: String(r.result_id), used_at: null });
      const url = unsub.urlFor(tok.token);

      expect(direct).toHaveBeenCalledTimes(1);
      const [, rowArg, o] = direct.mock.calls[0];
      expect(rowArg.id).toBe(17);
      expect(o.bulk).toBe(true);
      expect(o.headers).toEqual({ 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click', 'List-Id': '<newsletter.news.test>' });
      expect(o.reply_to).toBe('office@firm.test');
      expect(o.tags).toEqual({ campaign_id: '90', result_id: String(r.result_id) });
      for (const v of Object.values(o.tags)) expect(typeof v).toBe('string');
      expect(o.log_body).toBe(false);
      expect(o.signature).toBeUndefined();
      expect(o.subject).toBe('News for Sam');

      const footer = complianceFooter.buildComplianceFooter({ unsubscribeUrl: url, preferencesUrl: unsub.preferencesUrlFor(tok.token),
        topic: { topic_key: 'newsletter', label: 'Newsletter', consent_model: 'opt_out' } });
      expect(o.html).toContain(footer.html);
      expect(o.html).toContain(`href="${url}"`);
      expect(o.html.indexOf(footer.html)).toBeLessThan(o.html.indexOf('</body>'));      // before </body>, never after </html>
      expect(o.html.trim().endsWith('</html>')).toBe(true);
      expect(o.text).toContain(footer.text);
      expect(o.text).toContain(url);
      expect(o.text).toMatch(/^Hi Sam, news\./);
      expect(o.html).not.toMatch(/SIGNATURE-MUST-NOT-APPEAR/);

      // what actually went to the transport (the real adapter + SES driver)
      expect(mockSent).toHaveLength(1);
      const m = mockSent[0];
      expect(m.headers).toMatchObject({ 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click', 'List-Id': '<newsletter.news.test>', 'X-SES-CONFIGURATION-SET': 'yisramail-marketing' });
      expect(m.replyTo).toBe('office@firm.test');
      expect(m.text).toBe(o.text);
      expect(m.to).toBe('sam@example.com');

      expect(r.provider_message_id).toBe('0100018b5f6a1b2c-c2c2c2c2-0000-0000-0000-000000000001-000000');
      const logs = await logRows(1);
      expect(logs).toHaveLength(1);
      expect(logs[0].body).toBe(smtp.LOG_BODY_OMITTED);
      expect(logs[0].body).not.toMatch(/Hi Sam/);
      expect(JSON.parse(logs[0].delivery_info).response).toMatch(/^250 Ok/);
      expect(logs[0].to_email).toBe('sam@example.com');
      expect((await camp(90)).status).toBe('sent');
    });

    test('the switch not exactly "1" still records skipped marketing_disabled, nothing minted or sent', async () => {
      await setSettings({ ...FIRM, marketing_send_enabled: '0' });
      await seedCampaign({ id: 91 });
      expect(await send(91, 2)).toEqual({ skipped: true, reason: 'marketing_disabled' });
      expect(JSON.parse(JSON.stringify((await row(91, 2)).result_meta))).toEqual({ reason: 'marketing_disabled' });
      expect(await tokens(91)).toEqual([]);
      expect(direct).not.toHaveBeenCalled();
      expect(mockSent).toHaveLength(0);
    });

    test('the footer slot marker takes the footer where the body put it', async () => {
      await seedCampaign({ id: 92, body: `<div class="card"><p>Hi</p>${campaignService.FOOTER_SLOT}</div><p>outside</p>` });
      await send(92, 2);
      const o = direct.mock.calls[0][2];
      expect(o.html).not.toContain(campaignService.FOOTER_SLOT);
      expect(o.html.indexOf('data-yc-compliance-footer')).toBeLessThan(o.html.indexOf('</div><p>outside'));
    });
  });

  // ── N ────────────────────────────────────────────────────────────────────
  describe('N: the send-start snapshot', () => {
    test('written once at the first send and reused after a settings change mid-send — the campaign never splits', async () => {
      await seedCampaign({ id: 100, contacts: [2, 3] });
      expect((await camp(100)).send_snapshot).toBeNull();
      await send(100, 2);
      const snap1 = (await camp(100)).send_snapshot;
      expect(snap1).toMatchObject({ v: 1, firm: { name: 'Smith & Jones Law', attorney_name: 'Ann Smith' }, topic: { topic_key: 'newsletter', consent_model: 'opt_out' },
        reply_to: 'office@firm.test', list_id: '<newsletter.news.test>', subject: 'News for {{contacts.contact_fname}}', token_placeholder: '{token}' });
      expect(snap1.html).toContain('data-yc-compliance-footer');
      expect(snap1.html).toContain('/u/{token}');
      expect(snap1.text).toContain('Responsible attorney: Ann Smith');

      // mid-send: the firm's name, attorney and reply-to change
      await ON({ firm_name: 'Renamed Firm LLC', firm_attorney_name: 'Bob Other', marketing_reply_to: 'elsewhere@firm.test' });
      expect(complianceFooter.firmValues().name).toBe('Renamed Firm LLC');
      await send(100, 3);
      const second = direct.mock.calls[1][2];
      expect(second.html).toContain('Smith &amp; Jones Law');
      expect(second.html).toContain('Responsible attorney: Ann Smith');
      expect(second.html).not.toMatch(/Renamed Firm|Bob Other/);
      expect(second.text).not.toMatch(/Renamed Firm|Bob Other/);
      expect(second.reply_to).toBe('office@firm.test');
      expect((await camp(100)).send_snapshot).toEqual(snap1);
      // a NEW campaign takes the new values
      await seedCampaign({ id: 101 });
      await send(101, 2);
      expect(direct.mock.calls[2][2].html).toContain('Renamed Firm LLC');
      expect(direct.mock.calls[2][2].reply_to).toBe('elsewhere@firm.test');
    });
  });

  // ── O ────────────────────────────────────────────────────────────────────
  describe('O: consent by topic', () => {
    test('findOptedOut is asked as marketing + the topic; a marketing opt-out is skipped, never minted or sent', async () => {
      const spy = jest.spyOn(optout, 'findOptedOut');
      await seedCampaign({ id: 110, contacts: [1] });
      expect(await send(110, 1)).toEqual({ skipped: true, reason: 'email_optout' });
      expect(spy).toHaveBeenCalledWith(pool, 'email', 'pat@example.com', { klass: 'marketing', topic: 'newsletter' });
      expect(await tokens(110)).toEqual([]);
      expect(mockSent).toHaveLength(0);
    });

    test('an opt_in topic blocks a destination without state opted_in, and sends once it has it', async () => {
      await seedCampaign({ id: 111, topic: 'vip', contacts: [3] });
      expect(await send(111, 3)).toEqual({ skipped: true, reason: 'email_optout' });
      expect(mockSent).toHaveLength(0);
      await seedCampaign({ id: 112, topic: 'vip', contacts: [3] });
      await withTransaction(pool, (conn) => optout.recordConsent(conn, { channel: 'email', destination: 'ann@example.com', scope: 'vip', action: 'opt_in', source: 'staff' }));
      expect(await send(112, 3)).toMatchObject({ sent: true });
      // an opt_in topic: no advertisement label in the footer
      expect(direct.mock.calls[0][2].html).not.toMatch(/>Advertisement</);
    });
  });

  // ── H ────────────────────────────────────────────────────────────────────
  describe('H: the transport hold', () => {
    test('a held transport: the campaign pauses (pending sends parked), nothing recorded or sent, one error alert a day; create refuses 422', async () => {
      await q("UPDATE email_credentials SET held_at = UTC_TIMESTAMP(), held_reason = 'complaint rate 0.40%' WHERE id = 17");
      await seedCampaign({ id: 120, contacts: [2, 3] });
      await sendJob(120, 3);
      const out = await send(120, 2);
      expect(out).toMatchObject({ deferred: true, reason: 'transport_held' });
      expect(out.retryAtMs - Date.now()).toBeGreaterThan(campaignService.PAUSED_DEFER_MS - 1000);
      expect((await camp(120)).status).toBe('paused');
      expect(await row(120, 2)).toBeUndefined();
      expect(await tokens(120)).toEqual([]);
      expect(mockSent).toHaveLength(0);
      const [job] = await q("SELECT scheduled_time >= ? AS parked FROM scheduled_jobs WHERE name = 'campaign:120:send:3'", [campaignService.PARKED_AFTER]);
      expect(Number(job.parked)).toBe(1);
      // the backstop job comes back while still held: still nothing, still ONE alert today
      await q("UPDATE campaigns SET status = 'sending' WHERE campaign_id = 120");
      expect(await send(120, 2)).toMatchObject({ deferred: true, reason: 'transport_held' });
      const alerts = await q("SELECT severity, kind FROM system_alerts WHERE kind = 'mail_transport_held'");
      expect(alerts).toEqual([{ severity: 'error', kind: 'mail_transport_held' }]);
      // a new marketing campaign on it is refused
      await expect(campaignService.createCampaign(pool, { type: 'email', sender: 'news@news.test', subject: 'S', body: '<p>b</p>', contactIds: [2], createdBy: 6, klass: 'marketing', topicKey: 'newsletter', auth: ADMIN }))
        .rejects.toMatchObject({ status: 422, code: 'transport_held', extra: { held_reason: 'complaint rate 0.40%' } });
    });

    test('complaints > 0.3 % with ≥ 200 delivered SET the hold and pause every marketing campaign on the transport', async () => {
      await seedCampaign({ id: 130, status: 'sent', contacts: [] });
      await seedDeliveries(130, 1000, 299, 'delivered');
      await seedDeliveries(130, 2000, 1, 'complained');                           // 1 / 300 delivered = 0.33 %
      await seedCampaign({ id: 131, contacts: [2] });
      await seedCampaign({ id: 132, contacts: [3] });                             // a sibling on the same transport
      await seedCampaign({ id: 133, klass: 'operational', sender: 'ops@firm.test', contacts: [4] });
      expect(await send(131, 2)).toMatchObject({ deferred: true, reason: 'transport_held' });
      const h = await held();
      expect(h.held_at).not.toBeNull();
      expect(h.held_reason).toMatch(/^complaint rate 0\.33%/);
      expect((await camp(131)).status).toBe('paused');
      expect((await camp(132)).status).toBe('paused');
      expect((await camp(133)).status).toBe('sending');
      expect(mockSent).toHaveLength(0);
      expect(await q("SELECT severity FROM system_alerts WHERE kind = 'mail_transport_held'")).toEqual([{ severity: 'error' }]);
    });

    test('hard bounces > 5 % with ≥ 200 delivered SET the hold', async () => {
      await seedCampaign({ id: 134, status: 'sent', contacts: [] });
      await seedDeliveries(134, 1000, 200, 'delivered');
      await seedDeliveries(134, 3000, 11, 'bounced_hard');                        // 11 / 211 = 5.2 %
      await seedCampaign({ id: 135, contacts: [2] });
      expect(await send(135, 2)).toMatchObject({ deferred: true, reason: 'transport_held' });
      expect((await held()).held_reason).toMatch(/^hard-bounce rate 5\.21%/);
    });

    test('below `enough` nothing holds; 0.2 % complaints only warns (once) and the send goes', async () => {
      await seedCampaign({ id: 136, status: 'sent', contacts: [] });
      await seedDeliveries(136, 1000, 190, 'delivered');
      await seedDeliveries(136, 2000, 9, 'complained');                           // 9 / 199 — but 199 < 200
      await seedCampaign({ id: 137, contacts: [2] });
      expect(await send(137, 2)).toMatchObject({ sent: true });
      expect((await held()).held_at).toBeNull();

      await q('DELETE FROM campaign_results WHERE campaign_id = 136');
      await seedDeliveries(136, 1000, 499, 'delivered');
      await seedDeliveries(136, 2000, 1, 'complained');                           // 1 / 500 = 0.2 %
      await seedCampaign({ id: 138, contacts: [2, 3] });
      expect(await send(138, 2)).toMatchObject({ sent: true });
      expect(await send(138, 3)).toMatchObject({ sent: true });
      expect((await held()).held_at).toBeNull();
      expect(await q("SELECT severity FROM system_alerts WHERE kind = 'mail_complaint_rate'")).toEqual([{ severity: 'warning' }]);
    });
  });

  // ── R ────────────────────────────────────────────────────────────────────
  describe('R: the SU release', () => {
    test('lifts the hold, audited in the same transaction, info alert; campaigns stay paused; 409 when not held, 404 unknown', async () => {
      await q("UPDATE email_credentials SET held_at = UTC_TIMESTAMP(), held_reason = 'hard-bounce rate 6%' WHERE id = 17");
      await seedCampaign({ id: 140, status: 'paused' });
      // a marketing campaign does not resume onto a held transport
      await expect(campaignService.resumeCampaign(pool, 140)).rejects.toMatchObject({ status: 422, code: 'transport_held', extra: { held_reason: 'hard-bounce rate 6%' } });
      expect((await camp(140)).status).toBe('paused');
      const out = await campaignService.releaseTransport(pool, 17, { auth: ADMIN, request: { route: 'POST /api/campaigns/transports/17/release', method: 'POST', ip: '1.2.3.4', userAgent: 'jest' } });
      expect(out).toMatchObject({ released: true, credential_id: 17, held_reason: 'hard-bounce rate 6%' });
      expect(await held()).toEqual({ held_at: null, held_reason: null });
      const audit = await q('SELECT tool, user_id, status, details FROM admin_audit_log');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ tool: 'mail_transport_release', status: 'success', details: expect.objectContaining({ credential_id: 17, held_reason: 'hard-bounce rate 6%' }) });
      expect(await q("SELECT severity FROM system_alerts WHERE kind = 'mail_transport_released'")).toEqual([{ severity: 'info' }]);
      expect((await camp(140)).status).toBe('paused');
      await expect(campaignService.releaseTransport(pool, 17, { auth: ADMIN })).rejects.toMatchObject({ status: 409, code: 'not_held' });
      await expect(campaignService.releaseTransport(pool, 999, { auth: ADMIN })).rejects.toMatchObject({ status: 404 });
      expect(await q('SELECT COUNT(*) n FROM admin_audit_log')).toEqual([{ n: 1 }]);
      // released + resumed → it sends
      await campaignService.resumeCampaign(pool, 140);
      expect(await send(140, 2)).toMatchObject({ sent: true });
    });

    test('an audit failure leaves the transport held (the write and the audit commit together)', async () => {
      await q("UPDATE email_credentials SET held_at = UTC_TIMESTAMP(), held_reason = 'x' WHERE id = 17");
      const broken = {
        query: (sql, p) => pool.query(sql, p),
        withTransaction: (fn, o) => withTransaction(pool, (conn) => fn({ query: (sql, p) => (/admin_audit_log/.test(sql) ? Promise.reject(new Error('audit down')) : conn.query(sql, p)) }), o),
      };
      await expect(campaignService.releaseTransport(broken, 17, { auth: ADMIN })).rejects.toThrow('audit down');
      expect((await held()).held_reason).toBe('x');
    });
  });

  // ── A ────────────────────────────────────────────────────────────────────
  describe('A: account-level refusal', () => {
    test('an SES "sending paused" 554 holds the transport, pauses every marketing campaign on it, the recipient back to pending', async () => {
      await seedCampaign({ id: 150, contacts: [2, 3] });
      await seedCampaign({ id: 151, contacts: [4] });
      await seedCampaign({ id: 152, klass: 'operational', sender: 'ops@firm.test', contacts: [4] });
      mockSendImpl = () => { throw Object.assign(new Error('Message rejected: Sending paused for this account. For more information, please check the AWS Support Center.'), { code: 'EMESSAGE', responseCode: 554, response: '554 Message rejected: Sending paused for this account. For more information, please check the AWS Support Center.', command: 'DATA' }); };
      const out = await send(150, 2);
      expect(out).toMatchObject({ deferred: true, reason: 'account_paused' });
      expect(await row(150, 2)).toBeUndefined();                                  // reservation cleared — pending again
      expect((await held()).held_reason).toMatch(/account level: 554 Message rejected: Sending paused/);
      expect((await camp(150)).status).toBe('paused');
      expect((await camp(151)).status).toBe('paused');
      expect((await camp(152)).status).toBe('sending');
      expect(await q("SELECT severity FROM system_alerts WHERE kind = 'mail_transport_held'")).toEqual([{ severity: 'error' }]);
      expect(mockSent).toHaveLength(1);
    });

    test('an AMBIGUOUS error whose text matches the pause family stays unknown — never re-pended, no hold (at most once)', async () => {
      await seedCampaign({ id: 154, contacts: [2] });
      mockSendImpl = () => { throw Object.assign(new Error('Connection closed unexpectedly after: Sending paused for this account'), { code: 'ECONNECTION' }); };
      expect(await send(154, 2)).toMatchObject({ unknown: true, reason: 'provider_ambiguous' });
      expect((await row(154, 2)).status).toBe('unknown');
      expect((await held()).held_at).toBeNull();
      expect((await camp(154)).status).not.toBe('paused');
    });

    test('an ordinary permanent 554 (unverified address) is still a per-recipient failure, no hold', async () => {
      await seedCampaign({ id: 153, contacts: [2] });
      mockSendImpl = () => { throw Object.assign(new Error('Message rejected: Email address is not verified.'), { code: 'EMESSAGE', responseCode: 554, response: '554 Message rejected: Email address is not verified.' }); };
      expect(await send(153, 2)).toMatchObject({ failed: true });
      expect((await held()).held_at).toBeNull();
      expect((await row(153, 2)).status).toBe('failed');
    });
  });

  // ── F ────────────────────────────────────────────────────────────────────
  describe('F: fail closed on the footer', () => {
    test('a gutted footer fails the post-render assert: failed footer_missing, NO provider call', async () => {
      await seedCampaign({ id: 160, contacts: [2] });
      const real = complianceFooter.buildComplianceFooter;
      jest.spyOn(complianceFooter, 'buildComplianceFooter').mockImplementation((o) => {
        const f = real(o);
        // the snapshot's copy builds normally; the per-recipient one loses its link
        return /\/u\/\{token\}/.test(o.unsubscribeUrl) ? f : { html: '<div data-yc-compliance-footer="1">gutted</div>', text: '--\ngutted' };
      });
      const out = await send(160, 2);
      expect(out).toMatchObject({ failed: true, reason: 'footer_missing' });
      const r = await row(160, 2);
      expect(r.status).toBe('failed');
      expect(r.error).toMatch(/^footer_missing: post-render check failed/);
      expect(direct).not.toHaveBeenCalled();
      expect(mockSent).toHaveLength(0);
      expect((await camp(160)).status).toBe('failed');
    });

    test('a firm hole (the builder throws) fails each recipient, the campaign finalizes, no snapshot is written', async () => {
      await ON({ firm_attorney_name: '' });
      await seedCampaign({ id: 161, contacts: [2, 3] });
      expect(await send(161, 2)).toMatchObject({ failed: true, reason: 'footer_missing' });
      expect(await send(161, 3)).toMatchObject({ failed: true, reason: 'footer_missing' });
      expect((await row(161, 2)).error).toMatch(/firm_attorney_name is not set/);
      const c = await camp(161);
      expect(c.send_snapshot).toBeNull();
      expect(c.status).toBe('failed');
      expect(mockSent).toHaveLength(0);
    });
  });

  // ── T ────────────────────────────────────────────────────────────────────
  describe('T: the test send', () => {
    test('[TEST] subject through the same transport + headers to the caller; no token, no result row, body logged; works with the switch off', async () => {
      await setSettings({ ...FIRM, marketing_send_enabled: '0' });
      const out = await campaignService.testSendMarketing(pool, { auth: ADMIN, sender: 'news@news.test', subject: 'News for {{contacts.contact_fname}}',
        body: '<p>Hi {{contacts.contact_fname}}</p>', topicKey: 'newsletter', contactId: 2 });
      expect(out).toMatchObject({ sent: true, to: 'fred@firm.test' });
      const o = direct.mock.calls[0][2];
      expect(o.subject).toBe('[TEST] News for Sam');
      expect(o.to).toBe('fred@firm.test');
      expect(o.bulk).toBe(true);
      const testUrl = unsub.urlFor(campaignService.TEST_SEND_TOKEN);
      expect(o.headers).toEqual({ 'List-Unsubscribe': `<${testUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click', 'List-Id': '<newsletter.news.test>' });
      expect(o.reply_to).toBe('office@firm.test');
      expect(o.tags).toBeUndefined();
      expect(o.log_body).toBeUndefined();
      expect(o.html).toContain('data-yc-compliance-footer');
      expect(o.text).toContain(testUrl);
      expect(await q('SELECT COUNT(*) n FROM comm_unsub_tokens')).toEqual([{ n: 0 }]);
      expect(await q('SELECT COUNT(*) n FROM campaign_results')).toEqual([{ n: 0 }]);
      const logs = await logRows(1);
      expect(logs[0].body).toMatch(/Hi Sam/);
      // the placeholder token can never reach the token table
      expect(await unsub.lookupToken(pool, campaignService.TEST_SEND_TOKEN)).toBeNull();
    });

    test('needs campaigns.bulk; refused on a held transport', async () => {
      const base = { sender: 'news@news.test', subject: 'S', body: '<p>b</p>', topicKey: 'newsletter', contactId: 2 };
      await expect(campaignService.testSendMarketing(pool, { auth: STAFF, ...base })).rejects.toMatchObject({ status: 403 });
      await q("UPDATE email_credentials SET held_at = UTC_TIMESTAMP(), held_reason = 'h' WHERE id = 17");
      await expect(campaignService.testSendMarketing(pool, { auth: ADMIN, ...base })).rejects.toMatchObject({ status: 422, code: 'transport_held' });
      expect(mockSent).toHaveLength(0);
    });
  });

  // ── U ────────────────────────────────────────────────────────────────────
  describe('U: token reuse across a definite retry', () => {
    test('a 451 clears the reservation; the retry re-reserves and re-uses the unused token, re-pointed at the new result id', async () => {
      await seedCampaign({ id: 170, contacts: [2] });
      let n = 0;
      mockSendImpl = (o) => {
        n += 1;
        if (n === 1) throw Object.assign(new Error('Temporary service failure'), { code: 'EMESSAGE', responseCode: 451, response: '451 Temporary service failure' });
        return { messageId: '<ok@test>', response: '250 Ok 0100018b5f6a1b2c-aaaaaaaa-0000-0000-0000-000000000000-000000', accepted: [o.to], rejected: [] };
      };
      await expect(send(170, 2, { attempt: 1 })).rejects.toMatchObject({ responseCode: 451 });
      expect(await row(170, 2)).toBeUndefined();
      const [t1] = await tokens(170);
      expect(await send(170, 2, { attempt: 2 })).toMatchObject({ sent: true });
      const r = await row(170, 2);
      const all = await tokens(170);
      expect(all).toHaveLength(1);
      expect(all[0].token).toBe(t1.token);
      expect(all[0].send_ref).toBe(String(r.result_id));
      expect(direct.mock.calls[1][2].headers['List-Unsubscribe']).toBe(`<${unsub.urlFor(t1.token)}>`);
    });

    test('the repoint re-checks used_at: a token POSTed between the lookup and the repoint is left alone and a fresh one is minted', async () => {
      await seedCampaign({ id: 171, contacts: [2] });
      const first = await unsub.mintOrReuseUnsubToken(pool, { destination: 'sam@example.com', topicKey: 'newsletter', campaignId: 171, contactId: 2, sendRef: '1' });
      expect(first.reused).toBe(false);
      // a wrapper that marks the token used right after the reuse lookup answers (the race window)
      const racing = { query: async (sql, p) => {
        const r = await pool.query(sql, p);
        if (sql === unsub.UNSUB_SQL.reusable) await pool.query('UPDATE comm_unsub_tokens SET used_at = NOW() WHERE token = ?', [first.token]);
        return r;
      } };
      const second = await unsub.mintOrReuseUnsubToken(racing, { destination: 'sam@example.com', topicKey: 'newsletter', campaignId: 171, contactId: 2, sendRef: '2' });
      expect(second.reused).toBe(false);
      expect(second.token).not.toBe(first.token);
      const rows = await tokens(171);
      expect(rows.map((t) => [t.token, t.send_ref]).sort()).toEqual([[first.token, '1'], [second.token, '2']].sort());
    });
  });

  // ── X (review round 1) ───────────────────────────────────────────────────
  describe('X: round-1 review fixes', () => {
    test('a throw after RESERVE (the token mint deadlocks) clears the reservation: nothing left sending, nothing sent, the retry sends', async () => {
      await seedCampaign({ id: 180, contacts: [2] });
      const spy = jest.spyOn(unsub, 'mintOrReuseUnsubToken').mockRejectedValueOnce(Object.assign(new Error('Deadlock found when trying to get lock'), { code: 'ER_LOCK_DEADLOCK', sqlState: '40001' }));
      await expect(send(180, 2, { attempt: 1 })).rejects.toMatchObject({ code: 'ER_LOCK_DEADLOCK' });
      expect(await row(180, 2)).toBeUndefined();
      expect(await q("SELECT COUNT(*) n FROM campaign_results WHERE status = 'sending'")).toEqual([{ n: 0 }]);
      expect(mockSent).toHaveLength(0);
      spy.mockRestore();
      expect(await send(180, 2, { attempt: 2 })).toMatchObject({ sent: true });
      expect((await row(180, 2)).status).toBe('sent');
      expect(mockSent).toHaveLength(1);
    });

    test('the snapshot is write-once: a second (stale-read) first send does not overwrite it', async () => {
      await seedCampaign({ id: 181, contacts: [2] });
      const [[c]] = await pool.query('SELECT * FROM campaigns WHERE campaign_id = 181');
      const a = await campaignService.ensureSendSnapshot(pool, c);
      await ON({ firm_name: 'Racing Firm' });
      const b = await campaignService.ensureSendSnapshot(pool, { ...c, send_snapshot: null });   // read before the first write landed
      expect(b.snapshot).toEqual(a.snapshot);
      expect(b.snapshot.firm.name).toBe('Smith & Jones Law');
      expect((await camp(181)).send_snapshot.firm.name).toBe('Smith & Jones Law');
    });

    test('a live topic flipped to opt_out mid-send puts the advertisement label back (snapshot said opt_in)', async () => {
      await seedCampaign({ id: 182, topic: 'vip', contacts: [2, 3] });
      for (const d of ['sam@example.com', 'ann@example.com']) {
        await withTransaction(pool, (conn) => optout.recordConsent(conn, { channel: 'email', destination: d, scope: 'vip', action: 'opt_in', source: 'staff' }));
      }
      await send(182, 2);
      expect(direct.mock.calls[0][2].html).not.toMatch(/>Advertisement</);
      await q("UPDATE comm_topics SET consent_model = 'opt_out' WHERE topic_key = 'vip'");
      try {
        await send(182, 3);
        expect(direct.mock.calls[1][2].html).toMatch(/>Advertisement</);
        expect((await camp(182)).send_snapshot.topic.consent_model).toBe('opt_in');
      } finally {
        await q("UPDATE comm_topics SET consent_model = 'opt_in' WHERE topic_key = 'vip'");
      }
    });

    test('an attachment goes out ONCE — marketing and an operational smtp send', async () => {
      const url = 'https://storage.googleapis.com/uploads.test/flyer.pdf';
      await seedCampaign({ id: 183, contacts: [2] });
      await q('UPDATE campaigns SET attachment_url = ? WHERE campaign_id = 183', [url]);
      await seedCampaign({ id: 184, klass: 'operational', sender: 'ops@firm.test', contacts: [2] });
      await q('UPDATE campaigns SET attachment_url = ? WHERE campaign_id = 184', [url]);
      expect(await send(183, 2)).toMatchObject({ sent: true });
      expect(await send(184, 2)).toMatchObject({ sent: true });
      expect(mockSent).toHaveLength(2);
      for (const m of mockSent) expect(m.attachments).toEqual([{ filename: 'flyer.pdf', path: url }]);
    });

    test('createCampaign refuses an email attachment that is not https:// (a local path, http, file:)', async () => {
      const base = { type: 'email', sender: 'ops@firm.test', subject: 'S', body: '<p>b</p>', contactIds: [2], createdBy: 6, auth: ADMIN };
      for (const u of ['/proc/self/environ', 'file:///etc/passwd', 'http://x.test/a.pdf']) {
        await expect(campaignService.createCampaign(pool, { ...base, attachmentUrl: u })).rejects.toMatchObject({ status: 400, code: 'bad_attachment_url' });
      }
      expect(await q('SELECT COUNT(*) n FROM campaigns')).toEqual([{ n: 0 }]);
      const ok = await campaignService.createCampaign(pool, { ...base, attachmentUrl: 'https://storage.googleapis.com/uploads.test/a.pdf' });
      expect(ok.campaignId).toBeGreaterThan(0);
    });

    test('the test send refuses a non-https attachment (nothing sent) and sends an https one ONCE', async () => {
      const base = { auth: ADMIN, sender: 'news@news.test', subject: 'S', body: '<p>b</p>', topicKey: 'newsletter', contactId: 2 };
      await expect(campaignService.testSendMarketing(pool, { ...base, attachmentUrl: '/proc/self/environ' })).rejects.toMatchObject({ status: 400, code: 'bad_attachment_url' });
      expect(mockSent).toHaveLength(0);
      await campaignService.testSendMarketing(pool, { ...base, attachmentUrl: 'https://storage.googleapis.com/uploads.test/a.pdf' });
      expect(mockSent).toHaveLength(1);
      expect(mockSent[0].attachments).toEqual([{ filename: 'a.pdf', path: 'https://storage.googleapis.com/uploads.test/a.pdf' }]);
    });

    test('a re-hold after a same-day release raises its own error alert', async () => {
      await q("UPDATE email_credentials SET held_at = '2026-11-04 10:00:00', held_reason = 'first' WHERE id = 17");
      await seedCampaign({ id: 185, contacts: [2] });
      await send(185, 2);
      await campaignService.releaseTransport(pool, 17, { auth: ADMIN });
      await q("UPDATE email_credentials SET held_at = '2026-11-04 11:00:00', held_reason = 'second' WHERE id = 17");
      await seedCampaign({ id: 186, contacts: [2] });
      await send(186, 2);
      expect(await q("SELECT COUNT(*) n FROM system_alerts WHERE kind = 'mail_transport_held'")).toEqual([{ n: 2 }]);
    });
  });
});
