// tests/caseySendAction.test.js
//
/**
 * Ask Casey A14 — the direct-send normalizer (sms.send.v1 / email.send.v1 in
 * services/assistantService.js). Run: npx jest tests/caseySendAction.test.js
 *
 * HARNESS. The REAL normalizer and the REAL resolverService run over a
 * scripted fake database (contacts, contact_phones/emails rows, cases +
 * case_relate, channel_grants, and the resolver's own JOIN SELECT, evaluated
 * from the seeded rows — unknown statements THROW). The channel-access
 * services (mailboxService.getAccess / listSendable, phoneCommsService.loadLine,
 * mailboxSendService.resolveIdentity / listIdentities) are spied: they are
 * another module's contract, proven in tests/phoneSPH.* and tests/mailboxS3.*,
 * and the SQL of this whole path runs on MySQL in
 * tests/caseySendAction.mysql.test.js (gated). Nothing here can send: no route,
 * no provider adapter, no transport is loaded by the normalizer.
 *
 * WHAT IS PINNED (mutation-checked — the A14 report lists each mutation):
 *   recipient  only a row an evidence row names by BOTH contact_id and
 *              phone_id/email_id; reloaded; on that contact; active.
 *   consent    the row's sms_optout/email_optout AND the contact's
 *              contact_*_optout (campaignService's columns) each refuse.
 *   body       placeholders resolve strictly against the recipient (+ a cited,
 *              linked case); an unresolved one refuses; braces never survive;
 *              the card carries the RESOLVED text, trimmed exactly as the
 *              route trims it; SMS cap = the route's; subject one line.
 *   sender     a line/mailbox the user can send from; inactive/denied refuse;
 *              omitted → the user's ONLY explicit grant, else the choices.
 *   flag       casey_send_enabled = '0' makes both kinds not exist.
 *   parity     the subject/body caps equal the mail route's own validator.
 */

'use strict';

const svc = require('../services/assistantService');
const mbx = require('../services/mailboxService');
const phone = require('../services/phoneCommsService');
const sendSvc = require('../services/mailbox/mailboxSendService');
const firmConfig = require('../lib/firmConfig');

const USER = 22;
const EVID = [{ id: 'q1', purpose: 'Client phones and emails', rows: [
  { contact_id: 1309, contact_name: 'Pat One', phone_id: 12, phone: '3135550001', email_id: 13, email: 'pat@example.com', case_id: 'CASE1' },
  { contact_id: 1309, contact_name: 'Pat One' },
  { contact_id: 1400, phone_id: 12 },
] }];
const CITE = [{ query_id: 'q1', row_number: 1 }];
const { makeDb, STAMP } = require('./helpers/caseySendProposalDb');

const LINES = {
  3: { id: 3, phone_number: '2489655355', display_name: 'Rena', provider: 'quo', active: true },
  6: { id: 6, phone_number: '2484179800', display_name: 'office', provider: 'quo', active: true },
  7: { id: 7, phone_number: '2480000007', display_name: 'retired', provider: 'quo', active: false },
};
let canSend;
let mailboxes;
beforeEach(() => {
  canSend = new Set([3, 6, 7]);
  mailboxes = { 5: { id: 5, address: 'rena@4lsg.com', display_name: 'Rena', sendable: true }, 6: { id: 6, address: 'billing@4lsg.com', display_name: null, sendable: true } };
  jest.spyOn(mbx, 'getAccess').mockImplementation(async (db, uid, type, id) => ({ can_read: true, can_send: type === 'phone_line' && canSend.has(Number(id)), can_manage: false, su: false }));
  jest.spyOn(mbx, 'listSendable').mockImplementation(async () => [...canSend].map((id) => LINES[id]));
  jest.spyOn(phone, 'loadLine').mockImplementation(async (db, id) => LINES[Number(id)] || null);
  jest.spyOn(sendSvc, 'listIdentities').mockImplementation(async () => ({ identities: Object.values(mailboxes) }));
  jest.spyOn(sendSvc, 'resolveIdentity').mockImplementation(async (db, uid, id) => {
    const m = mailboxes[Number(id)];
    if (!m) throw Object.assign(new Error('Mailbox not found'), { status: 404 });
    if (!m.sendable) throw Object.assign(new Error('This mailbox is switched off (Admin → Mailboxes).'), { status: 409 });
    return { mailbox: { id: m.id, address: m.address, display_name: m.display_name } };
  });
});
afterEach(() => jest.restoreAllMocks());

const sms = (over = {}) => ({ kind: 'sms.send.v1', contact_id: 1309, phone_id: 12, line_id: 3,
  message: 'Hi {{contacts.contact_fname}}, your hearing moved.', evidence: CITE, ...over });
const email = (over = {}) => ({ kind: 'email.send.v1', contact_id: 1309, email_id: 13, mailbox_id: 5,
  subject: 'Your case {{cases.case_number_full}}', body: 'Dear {{contacts.contact_fname}},\r\n\r\nSee you Tuesday.  ', case_id: 'CASE1', evidence: CITE, ...over });
const norm = (value, db = makeDb()) => svc.normalizeActionDraft(db, value, EVID, { currentUserId: USER });

describe('sms.send.v1', () => {
  test('a cited, active, consenting row yields a card carrying the RESOLVED text and the exact recipient', async () => {
    const d = await norm(sms());
    expect(d).toMatchObject({
      kind: 'sms.send.v1', status: 'draft',
      recipient: { contact_id: 1309, contact_name: 'Pat One', phone_id: 12, phone: '3135550001', label: 'Mobile', is_primary: true, expected_updated_at: STAMP.toISOString() },
      sender: { line_id: 3, number: '2489655355', defaulted: false },
      message: 'Hi Pat, your hearing moved.',
      segments: { encoding: 'GSM-7', segments: 1 },
      templated: true, ssn_warning: false, case: null,
    });
    expect(d.draft_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(d)).not.toContain('{{');
  });

  test('the recipient must be the row an evidence row names by contact_id AND phone_id', async () => {
    // Row 2 carries the contact but no phone_id; row 3 the phone_id on another contact.
    await expect(norm(sms({ evidence: [{ query_id: 'q1', row_number: 2 }] }))).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/contact_id and phone_id/) });
    await expect(norm(sms({ contact_id: 1400, evidence: [{ query_id: 'q1', row_number: 3 }] }))).rejects.toThrow(/is not on contact 1400/);
    await expect(norm(sms({ phone_id: 99 }))).rejects.toThrow(/contact_id and phone_id/);
    await expect(norm(sms({ evidence: [] }))).rejects.toThrow(/1-8 evidence/);
    await expect(norm(sms({ evidence: [{ query_id: 'q9', row_number: 1 }] }))).rejects.toThrow(/outside this investigation/);
  });

  test('an ended row and a row-level opt-out each refuse; the retired contact-level column does not', async () => {
    const ended = makeDb(); ended.T.contact_phones[0].end_date = '2026-10-01';
    await expect(norm(sms(), ended)).rejects.toThrow(/has ended/);
    const rowOpt = makeDb(); rowOpt.T.contact_phones[0].sms_optout = 1;
    await expect(norm(sms(), rowOpt)).rejects.toThrow(/opted out of SMS/);
    // Ruling 2026-10-27: consent is the row's flag only — contacts.contact_sms_optout is never read.
    const contactOpt = makeDb(); contactOpt.T.contacts[0].contact_sms_optout = 1;
    await expect(norm(sms(), contactOpt)).resolves.toMatchObject({ kind: 'sms.send.v1' });
    expect(contactOpt.seen.some((s) => /contact_sms_optout|contact_email_optout/.test(s))).toBe(false);
    // An EMAIL opt-out does not block a text.
    const emailOpt = makeDb(); emailOpt.T.contacts[0].contact_email_optout = 1; emailOpt.T.contact_phones[0].email_optout = 1;
    await expect(norm(sms(), emailOpt)).resolves.toMatchObject({ kind: 'sms.send.v1' });
  });

  test('placeholders: an unresolved one refuses, braces never survive, a literal message is not "templated"', async () => {
    await expect(norm(sms({ message: 'Hi {{contacts.contact_nickname}}' }))).rejects.toThrow(/do not resolve for this recipient .*contacts\.contact_nickname/);
    await expect(norm(sms({ message: 'Your case {{cases.case_number}}' }))).rejects.toThrow(/do not resolve/); // no case given
    await expect(norm(sms({ message: 'Hi {{name}}' }))).rejects.toThrow(/"\{\{" or "\}\}"/);   // the resolver ignores a dotless {{…}}; the brace check does not
    await expect(norm(sms({ message: 'Hi {{appts.appt_date}}' }))).rejects.toThrow(/do not resolve/);
    await expect(norm(sms({ message: 'Hi {{contacts.contact_fname' }))).rejects.toThrow(/"\{\{" or "\}\}"/);
    const named = makeDb(); named.T.contacts[0].contact_fname = '{{x}}';
    await expect(norm(sms(), named)).rejects.toThrow(/"\{\{" or "\}\}"/);
    const blank = makeDb(); blank.T.contacts[0].contact_fname = '';
    await expect(norm(sms(), blank)).rejects.toThrow(/do not resolve/);           // a blank is never sent
    const lit = await norm(sms({ message: '  Hello there  ' }));
    expect(lit).toMatchObject({ message: 'Hello there', templated: false });       // trimmed as the route trims
  });

  test('length: the route\'s own cap, and the segment count the card shows', async () => {
    const at = 'a'.repeat(phone.SMS_MAX_CHARS);
    await expect(norm(sms({ message: at }))).resolves.toMatchObject({ segments: { encoding: 'GSM-7', segments: Math.ceil(phone.SMS_MAX_CHARS / 153) } });
    await expect(norm(sms({ message: `${at}b` }))).rejects.toThrow(/limit is 1000/);
    expect((await norm(sms({ message: 'a'.repeat(160) }))).segments.segments).toBe(1);
    expect((await norm(sms({ message: 'a'.repeat(161) }))).segments.segments).toBe(2);
    expect((await norm(sms({ message: '€'.repeat(80) }))).segments).toEqual({ encoding: 'GSM-7', units: 160, segments: 1 });
    expect((await norm(sms({ message: 'שלום'.repeat(18) }))).segments).toEqual({ encoding: 'UCS-2', units: 72, segments: 2 });
  });

  test('sender: denied and inactive lines refuse; omitted uses the ONLY explicit grant, else lists the choices', async () => {
    canSend.delete(6);
    await expect(norm(sms({ line_id: 6 }))).rejects.toThrow(/cannot send from phone line 6/);
    await expect(norm(sms({ line_id: 7 }))).rejects.toThrow(/inactive/);
    await expect(norm(sms({ line_id: 'x' }))).rejects.toThrow(/line_id is invalid/);
    const d = await norm(sms({ line_id: undefined }));
    expect(d.sender).toMatchObject({ line_id: 3, defaulted: true });
    // Sendable through a bypass (an SU) is not a grant: with lines 3 AND 6 sendable
    // but only 3 granted, the default is still 3 — never "the first sendable".
    canSend.add(6);
    expect((await norm(sms({ line_id: undefined }))).sender).toMatchObject({ line_id: 3, defaulted: true });
    const two = makeDb(); two.T.channel_grants.push({ user: USER, channel_type: 'phone_line', channel_id: 6, can_send: 1 });
    canSend.add(6);
    await expect(norm(sms({ line_id: undefined }), two)).rejects.toThrow(/line_id is required — this user can send from: #3 Rena \(248\) 965-5355; #6 office/);
  });

  test('a contact_ssn placeholder resolves (2026-09-24 ruling) and the card warns', async () => {
    const d = await norm(sms({ message: 'SSN on file: {{contacts.contact_ssn}}' }));
    expect(d).toMatchObject({ message: 'SSN on file: 123-45-6789', ssn_warning: true });
    expect((await norm(sms({ message: 'Ref 123-45-6789' }))).ssn_warning).toBe(true);
  });

  test('closed shape: attachments, media, recipients-by-text and scheduling are refused by name', async () => {
    for (const k of ['to', 'media_url', 'attachment_urls', 'send_at', 'from', 'cc']) {
      await expect(norm(sms({ [k]: 'x' }))).rejects.toThrow(new RegExp(`unsupported fields: ${k}`));
    }
    await expect(norm(sms({ message: '' }))).rejects.toThrow(/message is required/);
  });
});

describe('email.send.v1', () => {
  test('subject and body resolve against the recipient and the cited, linked case; the body is normalized exactly once', async () => {
    const d = await norm(email());
    expect(d).toMatchObject({
      kind: 'email.send.v1',
      recipient: { contact_id: 1309, email_id: 13, email: 'pat@example.com', label: 'Personal' },
      sender: { mailbox_id: 5, address: 'rena@4lsg.com', defaulted: false },
      case: { case_id: 'CASE1', label: '2:26-bk-40001' },
      subject: 'Your case 2:26-bk-40001',
      body: 'Dear Pat,\n\nSee you Tuesday.',
      templated: true,
    });
  });

  test('a case must be cited AND linked to the recipient', async () => {
    await expect(norm(email({ case_id: 'CASE2' }))).rejects.toThrow(/cited evidence row/);
    const unlinked = makeDb(); unlinked.T.case_relate = [];
    await expect(norm(email(), unlinked)).rejects.toThrow(/not linked to the recipient/);
    await expect(norm(email({ case_id: 'bad id!' }))).rejects.toThrow(/case_id is invalid/);
  });

  test('consent: the row\'s email_optout refuses; the retired contact_email_optout does not', async () => {
    const rowOpt = makeDb(); rowOpt.T.contact_emails[0].email_optout = 1;
    await expect(norm(email(), rowOpt)).rejects.toThrow(/opted out of email/);
    const contactOpt = makeDb(); contactOpt.T.contacts[0].contact_email_optout = 1;
    await expect(norm(email(), contactOpt)).resolves.toMatchObject({ kind: 'email.send.v1' });
  });

  test('the subject is one line, before AND after resolution; caps mirror the mail route', async () => {
    await expect(norm(email({ subject: 'Two\nlines' }))).rejects.toThrow(/subject must be one line \(no line breaks/);
    await expect(norm(email({ subject: 'Tab\there' }))).rejects.toThrow(/subject must be one line \(no line breaks/);
    const multi = makeDb(); multi.T.contacts[0].contact_fname = 'Pat\r\nBcc: x@evil.test';
    await expect(norm(email({ subject: 'Hi {{contacts.contact_fname}}', case_id: undefined }), multi)).rejects.toThrow(/stay one line/);
    await expect(norm(email({ subject: 's'.repeat(501), case_id: undefined }))).rejects.toThrow(/subject exceeds 500/);
    await expect(norm(email({ subject: 's', body: 'b'.repeat(200001), case_id: undefined }))).rejects.toThrow(/body exceeds 200000/);
    // Parity: the mail route's own validator draws the same lines.
    const body = { mailbox_id: 5, to: ['pat@example.com'], body_text: 'x' };
    expect(() => sendSvc.validateSendBody({ ...body, subject: 's'.repeat(500) })).not.toThrow();
    expect(() => sendSvc.validateSendBody({ ...body, subject: 's'.repeat(501) })).toThrow(/at most 500/);
    expect(() => sendSvc.validateSendBody({ ...body, subject: 's', body_text: 'b'.repeat(200000) })).not.toThrow();
    expect(() => sendSvc.validateSendBody({ ...body, subject: 's', body_text: 'b'.repeat(200001) })).toThrow(/at most 200000/);
  });

  test('sender: a mailbox the route would refuse is refused here with its reason; omitted uses the only explicit grant', async () => {
    mailboxes[6].sendable = false;
    await expect(norm(email({ mailbox_id: 6 }))).rejects.toThrow(/Mailbox 6 cannot be used: This mailbox is switched off/);
    await expect(norm(email({ mailbox_id: 99 }))).rejects.toThrow(/Mailbox 99 cannot be used: Mailbox not found/);
    expect((await norm(email({ mailbox_id: undefined }))).sender).toMatchObject({ mailbox_id: 5, defaulted: true });
    mailboxes[6].sendable = true;
    // Both sendable, only 5 granted: the default is the grant, not the first sendable box.
    expect((await norm(email({ mailbox_id: undefined }))).sender).toMatchObject({ mailbox_id: 5, defaulted: true });
    const two = makeDb(); two.T.channel_grants.push({ user: USER, channel_type: 'mailbox', channel_id: 6, can_send: 1 });
    await expect(norm(email({ mailbox_id: undefined }), two)).rejects.toThrow(/mailbox_id is required — this user can send as: #5 Rena <rena@4lsg.com>; #6 billing@4lsg.com/);
  });

  test('an address the mail route would refuse is never offered', async () => {
    const bad = makeDb(); bad.T.contact_emails[0].email = 'not an address';
    await expect(norm(email(), bad)).rejects.toThrow(/not an address the mail route accepts/);
  });

  test('closed shape: cc, bcc, attachments, html and scheduling are refused by name', async () => {
    for (const k of ['cc', 'bcc', 'attachment_urls', 'body_html', 'scheduled_time', 'to']) {
      await expect(norm(email({ [k]: 'x' }))).rejects.toThrow(new RegExp(`unsupported fields: ${k}`));
    }
  });
});

describe('the per-family flag', () => {
  test('casey_send_enabled = "0" makes both kinds unavailable; unset or "1" keeps them', async () => {
    const spy = jest.spyOn(firmConfig, 'cfg');
    spy.mockImplementation((k) => (k === 'casey_send_enabled' ? '0' : undefined));
    await expect(norm(sms())).rejects.toThrow('Action kind is unavailable');
    await expect(norm(email())).rejects.toThrow('Action kind is unavailable');
    spy.mockImplementation((k) => (k === 'casey_send_enabled' ? '1' : undefined));
    await expect(norm(sms())).resolves.toMatchObject({ kind: 'sms.send.v1' });
    spy.mockImplementation(() => undefined);
    await expect(norm(email())).resolves.toMatchObject({ kind: 'email.send.v1' });
  });

  test('a send needs the signed-in user (the access checks are per user)', async () => {
    for (const opts of [{}, { currentUserId: null }, { currentUserId: 0 }, { currentUserId: '' }]) {
      await expect(svc.normalizeActionDraft(makeDb(), sms(), EVID, opts)).rejects.toThrow(/signed-in staff user/);
    }
  });
});
