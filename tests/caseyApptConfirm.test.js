'use strict';
/**
 * tests/caseyApptConfirm.test.js
 *
 * Ask Casey appointment-card client confirmations (ruling 15's A14 bar on
 * A4), the ungated half. The SQL predicates and the stored-row parity run on
 * a real engine in tests/caseyApptConfirm.mysql.test.js; this file keeps the
 * contract under every CI run, where that suite skips:
 *   - the card's confirm_message is the RESOLVED text, and the route's own
 *     confirmation path (apptService.sendApptConfirmation, real code, only the
 *     db and the two provider calls stubbed) changes nothing in it but the
 *     manage-link placeholder;
 *   - the recipient/sender/subject on the card are the ones the route uses;
 *   - an opted-out NUMBER refuses (automation sends never acknowledge); an
 *     email opt-out is marketing-only (YisraMail D18) and never refuses the
 *     operational email confirmation;
 *   - off stays the shipped shape.
 */

const fs = require('fs');
const path = require('path');
const svc = require('../services/assistantService');
const apptService = require('../services/apptService');
const phoneService = require('../services/phoneService');
const emailService = require('../services/emailService');
const { answerOptout } = require('./helpers/optoutFake');
const calendarTypeService = require('../services/calendarTypeService');
const { Settings: LuxonSettings } = require('luxon');

const LINK = '{{appts.appt_manage_token|default:}}';
const TOKEN = 'Ab3dEf6hIj9kLm2nOp5qRs';
const realLuxonNow = LuxonSettings.now;
beforeAll(() => { LuxonSettings.now = () => Date.parse('2026-10-21T16:00:00.000Z'); });
afterAll(() => { LuxonSettings.now = realLuxonNow; });

// One in-memory world answering each statement the card and the route issue.
function world({ phone = '3135550100', email = 'jane@example.com', smsOpt = false, emailOpt = false, states = [],
  settings = { sms_default_from: '2485550000', email_default_from: 'office@firm.example' }, hasLink = 1, client = 1309 } = {}) {
  const calls = [];
  const target = { appt_id: 55, appt_client_id: client, appt_case_id: '', appt_type: 'Consultation', appt_length: 60,
    appt_platform: 'telephone', appt_status: 'Scheduled', appt_date: new Date('2026-11-03T14:00:00Z'), appt_with: 7,
    appt_note: 'Existing note', appt_gcal: '', appt_gcal_user: null, contact_name: 'Jane Client', case_number_display: null, user_name: 'Fred' };
  const db = { query: jest.fn(async (sql, params) => {
    calls.push(sql);
    const consent = answerOptout(sql, params, {
      phones: phone ? [{ id: 1, contact_id: 1309, phone, sms_optout: smsOpt ? 1 : 0 }] : [],
      emails: email ? [{ id: 2, contact_id: 1309, email, email_optout: emailOpt ? 1 : 0 }] : [],
      contacts: [{ contact_id: 1309, contact_name: 'Jane Client' }], states });
    if (consent) return consent;
    if (/^SELECT contact_id, contact_name FROM contacts/.test(sql)) return [[{ contact_id: 1309, contact_name: 'Jane Client' }]];
    if (/^SELECT contact_phone, contact_email FROM contacts/.test(sql)) return [[{ contact_phone: phone, contact_email: email }]];
    if (/FROM app_settings/.test(sql)) return [Object.entries(settings).map(([key, value]) => ({ key, value }))];
    if (/FROM users/.test(sql)) return [[{ user: 7, user_name: 'Fred' }]];
    if (/appt_manage_token IS NOT NULL AS has_link/.test(sql)) return [[{ has_link: hasLink }]];
    if (/FROM appts a/.test(sql)) return [[target]];
    // resolverService's one SELECT (aliases table__column).
    if (/^SELECT .* FROM `(contacts|appts)`/.test(sql)) {
      return [[{ contacts__contact_id: 1309, contacts__contact_fname: 'Jane', appts__appt_id: params[params.length - 1],
        appts__appt_manage_token: TOKEN, appts__appt_date: target.appt_date, appts__appt_note: target.appt_note }]];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }) };
  return { db, calls, target };
}

const contactEvidence = [{ id: 'q1', kind: 'sql.read', purpose: 'Contact', rows: [{ contact_id: 1309 }] }];
const apptEvidence = [{ id: 'q1', kind: 'sql.read', purpose: 'Appointment', rows: [{ appt_id: 55 }] }];
const ref = [{ query_id: 'q1', row_number: 1 }];
const createValue = (extra) => ({ kind: 'appt.create.v1', contact_id: 1309, appt_type: 'Consultation', appt_length: 60,
  appt_platform: 'Telephone', appt_date: '2026-11-03 10:00', appt_with: 7, note: 'Bring paystubs', evidence: ref, ...extra });

describe('Ask Casey appointment confirmations', () => {
  let resolveType; let getType; let smsSpy; let emailSpy;
  beforeEach(() => {
    resolveType = jest.spyOn(calendarTypeService, 'resolveForCreate').mockResolvedValue({ type_key: 'consult', kind: 'meeting' });
    getType = jest.spyOn(calendarTypeService, 'getType').mockResolvedValue({ type_key: 'consult', label: 'Consultation', kind: 'meeting', active: 1, singleton: 0 });
    smsSpy = jest.spyOn(phoneService, 'sendSms').mockResolvedValue({ status: 'Queued' });
    emailSpy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue({ ok: true });
  });
  afterEach(() => { resolveType.mockRestore(); getType.mockRestore(); smsSpy.mockRestore(); emailSpy.mockRestore(); });

  test('create: the card carries the resolved text, the route\'s recipient and sender, and the route fills only the manage link', async () => {
    const raw = `Hi {{contacts.contact_fname}}, your {{appts.appt_type}} ({{appts.appt_length}} min, {{appts.appt_platform}}) is booked. Note: {{appts.appt_note}}. Manage: https://4lsg.com/m/${LINK}`;
    const { db } = world();
    const draft = await svc.normalizeActionDraft(db, createValue({ confirm_sms: true, confirm_email: true, confirm_message: raw }), contactEvidence);
    const shown = `Hi Jane, your Consultation (60 min, telephone) is booked. Note: Bring paystubs. Manage: https://4lsg.com/m/${LINK}`;
    expect(draft).toMatchObject({ confirm_sms: true, confirm_email: true, confirm_message: shown });
    expect(draft.confirmation).toEqual({ manage_link: true, templated: true, ssn_warning: false,
      sms: { to: '3135550100', from: '2485550000', segments: { encoding: 'GSM-7', units: expect.any(Number), segments: 1 } },
      email: { to: 'jane@example.com', from: 'office@firm.example', subject: 'Appointment Confirmation' } });

    // What the browser sends is draft.confirm_message; the route's own path, for real:
    const route = world();
    await apptService._sendApptConfirmation(route.db, { contactId: 1309, apptId: 90, sms: true, email: true,
      message: draft.confirm_message, subject: 'Appointment Confirmation' });
    const sent = shown.replace(LINK, TOKEN);
    expect(smsSpy.mock.calls.map((c) => [c[1], c[2], c[3]])).toEqual([['2485550000', '3135550100', sent]]);
    expect(emailSpy.mock.calls.map((c) => c[1])).toEqual([{ from: 'office@firm.example', to: 'jane@example.com', subject: 'Appointment Confirmation', text: sent }]);
  });

  test('the subjects on the card are the ones apptService passes (the routes take none)', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'apptService.js'), 'utf8');
    expect(src).toContain("subject:   'Appointment Confirmation',");
    expect(src).toContain("subject:   'Appointment Cancellation Confirmation',");
    const cancel = await svc.normalizeActionDraft(world().db, { kind: 'appt.cancel.v1', appt_id: 55, email: true,
      confirm_message: 'Your appointment is cancelled.', evidence: ref }, apptEvidence);
    expect(cancel.confirmation.email.subject).toBe('Appointment Cancellation Confirmation');
    const moved = await svc.normalizeActionDraft(world().db, { kind: 'appt.reschedule.v1', appt_id: 55, new_date: '2026-11-04 10:00',
      email: true, confirm_message: 'Moved.', evidence: ref }, apptEvidence);
    expect(moved.confirmation.email.subject).toBe('Appointment Confirmation');
  });

  test('cancel resolves against the real row and never reads the token into the card', async () => {
    const { db, calls } = world();
    const draft = await svc.normalizeActionDraft(db, { kind: 'appt.cancel.v1', appt_id: 55, sms: true,
      confirm_message: `Cancelled, {{contacts.contact_fname}}. Rebook: https://4lsg.com/m/${LINK}`, evidence: ref }, apptEvidence);
    expect(draft.confirm_message).toBe(`Cancelled, Jane. Rebook: https://4lsg.com/m/${LINK}`);
    expect(JSON.stringify(draft)).not.toContain(TOKEN);
    expect(calls.some((s) => /appt_manage_token IS NOT NULL AS has_link/.test(s))).toBe(true);
    await expect(svc.normalizeActionDraft(world({ hasLink: 0 }).db, { kind: 'appt.cancel.v1', appt_id: 55, sms: true,
      confirm_message: `Rebook: ${LINK}`, evidence: ref }, apptEvidence)).rejects.toThrow(/this appointment has none/);
    await expect(svc.normalizeActionDraft(world({ client: null }).db, { kind: 'appt.cancel.v1', appt_id: 55, sms: true,
      confirm_message: 'Cancelled.', evidence: ref }, apptEvidence)).rejects.toThrow(/no client contact/);
  });

  test('an opted-out channel refuses — automation never acknowledges — as do a missing number, address or sender', async () => {
    const on = (w, extra) => svc.normalizeActionDraft(w.db, createValue({ confirm_message: 'See you then.', ...extra }), contactEvidence);
    await expect(on(world({ smsOpt: true }), { confirm_sms: true })).rejects.toThrow(/opted out of texts/);
    // D18: an email opt-out is marketing-only — the confirmation email still goes.
    await expect(on(world({ emailOpt: true }), { confirm_email: true })).resolves.toMatchObject({ confirm_email: true });
    await expect(on(world({ states: [{ channel: 'email', destination: 'jane@example.com', scope: 'marketing', state: 'opted_out' }] }),
      { confirm_email: true })).resolves.toMatchObject({ confirm_email: true });
    // The number's consent STATE refuses even with the row flag clear (YisraMail P1).
    await expect(on(world({ states: [{ channel: 'sms', destination: '3135550100', scope: 'all', state: 'opted_out' }] }),
      { confirm_sms: true })).rejects.toThrow(/opted out of texts/);
    await expect(on(world({ smsOpt: true }), { confirm_email: true })).resolves.toMatchObject({ confirm_email: true, confirm_sms: false });
    await expect(on(world({ phone: '' }), { confirm_sms: true })).rejects.toThrow(/no phone number on the contact/);
    await expect(on(world({ email: '' }), { confirm_email: true })).rejects.toThrow(/no email address on the contact/);
    await expect(on(world({ settings: { email_default_from: 'office@firm.example' } }), { confirm_sms: true })).rejects.toThrow(/sms_default_from/);
    await expect(on(world({ settings: { sms_default_from: '2485550000' } }), { confirm_email: true })).rejects.toThrow(/email_default_from/);
  });

  test('Casey\'s text is strict: unresolved, unknown-before-create, foreign tables, mangled links and stray braces refuse', async () => {
    const on = (confirm_message) => svc.normalizeActionDraft(world().db, createValue({ confirm_sms: true, confirm_message }), contactEvidence);
    await expect(on('Hi {{contacts.contact_lname}}')).rejects.toThrow(/do not resolve/);
    await expect(on('Ref {{appts.appt_id}}')).rejects.toThrow(/not known until the appointment is created/);
    await expect(on('{{cases.case_number}}')).rejects.toThrow(/only \{\{contacts\.\*\}\} and \{\{appts\.\*\}\}/);
    await expect(on('{{appts.appt_manage_token|upper}}')).rejects.toThrow(/cannot show/);
    await expect(on('Hi {{name}}')).rejects.toThrow(/still contains/);
    await expect(on('{{trigger_data.amount}}')).rejects.toThrow(/trigger_data/);
    await expect(on(`{${LINK}`)).rejects.toThrow(/cannot show/);
    // appts.appt_length is a smallint (since 2026-10-28): a length past the old tinyint's 127 resolves as itself.
    await expect(svc.normalizeActionDraft(world().db, createValue({ appt_length: 180, confirm_sms: true,
      confirm_message: '{{appts.appt_length}} minutes' }), contactEvidence)).resolves.toMatchObject({ appt_length: 180, confirm_message: '180 minutes' });
    await expect(on(`${'x'.repeat(980)} ${LINK}`)).rejects.toThrow(/limit is 1000/);
  });

  test('off is the shipped shape, and no confirmation query runs', async () => {
    const { db, calls } = world();
    const draft = await svc.normalizeActionDraft(db, createValue({ confirm_sms: false, confirm_email: false,
      confirm_message: 'Dropped {{contacts.contact_ssn}}' }), contactEvidence);
    expect(draft).toMatchObject({ confirm_sms: false, confirm_email: false, confirm_message: '' });
    expect('confirmation' in draft).toBe(false);
    expect(calls.some((s) => /contact_phone|app_settings|FROM `/.test(s))).toBe(false);
  });
});
