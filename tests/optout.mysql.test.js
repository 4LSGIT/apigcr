// tests/optout.mysql.test.js
//
/**
 * Recipient opt-out (ruling 2026-10-27) on REAL MySQL 8.4: the one consent
 * reader (services/optoutService.js) and every automation path that leans on
 * it — the send_* / forward_as_* internal functions, request_decision, the
 * workflow engine (advanceWorkflow end to end), the sequence engine
 * (executeStep), and campaigns (preview filter + per-contact send). Nothing
 * under test is mocked; only lib/taskQueue's Cloud Tasks doorbell is.
 *
 * NOTHING CAN SEND. The provider seams (phoneService.sendSms / sendMms,
 * emailService.sendEmail) are spied to record and resolve, and BELOW them
 * global.fetch and nodemailer.createTransport are replaced by recorders that
 * refuse — afterAll asserts neither was ever reached.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3377/yc_optout_test npx jest tests/optout.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates the
 * tables below in it, cloned line-by-line from ref/database.sql. Never point
 * it at port 3306 (the production proxy).
 */
'use strict';

const escaped = { fetch: [], smtp: [] };
jest.mock('nodemailer', () => {
  const actual = jest.requireActual('nodemailer');
  return { ...actual, createTransport: jest.fn(() => { escaped.smtp.push('createTransport'); throw new Error('test: SMTP is unreachable'); }) };
});
jest.mock('../lib/taskQueue', () => ({
  ...jest.requireActual('../lib/taskQueue'),
  enqueueJobDispatch: jest.fn(async () => true),
}));

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const realFetch = global.fetch;
global.fetch = async (url) => { escaped.fetch.push(String(url)); throw new Error('test: the network is unreachable'); };

const { withTransaction } = require('../lib/withTransaction');
const optout = require('../services/optoutService');
const phoneService = require('../services/phoneService');
const emailService = require('../services/emailService');
const fns = require('../lib/internal_functions');
const { advanceWorkflow } = require('../lib/workflow_engine');
const seq = require('../lib/sequenceEngine');
const campaignService = require('../services/campaignService');
const apptService = require('../services/apptService');
const booking = require('../routes/booking');
const manage = require('../routes/manage');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['contacts', 'contact_phones', 'contact_emails',
  'workflows', 'workflow_steps', 'workflow_executions', 'workflow_execution_steps',
  'sequence_templates', 'sequence_template_versions', 'sequence_steps', 'sequence_enrollments', 'sequence_step_log',
  'scheduled_jobs', 'campaigns', 'campaign_contacts', 'campaign_results', 'decision_requests', 'app_settings'];

// Line-based extraction (column COMMENTs may hold ';'); constraint clauses
// naming a table outside TABLES are dropped — this suite tests predicates.
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
        const head = buf[0];
        const clauses = buf.slice(1).map((l) => l.replace(/[,;]\s*$/, ''))
          .filter((l) => { const m = /REFERENCES `([a-z_]+)`/.exec(l); return !m || tables.includes(m[1]); });
        if (clauses.length) alters.push(`${head}\n${clauses.join(',\n')};`);
      }
    }
  }
  if (creates.length !== tables.length) throw new Error(`schema extraction found ${creates.length} CREATE blocks of ${tables.length}`);
  alters.sort((a, b) => /FOREIGN KEY/.test(a) - /FOREIGN KEY/.test(b));
  return { creates, alters };
}

// Contacts: 1 Pat (opted-out mobile + opted-out mixed-case email), 2 Sam
// (consenting phone/email, but the RETIRED contact-level flags set), 3 Old
// (an ENDED opted-out row whose number/address now belongs to 4 New, active
// and consenting).
const PAT_PHONE = '3135550001';
const SAM_PHONE = '3135550002';
const SHARED_PHONE = '3135550003';

d('opt-out on real MySQL', () => {
  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  let sent;

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    if (new URL(URL_).port === '3306') throw new Error('refusing to run against the production proxy port');
    pool = mysql.createPool({ uri: URL_, connectionLimit: 4, timezone: 'Z' });
    pool.on('connection', (conn) => conn.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    pool.withTransaction = (fn, opts) => withTransaction(pool, fn, opts);
    await q('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of [...TABLES].reverse()) await q(`DROP TABLE IF EXISTS \`${t}\``);
    await q('SET FOREIGN_KEY_CHECKS = 1');
    const { creates, alters } = schemaFor(TABLES);
    for (const sql of creates) await q(sql);
    for (const sql of alters) await q(sql);

    await q(`INSERT INTO contacts (contact_id, contact_name, contact_fname, contact_lname, contact_phone, contact_email, contact_sms_optout, contact_email_optout) VALUES
      (1, 'Pat One', 'Pat', 'One', '${PAT_PHONE}', 'pat@example.com', 0, 0),
      (2, 'Sam Two', 'Sam', 'Two', '${SAM_PHONE}', 'sam@example.com', 1, 1),
      (3, 'Old Owner', 'Old', 'Owner', '', '', 0, 0),
      (4, 'New Owner', 'New', 'Owner', '${SHARED_PHONE}', 'shared@example.com', 0, 0)`);
    await q(`INSERT INTO contact_phones (id, contact_id, phone, label, is_primary, sms_optout, end_date) VALUES
      (11, 1, '${PAT_PHONE}', 'Mobile', 1, 1, NULL),
      (12, 2, '${SAM_PHONE}', 'Mobile', 1, 0, NULL),
      (13, 3, '${SHARED_PHONE}', 'Mobile', 0, 1, '2026-01-31'),
      (14, 4, '${SHARED_PHONE}', 'Mobile', 1, 0, NULL)`);
    await q(`INSERT INTO contact_emails (id, contact_id, email, label, is_primary, email_optout, end_date) VALUES
      (21, 1, 'Pat@Example.com', 'Personal', 1, 1, NULL),
      (22, 2, 'sam@example.com', 'Personal', 1, 0, NULL),
      (23, 3, 'shared@example.com', 'Personal', 0, 1, '2026-01-31'),
      (24, 4, 'shared@example.com', 'Personal', 1, 0, NULL)`);
    await q("INSERT INTO app_settings (`key`, `value`) VALUES ('sms_default_from', '2485550000'), ('email_default_from', 'firm@firm.test')");
  });

  beforeEach(() => {
    sent = [];
    jest.spyOn(phoneService, 'sendSms').mockImplementation(async (db, from, to, message) => { sent.push({ kind: 'sms', to }); return { id: 'p1' }; });
    jest.spyOn(phoneService, 'sendMms').mockImplementation(async (db, from, to) => { sent.push({ kind: 'mms', to }); return { id: 'p2' }; });
    jest.spyOn(emailService, 'sendEmail').mockImplementation(async (db, o) => { sent.push({ kind: 'email', to: o.to }); return { messageId: '<m1>' }; });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    global.fetch = realFetch;
    if (pool) await pool.end();
    // Below the spied seams: nothing ever reached the network or an SMTP relay.
    expect(escaped).toEqual({ fetch: [], smtp: [] });
  });

  // ───────────────────────────────────────────────────────────────────────
  describe('the rule: the destination\'s ACTIVE row carries the flag', () => {
    test('a number in any common format maps to its 10-digit row; the shape is typed (mysql2 ints, not strings)', async () => {
      for (const dest of [PAT_PHONE, '+1 (313) 555-0001', '13135550001', '313.555.0001', ['3135550001']]) {
        expect(await optout.findOptedOut(pool, 'sms', dest))
          .toEqual([{ channel: 'sms', destination: PAT_PHONE, contact_id: 1, contact_name: 'Pat One', row_id: 11 }]);
      }
      expect(await optout.findOptedOut(pool, 'mms', PAT_PHONE)).toHaveLength(1);
      expect(await optout.findOptedOut(pool, 'sms', '555-0001')).toEqual([]);       // not 10 digits — no row can match
      expect(await optout.findOptedOut(pool, 'sms', SAM_PHONE)).toEqual([]);        // consenting row
      expect(await optout.findOptedOut(pool, 'sms', '')).toEqual([]);
      expect(await optout.findOptedOut(pool, 'sms', null)).toEqual([]);
    });

    test('an ENDED opted-out row is history: the number\'s current (active, consenting) owner rules', async () => {
      expect(await optout.findOptedOut(pool, 'sms', SHARED_PHONE)).toEqual([]);
      expect(await optout.findOptedOut(pool, 'email', 'shared@example.com')).toEqual([]);
    });

    test('email: case-insensitive on the column\'s collation; every address in a list / "Name <a>" form / array / {email}', async () => {
      const pat = [{ channel: 'email', destination: 'pat@example.com', contact_id: 1, contact_name: 'Pat One', row_id: 21 }];
      for (const dest of ['pat@example.com', 'PAT@EXAMPLE.COM', ' Pat <pat@example.com> ', 'sam@example.com, pat@example.com',
        'sam@example.com;pat@example.com', ['sam@example.com', 'pat@example.com'], [{ email: 'pat@example.com', name: 'P' }]]) {
        expect(await optout.findOptedOut(pool, 'email', dest)).toEqual(pat);
      }
      expect(await optout.findOptedOut(pool, 'email', 'sam@example.com')).toEqual([]);
      expect(await optout.findOptedOut(pool, 'email', 'not-an-address')).toEqual([]);
    });

    test('the retired contact-level columns are never consent', async () => {
      // Sam's contacts.contact_sms_optout / contact_email_optout are 1; his rows consent.
      expect(await optout.findOptedOut(pool, 'sms', SAM_PHONE)).toEqual([]);
      expect(await optout.findOptedOut(pool, 'email', 'sam@example.com')).toEqual([]);
    });

    test('the SQL-predicate twins agree with findOptedOut on the engine', async () => {
      const rows = await q(`SELECT c.contact_id,
          ${optout.smsOptedOutSql('c.contact_phone')} AS s, ${optout.emailOptedOutSql('c.contact_email')} AS e
        FROM contacts c ORDER BY c.contact_id`);
      expect(rows.map((r) => [r.contact_id, Number(r.s), Number(r.e)])).toEqual([[1, 1, 1], [2, 0, 0], [3, 0, 0], [4, 0, 0]]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  describe('automation senders refuse (internal functions)', () => {
    const SMS = { from: '2485550000', message: 'hi' };
    const MAIL = { from: 'firm@firm.test', subject: 's', text: 't' };
    const EV = { type: 'sms', from: '2485551111', to: '2485550000', message: 'fwd me', direction: 'incoming' };

    test.each([
      ['send_sms', { ...SMS, to: '+13135550001' }, 'sms'],
      ['send_mms', { ...SMS, to: PAT_PHONE, attachment_url: 'https://x.test/a.png' }, 'sms'],
      ['send_email', { ...MAIL, to: 'Sam <sam@example.com>, PAT@example.com' }, 'email'],
      ['forward_as_sms', { from: '2485550000', to: PAT_PHONE, event: EV }, 'sms'],
      ['forward_as_email', { from: 'firm@firm.test', to: 'pat@example.com', event: EV }, 'email'],
    ])('%s to an opted-out recipient throws an OptOutRefusal and sends nothing', async (name, params, channel) => {
      const err = await fns[name](params, pool).then(() => null, (e) => e);
      expect(err).toBeInstanceOf(optout.OptOutRefusal);
      expect(err).toMatchObject({ code: 'RECIPIENT_OPTED_OUT', channel, recipients: [expect.objectContaining({ contact_id: 1 })] });
      expect(err.message).toMatch(/^Not sent — Pat One .*\(contact #1\) has opted out of (texts|email)\./);
      expect(sent).toEqual([]);
    });

    test.each([
      ['send_sms', { ...SMS, to: SAM_PHONE }, 'sms'],
      ['send_mms', { ...SMS, to: SHARED_PHONE, attachment_url: 'https://x.test/a.png' }, 'mms'],
      ['send_email', { ...MAIL, to: 'sam@example.com' }, 'email'],
      ['forward_as_sms', { from: '2485550000', to: SAM_PHONE, event: EV }, 'sms'],
      ['forward_as_email', { from: 'firm@firm.test', to: 'shared@example.com', event: EV }, 'email'],
    ])('%s to a consenting recipient reaches the provider seam', async (name, params, kind) => {
      await expect(fns[name](params, pool)).resolves.toMatchObject({ success: true });
      expect(sent.map((s) => s.kind)).toEqual([kind]);
    });

    test('request_decision: an opted-out channel is undeliverable (a failure note), the other channel still goes', async () => {
      const out = await fns.request_decision({
        _execution_id: 77, _step_number: 2, question: 'Pick one', options: [{ label: 'A', value: 'a' }],
        result_var: 'pick', timeout: '1h', timeout_value: 'none', recipient_kind: 'raw',
        recipient_email: 'pat@example.com', recipient_phone: SAM_PHONE, send_email: true, send_sms: true,
        email_from: 'firm@firm.test', sms_from: '2485550000',
      }, pool);
      expect(out.output.delivered).toEqual(['sms']);
      expect(out.output.failures).toEqual([expect.stringMatching(/^email: Not sent — Pat One .*opted out of email/)]);
      expect(sent).toEqual([{ kind: 'sms', to: SAM_PHONE }]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  describe('the workflow engine records a refused send as SKIPPED and runs on', () => {
    let wfSeq = 100;
    async function runWorkflow(steps) {
      const wf = ++wfSeq;
      await q('INSERT INTO workflows (id, name, current_version) VALUES (?, ?, 1)', [wf, `wf ${wf}`]);
      let n = 0;
      for (const s of steps) {
        n++;
        await q('INSERT INTO workflow_steps (id, workflow_id, step_number, type, config, error_policy, version) VALUES (?, ?, ?, ?, ?, ?, 1)',
          [wf * 10 + n, wf, n, 'internal_function', JSON.stringify(s.config), s.policy ? JSON.stringify(s.policy) : null]);
      }
      const r = await q("INSERT INTO workflow_executions (workflow_id, status, init_data, variables, current_step_number, workflow_version) VALUES (?, 'active', '{}', '{}', 1, 1)", [wf]);
      const t0 = Date.now();
      const out = await advanceWorkflow(r.insertId, pool);
      const ms = Date.now() - t0;
      const rows = await q('SELECT step_number, status, error_message FROM workflow_execution_steps WHERE workflow_execution_id = ? ORDER BY id', [r.insertId]);
      const [ex] = await q('SELECT status FROM workflow_executions WHERE id = ?', [r.insertId]);
      return { out, rows, status: ex.status, ms };
    }
    const smsTo = (to) => ({ function_name: 'send_sms', params: { from: '2485550000', to, message: 'Hi {{x}}' } });

    test('abort + retry policy: the opted-out step is "skipped" with the reason, never retried, never "failed"; the run completes', async () => {
      const r = await runWorkflow([
        { config: smsTo(PAT_PHONE), policy: { strategy: 'retry_then_abort', max_retries: 3, backoff_seconds: 5 } },
        { config: { function_name: 'send_email', params: { from: 'firm@firm.test', to: 'sam@example.com', subject: 's', text: 't' } } },
      ]);
      expect(r.rows).toEqual([
        { step_number: 1, status: 'skipped', error_message: expect.stringMatching(/^Not sent — Pat One \(313\) 555-0001 \(contact #1\) has opted out of texts/) },
        { step_number: 2, status: 'success', error_message: null },
      ]);
      expect(r.status).toBe('completed');                 // not completed_with_errors, not failed
      expect(r.ms).toBeLessThan(4000);                     // no 5 s backoff: the refusal is not retried
      expect(sent).toEqual([{ kind: 'email', to: 'sam@example.com' }]);
      // The error sweep reads workflow_execution_steps WHERE status = 'failed' (lib/alerting _scanWorkflows).
      expect((await q("SELECT COUNT(*) AS n FROM workflow_execution_steps WHERE status = 'failed'"))[0].n).toBe(0);
    });

    test('control: a real failure keeps its policy — abort fails the run (the skip is specific to opt-out)', async () => {
      const r = await runWorkflow([
        { config: { function_name: 'send_sms', params: { from: '2485550000', to: SAM_PHONE } }, policy: { strategy: 'abort' } }, // no message → throws
        { config: smsTo(SAM_PHONE) },
      ]);
      expect(r.rows).toEqual([{ step_number: 1, status: 'failed', error_message: 'send_sms requires message' }]);
      expect(r.status).toBe('failed');
      await q("DELETE FROM workflow_execution_steps WHERE status = 'failed'");
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  describe('the sequence engine logs skipped / recipient_opted_out and advances', () => {
    let tplSeq = 200;
    async function enroll(step1, policy) {
      const tpl = ++tplSeq;
      await q('INSERT INTO sequence_templates (id, name, type, current_version) VALUES (?, ?, ?, 1)', [tpl, `seq ${tpl}`, 'optout_test']);
      await q('INSERT INTO sequence_template_versions (template_id, version, name, type, published_at) VALUES (?, 1, ?, ?, NOW())', [tpl, `seq ${tpl}`, 'optout_test']);
      const immediate = JSON.stringify({ type: 'immediate' });
      await q('INSERT INTO sequence_steps (id, template_id, step_number, action_type, action_config, timing, error_policy, version) VALUES (?, ?, 1, ?, ?, ?, ?, 1)',
        [tpl * 10 + 1, tpl, 'internal_function', JSON.stringify(step1), immediate, policy ? JSON.stringify(policy) : null]);
      await q('INSERT INTO sequence_steps (id, template_id, step_number, action_type, action_config, timing, version) VALUES (?, ?, 2, ?, ?, ?, 1)',
        [tpl * 10 + 2, tpl, 'internal_function', JSON.stringify({ function_name: 'noop', params: {} }), immediate]);
      const r = await q("INSERT INTO sequence_enrollments (template_id, contact_id, trigger_data, status, current_step, total_steps, template_version) VALUES (?, 1, '{}', 'active', 1, 2, 1)", [tpl]);
      return { enrollmentId: r.insertId, stepId: tpl * 10 + 1 };
    }

    test('abort + retries: skipped with the machine reason AND the readable text; no retry; the enrollment lives and step 2 is scheduled', async () => {
      const { enrollmentId, stepId } = await enroll(
        { function_name: 'send_sms', params: { from: '2485550000', to: '{{contacts.contact_phone}}', message: 'Hi {{contacts.contact_fname}}' } },
        { strategy: 'retry_then_abort', max_retries: 3, backoff_seconds: 5 });
      const t0 = Date.now();
      const out = await seq.executeStep(pool, enrollmentId, stepId, 1);
      expect(Date.now() - t0).toBeLessThan(4000);
      expect(out).toEqual({ status: 'skipped', reason: 'recipient_opted_out' });
      expect(seq.RECIPIENT_OPTED_OUT).toBe('recipient_opted_out');
      const logs = await q('SELECT step_number, status, skip_reason, error_message FROM sequence_step_log WHERE enrollment_id = ? ORDER BY id', [enrollmentId]);
      expect(logs).toEqual([{ step_number: 1, status: 'skipped', skip_reason: 'recipient_opted_out',
        error_message: expect.stringMatching(/^Not sent — Pat One \(313\) 555-0001 \(contact #1\) has opted out of texts/) }]);
      const [en] = await q('SELECT status, current_step FROM sequence_enrollments WHERE id = ?', [enrollmentId]);
      expect(en).toEqual({ status: 'active', current_step: 2 });   // abort did NOT cancel it
      const jobs = await q("SELECT JSON_EXTRACT(data, '$.stepNumber') AS n FROM scheduled_jobs WHERE sequence_enrollment_id = ?", [enrollmentId]);
      expect(jobs.map((j) => Number(j.n))).toEqual([2]);
      expect(sent).toEqual([]);
      // The error sweep reads sequence_step_log WHERE status = 'failed' (lib/alerting _scanSequences).
      expect((await q("SELECT COUNT(*) AS n FROM sequence_step_log WHERE status = 'failed'"))[0].n).toBe(0);
    });

    test('control: the same step to a consenting address is sent', async () => {
      const { enrollmentId, stepId } = await enroll(
        { function_name: 'send_email', params: { from: 'firm@firm.test', to: 'sam@example.com', subject: 's', text: 't' } }, null);
      expect(await seq.executeStep(pool, enrollmentId, stepId, 1)).toMatchObject({ status: 'sent' });
      expect(sent).toEqual([{ kind: 'email', to: 'sam@example.com' }]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  describe('campaigns read the row flag, never the contact-level columns', () => {
    test('preview: Pat (row opt-out) is excluded; Sam (contact-level flags only) is NOT', async () => {
      const sms = await campaignService.getFilteredContacts(pool, { channel: 'sms' });
      expect(sms.contacts.map((c) => c.contact_id).sort()).toEqual([2, 4]);
      expect(sms).toMatchObject({ total: 4, excluded: 2 });          // Pat opted out, Old has no phone
      const email = await campaignService.getFilteredContacts(pool, { channel: 'email' });
      expect(email.contacts.map((c) => c.contact_id).sort()).toEqual([2, 4]);
    });

    test('send: an opted-out destination is recorded skipped (sms_optout / email_optout); a consenting one sends', async () => {
      await q(`INSERT INTO campaigns (campaign_id, type, sender, subject, body, status) VALUES
        (1, 'sms', '2485550000', NULL, 'Hi {{contacts.contact_fname}}', 'sending'),
        (2, 'email', 'firm@firm.test', 'S', '<p>Hi</p>', 'sending')`);
      await q('INSERT INTO campaign_contacts (campaign_id, contact_id) VALUES (1, 1), (1, 2), (2, 1), (2, 2)');
      expect(await campaignService.executeSend(pool, 1, 1)).toEqual({ skipped: true, reason: 'sms_optout' });
      expect(await campaignService.executeSend(pool, 1, 2)).toMatchObject({ sent: true });
      expect(await campaignService.executeSend(pool, 2, 1)).toEqual({ skipped: true, reason: 'email_optout' });
      expect(await campaignService.executeSend(pool, 2, 2)).toMatchObject({ sent: true });
      expect(sent).toEqual([{ kind: 'sms', to: SAM_PHONE }, { kind: 'email', to: 'sam@example.com' }]);
      const res = await q('SELECT campaign_id, contact_id, status FROM campaign_results ORDER BY campaign_id, contact_id');
      expect(res).toEqual([
        { campaign_id: 1, contact_id: 1, status: 'skipped' }, { campaign_id: 1, contact_id: 2, status: 'sent' },
        { campaign_id: 2, contact_id: 1, status: 'skipped' }, { campaign_id: 2, contact_id: 2, status: 'sent' },
      ]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  describe('automated confirmations skip an opted-out channel (logged, never alerted)', () => {
    const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

    test('appointment confirmation: Pat\'s opted-out SMS and email are skipped; Sam (contact-level flags only) gets both', async () => {
      await apptService._sendApptConfirmation(pool, { contactId: 1, apptId: 5, sms: true, email: true, message: 'See you soon' });
      await settle();
      expect(sent).toEqual([]);
      await apptService._sendApptConfirmation(pool, { contactId: 2, apptId: 6, sms: true, email: true, message: 'See you soon' });
      await settle();
      expect(sent).toEqual([{ kind: 'sms', to: SAM_PHONE }, { kind: 'email', to: 'sam@example.com' }]);
    });

    test('booking-page confirmation: the same skip per channel', async () => {
      const view = { slug: 'v', title: 'Book', confirm_template: 'Booked', confirm_sms: 1, confirm_email: 1 };
      booking._test.fireSideEffects(pool, view, { apptId: 5, contactId: 1, providerId: 0, start: '10:00' });
      await settle();
      expect(sent).toEqual([]);
      booking._test.fireSideEffects(pool, view, { apptId: 6, contactId: 4, providerId: 0, start: '10:00' });
      await settle();
      expect(sent).toEqual([{ kind: 'sms', to: SHARED_PHONE }, { kind: 'email', to: 'shared@example.com' }]);
    });

    test('manage-page cancel / reschedule text: skipped for an opted-out number', async () => {
      manage._test.fireManageSms(pool, 'Cancelled', { contactId: 1, apptId: 5, kind: 'cancel' });
      await settle();
      expect(sent).toEqual([]);
      manage._test.fireManageSms(pool, 'Cancelled', { contactId: 2, apptId: 6, kind: 'cancel' });
      await settle();
      expect(sent).toEqual([{ kind: 'sms', to: SAM_PHONE }]);
    });
  });
});
