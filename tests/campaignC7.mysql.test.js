// tests/campaignC7.mysql.test.js
//
/**
 * YisraMail C7 — triggered promotional sends on REAL MySQL
 * (ref/YISRAMAIL_DESIGN.md §6.4 "As built (C7)", §9 row C7):
 *   P  sendPromotional end to end — REAL emailService.sendEmailDirect + the
 *      smtp adapter; nodemailer's transport is a recorder: the footer and the
 *      unsubscribe URL in the html AND the text, the three marketing headers,
 *      the Reply-To, from = the bulk transport, a REAL token row
 *      (campaign_id NULL, contact attributed, send_ref NULL), the email_log
 *      row WITH the body (no campaign snapshot — the log is the record)
 *   K  the kill switch: not '1' → 422 marketing_disabled, nothing sent
 *   O  consent: an opted-out recipient → { sent:false, skipped:'opted_out' },
 *      no token, no provider call; an opt_in topic without opted_in state
 *      skips the same way
 *   S  sender resolution: named non-bulk sender refused; no sender → the ONLY
 *      bulk row; two bulk rows + no sender → ambiguous_sender; held → 422
 *   F  the send_email internal function: promotional + design_id sends the
 *      design with the footer AT ITS SLOT and merge tags resolved;
 *      OPERATIONAL + design_id resolves tags, adds NO footer, and reaches an
 *      opted-out recipient (D18 — operational email asks no consent);
 *      archived design refused; promotional without topic refused;
 *      design_id without contact_id refused; sms promotional refused (D1)
 *
 * NOTHING CAN SEND: nodemailer.createTransport returns a recorder (no
 * socket); fetch refuses.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3321/yc_c7_test npx jest tests/campaignC7.mysql.test.js --runInBand
 * Its OWN *_test DB family: it drops and rebuilds every table it touches.
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
        return { messageId: `<m${mockSent.length}@test>`, response: `250 Ok 0100018b5f6a1b2c-abcdefab-0000-0000-0000-00000000000${mockSent.length % 10}-000000`, accepted: [o.to], rejected: [] };
      },
    })),
  };
});
jest.mock('../lib/taskQueue', () => {
  const actual = jest.requireActual('../lib/taskQueue');
  return { ...actual, enqueueJobDispatch: jest.fn(async () => true) };
});
global.fetch = async (url) => { throw new Error(`test: network is unreachable (${url})`); };

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

const TABLES = ['campaigns', 'campaign_contacts', 'campaign_results', 'contacts', 'contact_phones', 'contact_emails',
  'app_settings', 'email_credentials', 'users', 'comm_unsub_tokens', 'email_log', 'system_alerts', 'alert_state',
  'scheduled_jobs', 'job_results', 'admin_audit_log'];

d('C7 triggered promotional sends on real MySQL', () => {
  const mysql = require('mysql2/promise');
  const schema = require('./helpers/commsArchiveSchema');
  const { buildConsentTables } = require('./helpers/consentSchema');
  const { withTransaction } = require('../lib/withTransaction');
  const { encrypt } = require('../lib/credentialCrypto');
  const firmConfig = require('../lib/firmConfig');
  const c1Migrate = require('../scripts/yisramailC1Migrate');
  const c2Migrate = require('../scripts/yisramailC2Migrate');
  const c3Migrate = require('../scripts/yisramailC3Migrate');
  const c4Migrate = require('../scripts/yisramailC4Migrate');
  const campaignService = require('../services/campaignService');
  const optout = require('../services/optoutService');
  const fns = require('../lib/internal_functions');

  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const FIRM = {
    firm_name: 'Smith & Jones Law', firm_address: '["100 Main St., #2","Springfield, MI 48000"]',
    'fe-firm_phone': '2485550100', firm_attorney_name: 'Ann Smith', firm_email: 'office@firm.test',
  };

  async function setSettings(map) {
    await q('DELETE FROM app_settings');
    for (const [k, v] of Object.entries(map)) await q('INSERT INTO app_settings (`key`, `value`) VALUES (?, ?)', [k, v]);
    firmConfig._test({ db: pool, resetCache: true });
    await firmConfig.prime();
  }
  const ON = (extra = {}) => setSettings({ marketing_send_enabled: '1', app_url: 'https://app.firm.test', ...FIRM, ...extra });
  const optOut = (dest) => optout.recordConsent(pool, {
    channel: 'email', destination: dest, scope: 'marketing', action: 'opt_out', source: 'one_click',
    contactId: null, sendRef: null, evidence: { via: 'twin-seed' },
  });
  const tokens = () => q('SELECT token, campaign_id, contact_id, send_ref, destination, topic_key FROM comm_unsub_tokens ORDER BY created_at, token');
  const send = (over = {}) => campaignService.sendPromotional(pool, {
    to: 'sam@example.com', subject: 'Happy birthday {{contacts.contact_fname}}!',
    body: '<html><body><p>Dear {{contacts.contact_fname}}, have a great day.</p></body></html>',
    topicKey: 'newsletter', contactId: 2, ...over,
  });

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    if (new URL(URL_).port === '3306') throw new Error('refusing to run against the production proxy port');
    pool = mysql.createPool({ uri: URL_, connectionLimit: 6, timezone: 'Z' });
    pool.on('connection', (c) => c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    pool.withTransaction = (fn, opts) => withTransaction(pool, fn, opts);
    await schema.build(pool, TABLES);
    await buildConsentTables(q);
    await q('DROP TABLE IF EXISTS campaign_segments');
    await q('DROP TABLE IF EXISTS email_designs');   // c3Migrate recreates it — rows must not survive a prior run
    const c = await pool.getConnection();
    try {
      for (const m of [c1Migrate, c2Migrate, c3Migrate, c4Migrate]) {
        expect((await m.run(c, { apply: true, say: () => {} })).ok).toBe(true);
      }
    } finally { c.release(); }
    await q(`INSERT INTO contacts (contact_id, contact_name, contact_fname, contact_lname, contact_phone, contact_email) VALUES
      (1, 'Pat One', 'Pat', 'One', '3135550001', 'pat@example.com'),
      (2, 'Sam Two', 'Sam', 'Two', '3135550002', 'sam@example.com'),
      (3, 'Max & Co <LLC>', 'Max & Co <LLC>', 'Three', '3135550003', 'max@example.com')`);
    await q(`INSERT INTO contact_emails (id, contact_id, email, label, is_primary, email_optout, end_date) VALUES
      (21, 1, 'pat@example.com', 'Personal', 1, 0, NULL), (22, 2, 'sam@example.com', 'Personal', 1, 0, NULL)`);
    await q(`INSERT INTO email_credentials (id, email, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure, provider, from_name, bulk_ok, events_driver, driver_config, signature_html) VALUES
      (4, 'ops@firm.test', 'mail.firm.test', 587, 'ops@firm.test', ?, 0, 'smtp', 'Ops', 0, NULL, NULL, '<p>OPS-SIG</p>'),
      (17, 'news@news.test', 'email-smtp.test', 587, 'AKIA', ?, 0, 'smtp', 'Firm News', 1, 'ses', '{"configuration_set":"yisramail-marketing"}', '<p>SIGNATURE-MUST-NOT-APPEAR</p>')`,
    [encrypt('pw'), encrypt('pw')]);
    const [[news]] = await pool.query("SELECT consent_model, active FROM comm_topics WHERE topic_key = 'newsletter'");
    expect(news).toMatchObject({ consent_model: 'opt_out', active: 1 });
    await q("INSERT INTO comm_topics (topic_key, channel, label, consent_model, active) VALUES ('vip', 'email', 'VIP list', 'opt_in', 1) ON DUPLICATE KEY UPDATE label = VALUES(label)");
    // A Designer-shaped design: the footer slot marker + merge tags in html AND text.
    await q(`INSERT INTO email_designs (id, name, builder, design_json, html, text, archived) VALUES
      (5, 'Birthday card', 'grapesjs-mjml', '{}',
       '<html><body><p>Dear {{contacts.contact_fname}}, happy birthday!</p><div><!-- yc:footer-slot --></div></body></html>',
       'Dear {{contacts.contact_fname}}, happy birthday!', 0),
      (6, 'Old card', 'grapesjs-mjml', '{}', '<html><body><p>Old</p><!-- yc:footer-slot --></body></html>', 'Old', 1)`);
  });

  afterAll(async () => { if (pool) await pool.end(); });

  beforeEach(async () => {
    mockSent.length = 0;
    mockSendImpl = null;
    for (const t of ['comm_unsub_tokens', 'email_log', 'comm_consent_events', 'comm_consent_state', 'system_alerts', 'alert_state']) await q(`DELETE FROM ${t}`);
    await q('UPDATE email_credentials SET held_at = NULL, held_reason = NULL WHERE id = 17');
    await q('UPDATE contact_emails SET email_optout = 0');   // recordConsent dual-writes the row-flag cache (P1)
    await ON();
  });

  // ─── K: the kill switch ────────────────────────────────────

  test("switch not '1' → 422 marketing_disabled, nothing sent, no token", async () => {
    await setSettings({ marketing_send_enabled: '0', app_url: 'https://app.firm.test', ...FIRM });
    await expect(send()).rejects.toMatchObject({ status: 422, code: 'marketing_disabled' });
    expect(mockSent).toHaveLength(0);
    expect(await tokens()).toHaveLength(0);
  });

  // ─── O: consent ────────────────────────────────────────────

  test('an opted-out recipient is SKIPPED — no token, no provider call, the automation goes on', async () => {
    await optOut('sam@example.com');
    const r = await send();
    expect(r).toEqual({ sent: false, skipped: 'opted_out' });
    expect(mockSent).toHaveLength(0);
    expect(await tokens()).toHaveLength(0);
  });

  test('an opt_in topic without opted_in state skips; with it, sends', async () => {
    const r = await send({ topicKey: 'vip' });
    expect(r).toEqual({ sent: false, skipped: 'opted_out' });
    await optout.recordConsent(pool, {
      channel: 'email', destination: 'sam@example.com', scope: 'vip', action: 'opt_in', source: 'pref_page',
      contactId: 2, sendRef: null, evidence: { via: 'twin-seed' }, actor: { kind: 'user', userId: 6 },
    });
    const r2 = await send({ topicKey: 'vip' });
    expect(r2.sent).toBe(true);
  });

  // ─── P: the send itself ────────────────────────────────────

  test('the real thing: token (campaign NULL), footer + unsub URL in html AND text, headers, Reply-To, bulk from, email_log WITH body', async () => {
    // The body carries its OWN unsubscribe anchor (emailDesignRules allows
    // {{send.unsubscribe_url}} in a body) — C6's addNoTrack must tag it, or
    // SES click tracking wraps it and an unsubscribe counts as a click.
    const r = await send({ body: '<html><body><p>Dear {{contacts.contact_fname}}, have a great day.</p>'
      + '<p><a href="{{send.unsubscribe_url}}">stop these</a> · <a href="https://www.4lsg.com/news">our news</a></p></body></html>' });
    expect(r.sent).toBe(true);
    expect(r.to).toBe('sam@example.com');
    expect(r.providerMessageId).toBeTruthy();

    const tk = await tokens();
    expect(tk).toHaveLength(1);
    expect(tk[0]).toMatchObject({ campaign_id: null, contact_id: 2, send_ref: null, destination: 'sam@example.com', topic_key: 'newsletter' });
    const url = `https://app.firm.test/u/${tk[0].token}`;

    expect(mockSent).toHaveLength(1);
    const m = mockSent[0];
    expect(m.from).toContain('news@news.test');
    expect(m.to).toBe('sam@example.com');
    expect(m.subject).toBe('Happy birthday Sam!');
    expect(m.html).toContain('Dear Sam, have a great day.');
    expect(m.html).toContain('data-yc-compliance-footer');
    expect(m.html).toContain(url);
    expect(m.text).toContain(url);
    expect(m.text).toContain('We are a debt relief agency.');
    expect(m.replyTo).toBe('office@firm.test');
    const h = m.headers || {};
    expect(h['List-Unsubscribe']).toBe(`<${url}>`);
    expect(h['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(h['List-Id']).toContain('newsletter.news.test');
    expect(m.html).not.toContain('SIGNATURE-MUST-NOT-APPEAR');
    // C6: the author's unsub anchor AND the footer's two carry ses:no-track;
    // the ordinary body link stays bare for click tracking.
    expect(m.html).toContain(`<a ses:no-track href="${url}">stop these</a>`);
    expect(m.html.match(/ses:no-track/g)).toHaveLength(3);
    expect(m.html).toContain('<a href="https://www.4lsg.com/news">our news</a>');

    // No campaign snapshot exists, so the log keeps the body (MRPC 7.2(b)).
    for (let i = 0; i < 50 && !(await q("SELECT id FROM email_log WHERE source = 'outbound-smtp'")).length; i++) await new Promise((res) => setTimeout(res, 20));
    const [log] = await q("SELECT body, to_email FROM email_log WHERE source = 'outbound-smtp'");
    expect(log.to_email).toBe('sam@example.com');
    expect(String(log.body || '')).toContain('Dear Sam, have a great day.');
  });

  // ─── L: the safety loop for triggered sends ────────────────
  // Triggered sends have NO campaign row, so they are invisible to
  // transportHealth and the digest (ref/plans.md "Triggered-send
  // reporting"). The protection they DO have, end to end: a hard bounce on
  // an UNCORRELATED message (no result_id tag, unknown provider_message_id)
  // still writes the provider_bounce opt-out to the ledger, and the NEXT
  // triggered send to that address is skipped.

  test('an uncorrelated hard bounce suppresses the address: ingest → ledger → the next sendPromotional skips', async () => {
    const mailEvents = require('../services/mailEventService');
    const body = JSON.parse(JSON.stringify(require('./fixtures/ses-events/bounce-permanent.json')));
    body.id = 'c7-loop-evt-1';
    body.detail.mail.messageId = '010f0c7c7c7c7c7c-no-campaign-row-000000';
    delete body.detail.mail.tags.result_id;        // a triggered send carries no campaign tags
    delete body.detail.mail.tags.campaign_id;
    body.detail.bounce.bouncedRecipients = [{ action: 'failed', status: '5.1.1', emailAddress: 'sam@example.com', diagnosticCode: 'smtp; 550 5.1.1 user unknown' }];

    const out = await mailEvents.ingest(pool, body);
    expect(out.ledger.recorded).toBe(1);
    expect(out.updated).toBe(0);                   // nothing correlated — and the ledger wrote anyway
    const [ev] = await q("SELECT source, scope, action, send_ref FROM comm_consent_events WHERE destination = 'sam@example.com'");
    expect(ev).toMatchObject({ source: 'provider_bounce', scope: 'marketing', action: 'opt_out', send_ref: null });

    const r = await send();
    expect(r).toEqual({ sent: false, skipped: 'opted_out' });
    expect(mockSent).toHaveLength(0);
  });

  // ─── S: sender resolution + the hold ───────────────────────

  test('sender rules: non-bulk refused; no sender → the only bulk row; two bulk rows → ambiguous; held → 422', async () => {
    await expect(send({ sender: 'ops@firm.test' })).rejects.toMatchObject({ code: 'marketing_requires_bulk_sender' });
    expect((await send()).sent).toBe(true);   // sole bulk row picked

    await q("INSERT INTO email_credentials (id, email, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure, provider, from_name, bulk_ok) VALUES (18, 'news2@news.test', 'x', 587, 'u', ?, 0, 'smtp', 'Two', 1)", [encrypt('pw')]);
    await expect(send()).rejects.toMatchObject({ code: 'ambiguous_sender' });
    expect((await send({ sender: 'news@news.test' })).sent).toBe(true);
    await q('DELETE FROM email_credentials WHERE id = 18');

    await q("UPDATE email_credentials SET held_at = UTC_TIMESTAMP(3), held_reason = 'complaint rate' WHERE id = 17");
    await expect(send()).rejects.toMatchObject({ status: 422, code: 'transport_held' });
  });

  // ─── F: the send_email internal function ───────────────────

  test('promotional + design_id: the design goes out with merge tags resolved and the footer AT ITS SLOT', async () => {
    const r = await fns.send_email({ to: 'sam@example.com', subject: 'HBD {{contacts.contact_fname}}',
      promotional: 'true', topic: 'newsletter', design_id: 5, contact_id: '2' }, pool);
    expect(r.output.sent).toBe(true);
    const m = mockSent[0];
    expect(m.subject).toBe('HBD Sam');
    expect(m.html).toContain('Dear Sam, happy birthday!');
    // The footer sits where the slot marker was — inside the div, not appended.
    expect(m.html).toMatch(/<div><div data-yc-compliance-footer="1"/);
  });

  test('OPERATIONAL + design_id: tags resolved, NO footer, and it reaches an opted-out recipient (D18)', async () => {
    await optOut('sam@example.com');
    const r = await fns.send_email({ from: 'ops@firm.test', to: 'sam@example.com', subject: 'HBD',
      design_id: 5, contact_id: 2 }, pool);
    expect(r.success).toBe(true);
    expect(mockSent).toHaveLength(1);
    const m = mockSent[0];
    expect(m.html).toContain('Dear Sam, happy birthday!');
    expect(m.text).toContain('Dear Sam, happy birthday!');   // the TEXT part resolves too (review S5/M1)
    expect(m.html).not.toContain('{{');
    expect(m.text).not.toContain('{{');
    expect(m.html).not.toContain('data-yc-compliance-footer');
    expect(m.html).not.toContain('Unsubscribe');
    expect(await tokens()).toHaveLength(0);
  });

  test('operational design values are HTML-ESCAPED into the html part and raw in the text part (review S5/M2)', async () => {
    const r = await fns.send_email({ from: 'ops@firm.test', to: 'max@example.com', subject: 'HBD',
      design_id: 5, contact_id: 3 }, pool);
    expect(r.success).toBe(true);
    const m = mockSent[0];
    expect(m.html).toContain('Dear Max &amp; Co &lt;LLC&gt;, happy birthday!');
    expect(m.html).not.toContain('Max & Co <LLC>');
    expect(m.text).toContain('Dear Max & Co <LLC>, happy birthday!');
  });

  test('a promotional attachment must be https (review N1) — refused before any provider call', async () => {
    await expect(send({ attachmentUrls: 'http://evil.test/x.pdf' })).rejects.toMatchObject({ code: 'bad_attachment_url' });
    expect(mockSent).toHaveLength(0);
  });

  test('an account-level pause HOLDS the transport and fails the step 502 account_paused (review S4)', async () => {
    mockSendImpl = () => { throw Object.assign(new Error('Message rejected: Sending paused for this account. For more information, please check the AWS Support Center.'), { code: 'EMESSAGE', responseCode: 554, response: '554 Message rejected: Sending paused for this account.', command: 'DATA' }); };
    await expect(send()).rejects.toMatchObject({ status: 502, code: 'account_paused' });
    const [[held]] = await pool.query('SELECT held_at, held_reason FROM email_credentials WHERE id = 17');
    expect(held.held_at).not.toBeNull();
    expect(held.held_reason).toContain('account level');
  });

  test('refusals: archived design; promotional without topic; design without contact_id; promotional ignores from but still needs a body; sms promotional (D1)', async () => {
    await expect(fns.send_email({ from: 'ops@firm.test', to: 'sam@example.com', subject: 'x', design_id: 6, contact_id: 2 }, pool))
      .rejects.toThrow(/archived/);
    await expect(fns.send_email({ to: 'sam@example.com', subject: 'x', html: '<p>x</p>', promotional: true, contact_id: 2 }, pool))
      .rejects.toThrow(/requires topic/);
    await expect(fns.send_email({ from: 'ops@firm.test', to: 'sam@example.com', subject: 'x', design_id: 5 }, pool))
      .rejects.toThrow(/contact_id/);
    await expect(fns.send_email({ to: 'sam@example.com', subject: 'x', text: 'plain only', promotional: true, topic: 'newsletter', contact_id: 2 }, pool))
      .rejects.toThrow(/needs html or design_id/);
    await expect(fns.send_sms({ from: '2485559999', to: '3135550002', message: 'hi', promotional: true }, pool))
      .rejects.toThrow(/D1/);
    expect(mockSent).toHaveLength(0);
  });
});
