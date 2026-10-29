// tests/caseyApptConfirm.mysql.test.js
//
/**
 * Ask Casey appointment-card client confirmations on REAL MySQL.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/yc_apptconf_test npx jest tests/caseyApptConfirm.mysql.test.js --runInBand
 * The database must end in _test and hold the REAL schema (load
 * ref/database.sql into it first; a dump older than 2026-10-28 still has
 * appts.appt_length as tinyint — run scripts/apptLengthSmallint.js --apply
 * against it with APPT_LENGTH_DB_URL). This suite deletes and re-seeds rows in
 * users, contacts, contact_phones, contact_emails, appts and app_settings.
 *
 * WHAT IS LOCKED (ruling 15's A14 bar on the appointment cards)
 *   - Shown is sent. The card resolves the confirmation at proposal with the
 *     same resolver the route uses; the browser sends that resolved text; the
 *     route's own non-strict resolve (apptService.sendApptConfirmation, run
 *     here for real with only the two provider calls stubbed) changes NOTHING
 *     but the manage-link placeholder — and the result equals what the route
 *     would have made of the model's raw text against the real stored row.
 *     For create / reschedule the row does not exist at proposal: the card's
 *     own values stand in for it, and this proves they read exactly like the
 *     row mysql2 returns once it is stored (date, length, platform enum).
 *   - The recipient/sender/opt-out reads are the route's own predicates on the
 *     real tables (YisraMail P1: optoutService over the row cache flag AND
 *     comm_consent_state, built here from the migration file): an opted-out
 *     NUMBER refuses (automation sends never acknowledge) — an email opt-out
 *     is marketing-only (D18) and never stops the operational confirmation —
 *     and so does a missing phone/email/sender, a manage link on a
 *     row without a token, and a client-less appointment.
 *   - Off is byte-stable: no flags, no message, no confirmation object.
 */
'use strict';

const mysql = require('mysql2/promise');
const svc = require('../services/assistantService');
const apptService = require('../services/apptService');
const phoneService = require('../services/phoneService');
const emailService = require('../services/emailService');
const resolverService = require('../services/resolverService');
const calendarTypeService = require('../services/calendarTypeService');
const { buildConsentTables } = require('./helpers/consentSchema');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
// Production SESSION sql_mode (verified live 2026-09-25; CLAUDE.md "SQL mode is relaxed").
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TOKEN = 'Ab3dEf6hIj9kLm2nOp5qRs'; // 22-char base62, the lib/token shape
const LINK = '{{appts.appt_manage_token|default:}}';

d('Ask Casey appointment confirmations on real MySQL', () => {
  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const contactEvidence = [{ id: 'q1', kind: 'sql.read', purpose: 'Contact', rows: [{ contact_id: 1309 }] }];
  const apptEvidence = (apptId) => [{ id: 'q1', kind: 'sql.read', purpose: 'Appointment', rows: [{ appt_id: apptId }] }];
  const ref = [{ query_id: 'q1', row_number: 1 }];
  let resolveType;
  let getType;
  let smsSpy;
  let emailSpy;

  const insertAppt = (row) => q(`INSERT INTO appts (appt_id, appt_client_id, appt_case_id, appt_type, appt_length, appt_status,
      appt_date, appt_gcal, appt_ref_id, appt_note, appt_platform, appt_with, appt_manage_token)
    VALUES (?, ?, '', ?, ?, 'Scheduled', ?, '', '', ?, ?, 7, ?)`,
  [row.id, row.client, row.type || 'Consultation', row.length || 60, row.date, row.note || '', row.platform || 'telephone', row.token ?? null]);

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 2, timezone: 'Z' });
    pool.on('connection', (conn) => conn.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    for (const t of ['users', 'contacts', 'contact_phones', 'contact_emails', 'appts', 'app_settings']) await q(`DELETE FROM ${t}`);
    await buildConsentTables(q);
    await q(`INSERT INTO users (user, username, user_name, user_fname, user_lname, user_initials, user_auth, user_type, does_appts, ringcentral, default_phone)
      VALUES (7, 'fred', 'Fred', 'Fred', 'F', 'FF', 'authorized', 1, 1, 0, '2485550001')`);
    // contacts' name triggers derive contact_name from the parts.
    await q(`INSERT INTO contacts (contact_id, contact_type, contact_fname, contact_lname, contact_pname, contact_phone, contact_email) VALUES
      (1309, 'Client', 'Jane', 'Client', '', '3135550100', 'jane@example.com'),
      (1310, 'Client', 'Opted', 'Out', '', '3135550199', 'opt@example.com'),
      (1311, 'Client', 'No', 'Channels', '', '', ''),
      (1312, 'Client', 'Brace', 'Data', '{{contacts.contact_ssn}}', '3135550111', 'brace@example.com')`);
    await q(`INSERT INTO contact_phones (id, contact_id, phone, is_primary, sms_optout) VALUES
      (1, 1309, '3135550100', 1, 0), (2, 1310, '3135550199', 1, 1), (3, 1312, '3135550111', 1, 0)`);
    await q(`INSERT INTO contact_emails (id, contact_id, email, is_primary, email_optout) VALUES
      (1, 1309, 'jane@example.com', 1, 0), (2, 1310, 'opt@example.com', 1, 1)`);
    await q(`INSERT INTO app_settings (\`key\`, value) VALUES ('sms_default_from', '2485550000'), ('email_default_from', 'office@firm.example')`);
    await insertAppt({ id: 55, client: 1309, date: '2027-03-02 14:00:00', note: 'Existing note', token: TOKEN });
    await insertAppt({ id: 56, client: 1309, date: '2027-03-03 14:00:00', token: null });
    await insertAppt({ id: 57, client: null, date: '2027-03-04 14:00:00', token: 'Zz3dEf6hIj9kLm2nOp5qRs' });
    await insertAppt({ id: 58, client: 1310, date: '2027-03-05 14:00:00', token: 'Yy3dEf6hIj9kLm2nOp5qRs' });
    resolveType = jest.spyOn(calendarTypeService, 'resolveForCreate').mockResolvedValue({ type_key: 'consult', kind: 'meeting' });
    getType = jest.spyOn(calendarTypeService, 'getType').mockResolvedValue({ type_key: 'consult', label: 'Consultation', kind: 'meeting', active: 1, singleton: 0 });
  });
  beforeEach(() => {
    smsSpy = jest.spyOn(phoneService, 'sendSms').mockResolvedValue({ status: 'Queued' });
    emailSpy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue({ ok: true });
  });
  afterEach(() => { if (smsSpy) smsSpy.mockRestore(); if (emailSpy) emailSpy.mockRestore(); });
  afterAll(async () => {
    if (resolveType) resolveType.mockRestore();
    if (getType) getType.mockRestore();
    if (pool) await pool.end();
  });

  const create = (extra) => svc.normalizeActionDraft(pool, {
    kind: 'appt.create.v1', contact_id: 1309, appt_type: 'Consultation', appt_length: 60, appt_platform: 'Telephone',
    appt_date: '2027-01-05 10:00', appt_with: 7, note: 'Bring paystubs', evidence: ref, ...extra,
  }, contactEvidence);
  const cancel = (apptId, extra) => svc.normalizeActionDraft(pool, { kind: 'appt.cancel.v1', appt_id: apptId, evidence: ref, ...extra }, apptEvidence(apptId));
  const reschedule = (apptId, extra) => svc.normalizeActionDraft(pool, { kind: 'appt.reschedule.v1', appt_id: apptId,
    new_date: '2027-04-06 11:30', evidence: ref, ...extra }, apptEvidence(apptId));

  // The route's confirmation, run for real on this engine: what each provider was handed.
  async function routeSend({ contactId, apptId, sms, email, message, subject }) {
    await apptService._sendApptConfirmation(pool, { contactId, apptId, sms, email, message, subject });
    return { sms: smsSpy.mock.calls.map((c) => ({ from: c[1], to: c[2], text: c[3] })),
      email: emailSpy.mock.calls.map((c) => ({ from: c[1].from, to: c[1].to, subject: c[1].subject, text: c[1].text })) };
  }
  // What the route would have made of the model's RAW text against the stored row.
  const rowResolve = async (text, contactId, apptId) => (await resolverService.resolve({ db: pool, text,
    refs: { contacts: { contact_id: contactId }, appts: { appt_id: apptId } }, strict: false })).text.trim();

  const RAW = `Hi {{contacts.contact_fname}}, your {{appts.appt_type}} is {{appts.appt_date|date:dddd MMMM Do}} at {{appts.appt_date|time:h:mm A}} `
    + `until {{appts.appt_end|time:h:mm A}} ({{appts.appt_length}} min, {{appts.appt_platform}}). Note: {{appts.appt_note}}. Manage: https://4lsg.com/m/${LINK}`;

  test('create: resolved at proposal, recipients and senders are the route\'s own, and the route changes nothing but the manage link', async () => {
    const draft = await create({ confirm_sms: true, confirm_email: true, confirm_message: RAW });
    expect(draft.confirm_sms).toBe(true);
    expect(draft.confirm_email).toBe(true);
    expect(draft.confirm_message).toMatch(/^Hi Jane, your Consultation is .+ \(60 min, telephone\)\. Note: Bring paystubs\. Manage: https:\/\/4lsg\.com\/m\/\{\{appts\.appt_manage_token\|default:\}\}$/);
    expect(draft.confirm_message).not.toMatch(/\{\{(?!appts\.appt_manage_token\|default:\}\})/);
    expect(draft.confirmation).toEqual({ manage_link: true, templated: true, ssn_warning: false,
      sms: { to: '3135550100', from: '2485550000', segments: expect.objectContaining({ encoding: 'GSM-7' }) },
      email: { to: 'jane@example.com', from: 'office@firm.example', subject: 'Appointment Confirmation' } });

    // The appointment the route then stores (createAppt's own values) — and its confirmation.
    await insertAppt({ id: 90, client: 1309, date: '2027-01-05 10:00:00', note: 'Bring paystubs', platform: 'Telephone', token: 'Cr3dEf6hIj9kLm2nOp5qRs' });
    const sent = await routeSend({ contactId: 1309, apptId: 90, sms: true, email: true, message: draft.confirm_message, subject: draft.confirmation.email.subject });
    const expected = draft.confirm_message.replace(LINK, 'Cr3dEf6hIj9kLm2nOp5qRs');
    expect(sent.sms).toEqual([{ from: '2485550000', to: '3135550100', text: expected }]);
    expect(sent.email).toEqual([{ from: 'office@firm.example', to: 'jane@example.com', subject: 'Appointment Confirmation', text: expected }]);
    // The card's stand-in row reads exactly like the stored one.
    expect(await rowResolve(RAW, 1309, 90)).toBe(expected);
  });

  test('reschedule: resolved as the successor the route will create (old type/length/platform, new time, this note)', async () => {
    const draft = await reschedule(55, { note: 'Moved by phone', sms: true, email: false, confirm_message: RAW });
    expect(draft).toMatchObject({ sms: true, email: false, confirmation: { sms: { to: '3135550100' }, email: null, manage_link: true } });
    expect(draft.confirm_message).toContain('Note: Moved by phone.');
    await insertAppt({ id: 91, client: 1309, date: '2027-04-06 11:30:00', note: 'Moved by phone', token: 'Rs3dEf6hIj9kLm2nOp5qRs' });
    const sent = await routeSend({ contactId: 1309, apptId: 91, sms: true, email: false, message: draft.confirm_message });
    const expected = draft.confirm_message.replace(LINK, 'Rs3dEf6hIj9kLm2nOp5qRs');
    expect(sent.sms.map((s) => s.text)).toEqual([expected]);
    expect(sent.email).toEqual([]);
    expect(await rowResolve(RAW, 1309, 91)).toBe(expected);
  });

  test('cancel: resolved against the real row; the token is never read into the card; the route fills only the link', async () => {
    const draft = await cancel(55, { sms: false, email: true, confirm_message: RAW });
    expect(draft.confirm_message).toContain('Note: Existing note.');
    expect(draft.confirm_message).not.toContain(TOKEN);
    expect(JSON.stringify(draft)).not.toContain(TOKEN);
    expect(draft.confirmation.email).toEqual({ to: 'jane@example.com', from: 'office@firm.example', subject: 'Appointment Cancellation Confirmation' });
    const sent = await routeSend({ contactId: 1309, apptId: 55, sms: false, email: true, message: draft.confirm_message, subject: 'Appointment Cancellation Confirmation' });
    expect(sent.email.map((e) => e.text)).toEqual([draft.confirm_message.replace(LINK, TOKEN)]);
    expect(await rowResolve(RAW, 1309, 55)).toBe(draft.confirm_message.replace(LINK, TOKEN));
  });

  test('a message without placeholders is sent byte-for-byte', async () => {
    const plain = 'Your appointment is confirmed. Call us at (248) 555-0000 with questions.';
    const draft = await create({ confirm_sms: true, confirm_message: plain });
    expect(draft.confirm_message).toBe(plain);
    expect(draft.confirmation).toMatchObject({ templated: false, manage_link: false });
    await insertAppt({ id: 92, client: 1309, date: '2027-01-05 10:00:00', token: 'Pl3dEf6hIj9kLm2nOp5qRs' });
    expect((await routeSend({ contactId: 1309, apptId: 92, sms: true, email: false, message: draft.confirm_message })).sms.map((s) => s.text)).toEqual([plain]);
  });

  test('off is byte-stable: no flags, no message, no confirmation object, whatever text the model wrote', async () => {
    const draft = await create({ confirm_sms: false, confirm_email: false, confirm_message: RAW });
    const { draft_id: _id, ...rest } = draft;
    expect(rest).toEqual({ kind: 'appt.create.v1', status: 'draft', firm_timezone: expect.any(String),
      contact: { contact_id: 1309, label: expect.any(String) }, case: null,
      type: { appt_type: 'Consultation', type_key: 'consult', singleton: false }, appt_length: 60, appt_platform: 'Telephone',
      appt_date: '2027-01-05 10:00:00', provider: { user_id: 7, label: 'Fred' }, note: 'Bring paystubs',
      confirm_sms: false, confirm_email: false, confirm_message: '', evidence: [{ ...ref[0], label: 'Contact' }] });
    const off = await cancel(55, { sms: false, email: false, confirm_message: 'x' });
    expect(off).toMatchObject({ sms: false, email: false, confirm_message: '' });
    expect('confirmation' in off).toBe(false);
  });

  test('opt-out, missing channel, missing sender: refused at proposal (automation never acknowledges); an email opt-out is marketing-only (D18)', async () => {
    const msg = { confirm_message: 'See you then.' };
    await expect(svc.normalizeActionDraft(pool, { kind: 'appt.create.v1', contact_id: 1310, appt_type: 'Consultation', appt_length: 60,
      appt_platform: 'Zoom', appt_date: '2027-01-05 10:00', appt_with: 7, confirm_sms: true, ...msg, evidence: ref },
    [{ id: 'q1', kind: 'sql.read', purpose: 'Contact', rows: [{ contact_id: 1310 }] }])).rejects.toThrow(/opted out of texts/);
    // D18: the confirmation email is operational — the address's marketing opt-out does not stop it.
    await expect(cancel(58, { email: true, ...msg })).resolves.toMatchObject({ email: true, confirmation: { email: { to: 'opt@example.com' } } });
    await expect(cancel(58, { sms: true, ...msg })).rejects.toThrow(/opted out of texts/);
    await expect(svc.normalizeActionDraft(pool, { kind: 'appt.create.v1', contact_id: 1311, appt_type: 'Consultation', appt_length: 60,
      appt_platform: 'Zoom', appt_date: '2027-01-05 10:00', appt_with: 7, confirm_email: true, ...msg, evidence: ref },
    [{ id: 'q1', kind: 'sql.read', purpose: 'Contact', rows: [{ contact_id: 1311 }] }])).rejects.toThrow(/no email address on the contact/);
    await expect(cancel(57, { sms: true, ...msg })).rejects.toThrow(/no client contact/);
    await q("UPDATE app_settings SET value = '' WHERE `key` = 'sms_default_from'");
    try {
      await expect(create({ confirm_sms: true, ...msg })).rejects.toThrow(/sms_default_from/);
      await expect(create({ confirm_email: true, ...msg })).resolves.toMatchObject({ confirm_email: true });
    } finally { await q("UPDATE app_settings SET value = '2485550000' WHERE `key` = 'sms_default_from'"); }
    // Opting back in clears it — read live on every proposal.
    await q('UPDATE contact_phones SET sms_optout = 0 WHERE id = 2');
    try {
      await expect(cancel(58, { sms: true, ...msg })).resolves.toMatchObject({ sms: true, confirmation: { sms: { to: '3135550199' } } });
      // YisraMail P1: the number's consent STATE refuses even with the row flag clear.
      await q(`INSERT INTO comm_consent_state (channel, destination, scope, state, occurred_at, last_event_id, updated_at)
               VALUES ('sms', '3135550199', 'all', 'opted_out', '2026-10-01 10:00:00.000', 1, NOW(3))`);
      await expect(cancel(58, { sms: true, ...msg })).rejects.toThrow(/opted out of texts/);
    } finally {
      await q('UPDATE contact_phones SET sms_optout = 1 WHERE id = 2');
      await q('DELETE FROM comm_consent_state');
    }
  });

  test('a length past the old tinyint ceiling round-trips intact: 180 is shown, stored, and resolved by the route as 180', async () => {
    // appts.appt_length was a SIGNED tinyint until 2026-10-28 (scripts/apptLengthSmallint.js): under this
    // sql_mode 180 was stored as 127 without an error, and appt_end with it.
    const [col] = await q("SELECT DATA_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'appts' AND COLUMN_NAME = 'appt_length'");
    expect(col.t).toBe('smallint');
    const raw = 'Long: {{appts.appt_length}} min, {{appts.appt_date|time:h:mm A}} to {{appts.appt_end|time:h:mm A}}';
    const draft = await create({ appt_length: 180, confirm_sms: true, confirm_message: raw });
    expect(draft.appt_length).toBe(180);
    // The time filter's clock zone is the environment's; the 3-hour span is not.
    const m = draft.confirm_message.match(/^Long: 180 min, (\d+):(\d\d) ([AP])M to (\d+):(\d\d) ([AP])M$/);
    expect(m).not.toBeNull();
    const mins = (h, mm, ap) => ((Number(h) % 12) + (ap === 'P' ? 12 : 0)) * 60 + Number(mm);
    expect((mins(m[4], m[5], m[6]) - mins(m[1], m[2], m[3]) + 1440) % 1440).toBe(180);
    await insertAppt({ id: 93, client: 1309, date: '2027-01-05 10:00:00', length: 180, token: 'Lg3dEf6hIj9kLm2nOp5qRs' });
    const [row] = await q('SELECT appt_length, appt_end FROM appts WHERE appt_id = 93');
    expect(row.appt_length).toBe(180);
    expect(row.appt_end).toEqual(new Date('2027-01-05T13:00:00Z'));
    expect(await rowResolve(raw, 1309, 93)).toBe(draft.confirm_message);
    const sent = await routeSend({ contactId: 1309, apptId: 93, sms: true, email: false, message: draft.confirm_message });
    expect(sent.sms.map((s) => s.text)).toEqual([draft.confirm_message]);
  });

  test('strict for Casey: unresolved, unknown-before-create, foreign-table, mangled-link and brace-carrying text all refuse', async () => {
    const on = (confirm_message) => create({ confirm_sms: true, confirm_message });
    await expect(on('Hi {{contacts.contact_pname}}')).rejects.toThrow(/do not resolve \(\{\{contacts\.contact_pname\}\}\)/);
    await expect(on('Your appointment {{appts.appt_id}}')).rejects.toThrow(/not known until the appointment is created/);
    await expect(on('Case {{cases.case_number}}')).rejects.toThrow(/only \{\{contacts\.\*\}\} and \{\{appts\.\*\}\}/);
    await expect(on('Link {{appts.appt_manage_token|upper}}')).rejects.toThrow(/manage link in a form the card cannot show/);
    await expect(on('Hi {{name}}')).rejects.toThrow(/still contains "\{\{" or "\}\}"/);
    await expect(on('Hi {{trigger_data.x}}')).rejects.toThrow(/trigger_data/);
    await expect(on('{' + LINK)).rejects.toThrow(/cannot show/);
    // Contact data that itself carries braces would be re-resolved by the route: refused.
    await expect(svc.normalizeActionDraft(pool, { kind: 'appt.create.v1', contact_id: 1312, appt_type: 'Consultation', appt_length: 60,
      appt_platform: 'Zoom', appt_date: '2027-01-05 10:00', appt_with: 7, confirm_sms: true, confirm_message: 'Hi {{contacts.contact_pname}}', evidence: ref },
    [{ id: 'q1', kind: 'sql.read', purpose: 'Contact', rows: [{ contact_id: 1312 }] }])).rejects.toThrow(/still contains/);
    // Cancel: a manage link on a row with no token would send a blank link.
    await expect(cancel(56, { sms: true, confirm_message: `Rebook: https://4lsg.com/m/${LINK}` })).rejects.toThrow(/this appointment has none/);
    // SMS cap with the link counted at 32; email alone takes the same text.
    const long = `${'x'.repeat(980)} ${LINK}`;
    await expect(on(long)).rejects.toThrow(/limit is 1000/);
    await expect(create({ confirm_email: true, confirm_message: long })).resolves.toMatchObject({ confirm_email: true });
  });
});
