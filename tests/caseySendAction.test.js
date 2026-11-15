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
 *   consent    read through optoutService as the send route reads it
 *              (YisraMail P1): an SMS opt-out — the row's cache flag OR the
 *              number's consent state — is RECORDED as recipient.opted_out;
 *              an email opt-out is marketing-only (D18) and never marks a
 *              direct email. recipient.consent_version moves with ANY consent
 *              change for the destination. An opted-out recipient is
 *              proposed, not refused (ruling 17: "casey is like the user").
 *   body       placeholders resolve strictly against the recipient (+ a cited,
 *              linked case); an unresolved one refuses; braces never survive;
 *              the card carries the RESOLVED text, trimmed exactly as the
 *              route trims it; SMS cap = the route's; subject one line.
 *   sender     a line/mailbox the user can send from; inactive/denied refuse;
 *              omitted → the user's ONLY explicit grant, else the choices.
 *   flag       casey_send_enabled = '0' makes both kinds not exist.
 *   parity     the subject/body caps equal the mail route's own validator.
 *   A14X (released 2026-11-15, "release means allow") — email only:
 *   cc / bcc   each entry {contact_id, email_id} cited like the To, reloaded
 *              active on that contact; the route's dedupe (To beats Cc beats
 *              Bcc) and cap mirrored; consent recorded per recipient.
 *   reply      in_reply_to_message_fk is a cited mail.message / mail.search
 *              row; the hub's replyDefaults (spied — its SQL runs on MySQL in
 *              the twin) decides From and To, and the To must be the cited
 *              row's address; subject defaults to "Re: …"; quote_original.
 *   case       cited + existing; an email FILES to it (linked_to_recipient is
 *              a flag), an SMS still needs the recipient's own case; no case
 *              is ever inferred.
 *   refused    attachments and scheduled sends, BY NAME, saying the hub itself
 *              cannot do them.
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
  // A14X rows: a second address of the To contact, another contact's address, an existing case nobody here is on, a case that does not exist.
  { contact_id: 1309, email_id: 14, email: 'pat.work@example.com' },
  { contact_id: 1400, contact_name: 'Other Person', email_id: 15, email: 'other@example.com' },
  { case_id: 'CASE3' },
  { case_id: 'CASEX' },
] },
// A typed mail read (the only evidence a reply may cite) and an untyped read carrying a look-alike id.
{ id: 'q2', kind: 'mail.message', purpose: 'The email', rows: [{ row_type: 'message', mail_message_id: 501, mailbox_id: 5, from: 'Pat One <pat@example.com>', subject: 'Hello' }] },
{ id: 'q3', kind: 'sql.read', purpose: 'Look-alike', rows: [{ mail_message_id: 502, row_type: 'message' }] }];
const CITE = [{ query_id: 'q1', row_number: 1 }];
const ROW = (n, q = 'q1') => ({ query_id: q, row_number: n });
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

  test('an ended row refuses; a row-level opt-out is proposed and recorded up front (ruling 17)', async () => {
    const ended = makeDb(); ended.T.contact_phones[0].end_date = '2026-10-01';
    await expect(norm(sms(), ended)).rejects.toThrow(/has ended/);
    const rowOpt = makeDb(); rowOpt.T.contact_phones[0].sms_optout = 1;
    const opted = await norm(sms(), rowOpt);
    expect(opted).toMatchObject({ kind: 'sms.send.v1', recipient: { phone_id: 12, opted_out: true } });
    expect(opted).not.toHaveProperty('acknowledge_optout');
    expect(await norm(sms())).toMatchObject({ recipient: { opted_out: false } });
    // An EMAIL opt-out does not mark a text.
    const emailOpt = makeDb(); emailOpt.T.contact_emails[0].email_optout = 1;
    await expect(norm(sms(), emailOpt)).resolves.toMatchObject({ kind: 'sms.send.v1', recipient: { opted_out: false } });
  });

  test('YisraMail P1: the number\'s consent STATE marks the draft even when the row flag is 0, and stamps consent_version', async () => {
    expect(await norm(sms())).toMatchObject({ recipient: { opted_out: false, consent_version: '0' } });
    const stateOpt = makeDb({ consent_states: [{ channel: 'sms', destination: '3135550001', scope: 'all', state: 'opted_out', last_event_id: 41 }] });
    expect(await norm(sms(), stateOpt)).toMatchObject({ recipient: { phone_id: 12, opted_out: true, consent_version: '41' } });
    // An opt-IN state still moves the version (a re-consent invalidates a stale card) but marks nothing.
    const optIn = makeDb({ consent_states: [{ channel: 'sms', destination: '3135550001', scope: 'all', state: 'opted_in', last_event_id: 42 }] });
    expect(await norm(sms(), optIn)).toMatchObject({ recipient: { opted_out: false, consent_version: '42' } });
  });

  test('the model cannot pre-acknowledge: acknowledge_optout / opted_out in the proposal are unsupported fields', async () => {
    const rowOpt = makeDb(); rowOpt.T.contact_phones[0].sms_optout = 1;
    await expect(norm(sms({ acknowledge_optout: true }), rowOpt)).rejects.toThrow(/unsupported fields: acknowledge_optout/);
    await expect(norm(email({ opted_out: false }))).rejects.toThrow(/unsupported fields: opted_out/);
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

  test('the Case field (A14X): cited and existing; an email FILES to it even when the recipient is not on it (flagged); an SMS still needs the recipient\'s own case', async () => {
    await expect(norm(email({ case_id: 'CASE2' }))).rejects.toThrow(/cited evidence row/);          // not cited
    await expect(norm(email({ case_id: 'CASEX', evidence: [ROW(1), ROW(7)] }))).rejects.toThrow(/Send case is unavailable/); // cited, does not exist
    await expect(norm(email({ case_id: 'bad id!' }))).rejects.toThrow(/case_id is invalid/);
    expect((await norm(email())).case).toEqual({ case_id: 'CASE1', label: '2:26-bk-40001', linked_to_recipient: true });
    // CASE3 exists and is cited, but Pat is not on it: the email may still be filed there — the card warns.
    expect((await norm(email({ case_id: 'CASE3', subject: 'Hi', evidence: [ROW(1), ROW(6)] }))).case).toEqual({ case_id: 'CASE3', label: '2:26-bk-40003', linked_to_recipient: false });
    const unlinked = makeDb(); unlinked.T.case_relate = [];
    expect((await norm(email(), unlinked)).case).toMatchObject({ case_id: 'CASE1', linked_to_recipient: false });
    // An SMS's case feeds placeholders only and must be the recipient's.
    await expect(norm(sms({ case_id: 'CASE1' }), unlinked)).rejects.toThrow(/not linked to the recipient/);
    await expect(norm(sms({ case_id: 'CASE3', evidence: [ROW(1), ROW(6)] }))).rejects.toThrow(/not linked to the recipient/);
    expect((await norm(sms({ case_id: 'CASE1' }))).case).toEqual({ case_id: 'CASE1', label: '2:26-bk-40001' });
  });

  test('no case is ever inferred: with no case_id the card is unfiled and no case was even looked up', async () => {
    const db = makeDb();
    const d = await norm(email({ case_id: undefined, subject: 'Hi' }), db);
    expect(d.case).toBeNull();
    expect(db.seen.some((s) => /FROM cases/.test(s))).toBe(false);
  });

  test('consent (D18): an email opt-out is marketing-only — neither the row flag nor the state marks a direct email; the version still moves', async () => {
    const rowOpt = makeDb(); rowOpt.T.contact_emails[0].email_optout = 1;
    await expect(norm(email(), rowOpt)).resolves.toMatchObject({ kind: 'email.send.v1', recipient: { email_id: 13, opted_out: false, consent_version: '0' } });
    const stateOpt = makeDb({ consent_states: [{ channel: 'email', destination: 'pat@example.com', scope: 'marketing', state: 'opted_out', last_event_id: 7 }] });
    await expect(norm(email(), stateOpt)).resolves.toMatchObject({ recipient: { opted_out: false, consent_version: '7' } });
    const smsOpt = makeDb(); smsOpt.T.contact_phones[0].sms_optout = 1;
    await expect(norm(email(), smsOpt)).resolves.toMatchObject({ kind: 'email.send.v1', recipient: { opted_out: false } });
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

  test('closed shape: attachments, html, scheduling and a typed To are refused by name; attachments / scheduling say the hub itself cannot', async () => {
    for (const k of ['attachment_urls', 'attachments', 'body_html', 'scheduled_time', 'send_at', 'to', 'media_url']) {
      await expect(norm(email({ [k]: 'x' }))).rejects.toThrow(new RegExp(`unsupported fields: ${k}`));
    }
    await expect(norm(email({ attachment_urls: ['x'] }))).rejects.toThrow(/"attachment_urls": the Comms hub itself cannot attach a file to a send \(no native route exists\)/);
    await expect(norm(email({ scheduled_time: '2026-12-01T10:00:00Z' }))).rejects.toThrow(/"scheduled_time": the Comms hub itself cannot schedule a send/);
    await expect(norm(email({ send_at: 'tomorrow', attachments: [] }))).rejects.toThrow(/cannot schedule a send.*cannot attach a file|cannot attach a file.*cannot schedule a send/s);
    // A plain unknown field gets the shape, not the "hub cannot" clause.
    await expect(norm(email({ reply_all: true }))).rejects.toThrow(/unsupported fields: reply_all — it takes contact_id, email_id, mailbox_id, subject, body, case_id, cc, bcc, in_reply_to_message_fk, quote_original, evidence \(no attachments, scheduling, HTML body or free-typed recipients/);
    await expect(norm(email({ reply_all: true }))).rejects.not.toThrow(/hub itself/);
    // SMS: nothing new — cc/bcc stay refused there, and the text names media.
    await expect(norm(sms({ media_url: 'x' }))).rejects.toThrow(/"media_url": the Comms hub itself cannot attach a file \(MMS media\) to a send/);
    await expect(norm(sms({ cc: 'x' }))).rejects.toThrow(/unsupported fields: cc — it takes .*\(no attachments \/ MMS media, cc\/bcc, scheduling or free-typed recipients\)/);
  });

  // ── A14X: cc / bcc ──
  const ccEmail = (over = {}) => email({ subject: 'Hi', cc: [{ contact_id: 1309, email_id: 14 }], bcc: [{ contact_id: 1400, email_id: 15 }],
    evidence: [ROW(1), ROW(4), ROW(5)], ...over });

  test('cc / bcc: each entry is a cited {contact_id, email_id}, reloaded active on that contact, with its own consent; the card lists them apart from the To', async () => {
    const d = await norm(ccEmail());
    expect(d.cc).toEqual([{ contact_id: 1309, contact_name: 'Pat One', email_id: 14, email: 'pat.work@example.com', label: 'Work', is_primary: false,
      expected_updated_at: STAMP.toISOString(), opted_out: false, consent_version: '0' }]);
    expect(d.bcc).toEqual([{ contact_id: 1400, contact_name: 'Other Person', email_id: 15, email: 'other@example.com', label: 'Personal', is_primary: true,
      expected_updated_at: STAMP.toISOString(), opted_out: false, consent_version: '0' }]);
    expect(d).toMatchObject({ recipient: { email_id: 13 }, recipients: 3, duplicates_dropped: 0, reply: null });
    // Absent lists are empty lists — never undefined (the builder reads them).
    expect(await norm(email())).toMatchObject({ cc: [], bcc: [], recipients: 1 });
    // A consent state on a copied address moves ITS version (D18: never opted out for a direct email).
    const state = makeDb({ consent_states: [{ channel: 'email', destination: 'other@example.com', scope: 'marketing', state: 'opted_out', last_event_id: 9 }] });
    const s = await norm(ccEmail(), state);
    expect(s.bcc[0]).toMatchObject({ opted_out: false, consent_version: '9' });
    expect(s.cc[0]).toMatchObject({ consent_version: '0' });
  });

  test('cc / bcc shape: a typed address, an un-cited entry, a non-list and an oversized list refuse by name', async () => {
    await expect(norm(ccEmail({ cc: ['pat.work@example.com'] }))).rejects.toThrow(/cc\[0\] must be \{contact_id, email_id\} — an address is never typed/);
    await expect(norm(ccEmail({ cc: [{ contact_id: 1309, email_id: 14, email: 'x@y.z' }] }))).rejects.toThrow(/cc\[0\] must be \{contact_id, email_id\}/);
    await expect(norm(ccEmail({ bcc: 'other@example.com' }))).rejects.toThrow(/bcc must be a list of \{contact_id, email_id\}/);
    await expect(norm(ccEmail({ cc: [{ contact_id: 1309, email_id: 14 }], evidence: [ROW(1), ROW(5)] }))).rejects.toThrow(/cc\[0\] \(contact 1309, email_id 14\) must be cited by an evidence row carrying both/);
    await expect(norm(ccEmail({ bcc: [{ contact_id: 1400, email_id: 15 }], evidence: [ROW(1), ROW(4)] }))).rejects.toThrow(/bcc\[0\] \(contact 1400, email_id 15\) must be cited/);
    await expect(norm(ccEmail({ cc: Array.from({ length: 11 }, () => ({ contact_id: 1309, email_id: 14 })) }))).rejects.toThrow(/cc lists 11 recipients — at most 10 \(To, Cc and Bcc together\)/);
    await expect(norm(ccEmail({ cc: [{ contact_id: 'x', email_id: 14 }] }))).rejects.toThrow(/cc contact id/);
  });

  test('cc / bcc reload: an ended row, a row on another contact and a row the mail route would refuse are refused, naming the role', async () => {
    const ended = makeDb(); ended.T.contact_emails[1].end_date = '2026-10-01';
    await expect(norm(ccEmail(), ended)).rejects.toThrow(/Send cc recipient email_id 14 has ended/);
    await expect(norm(ccEmail({ bcc: [{ contact_id: 1309, email_id: 15 }], evidence: [ROW(1), ROW(4), { query_id: 'q1', row_number: 5 }] })))
      .rejects.toThrow(/must be cited by an evidence row/);   // row 5 names contact 1400, not 1309
    const moved = makeDb(); moved.T.contact_emails[2].contact_id = 1309;
    await expect(norm(ccEmail(), moved)).rejects.toThrow(/Send bcc recipient email_id 15 is not on contact 1400/);
    const bad = makeDb(); bad.T.contact_emails[1].email = 'not an address';
    await expect(norm(ccEmail(), bad)).rejects.toThrow(/Send cc recipient email is not an address the mail route accepts/);
    // The To's own messages are unchanged.
    const endedTo = makeDb(); endedTo.T.contact_emails[0].end_date = '2026-10-01';
    await expect(norm(ccEmail(), endedTo)).rejects.toThrow(/Send recipient email_id 13 has ended/);
  });

  test('the route\'s dedupe is mirrored: one address once, To beats Cc beats Bcc, and the drop is counted for the card', async () => {
    const dup = await norm(ccEmail({ cc: [{ contact_id: 1309, email_id: 13 }, { contact_id: 1309, email_id: 14 }], bcc: [{ contact_id: 1309, email_id: 14 }, { contact_id: 1400, email_id: 15 }] }));
    expect(dup.cc.map((r) => r.email)).toEqual(['pat.work@example.com']);
    expect(dup.bcc.map((r) => r.email)).toEqual(['other@example.com']);
    expect(dup).toMatchObject({ recipients: 3, duplicates_dropped: 2 });
    // Parity: the route keeps the same survivors.
    const parsed = sendSvc.validateSendBody({ mailbox_id: 5, to: ['pat@example.com'], cc: ['pat@example.com', 'pat.work@example.com'], bcc: ['pat.work@example.com', 'other@example.com'], subject: 's', body_text: 'b' });
    expect([parsed.cc.map((r) => r.email), parsed.bcc.map((r) => r.email)]).toEqual([['pat.work@example.com'], ['other@example.com']]);
  });

  // ── A14X: reply threading ──
  const DEFAULTS = () => ({ in_reply_to_message_fk: 501, mailbox_id: 5, all: false, to: [{ email: 'pat@example.com', name: 'Pat One' }], cc: [],
    subject: 'Re: Hello', quote: { header: 'On Mon, Oct 26, 2026 at 10:00 AM, Pat One <pat@example.com> wrote:', text: 'original text' }, over_cap: false, max_recipients: 10 });
  const reply = (over = {}) => email({ subject: undefined, case_id: undefined, mailbox_id: undefined, in_reply_to_message_fk: 501, evidence: [ROW(1), ROW(1, 'q2')], ...over });

  test('a reply: the cited mail row\'s id goes to the hub\'s replyDefaults, whose From and To the card takes; the subject defaults to the hub\'s "Re: …"', async () => {
    const spy = jest.spyOn(sendSvc, 'replyDefaults').mockResolvedValue(DEFAULTS());
    const d = await norm(reply());
    expect(spy).toHaveBeenCalledWith(expect.anything(), USER, 501, {});
    expect(d).toMatchObject({
      reply: { mail_message_id: 501, mailbox_id: 5, subject: 'Re: Hello', quote_original: true, quote_header: 'On Mon, Oct 26, 2026 at 10:00 AM, Pat One <pat@example.com> wrote:', quote_chars: 13 },
      subject: 'Re: Hello', subject_defaulted: true, templated: true,        // the body's placeholder, not the subject
      sender: { mailbox_id: 5, address: 'rena@4lsg.com', defaulted: true },   // the box Comms would reply from
      recipient: { email: 'pat@example.com' }, case: null,
    });
    // A named box the user can send from is passed to the hub and kept; a given subject wins over the default.
    spy.mockResolvedValue({ ...DEFAULTS(), mailbox_id: 6 });
    const named = await norm(reply({ mailbox_id: 6, subject: 'Re: your {{contacts.contact_fname}} question', quote_original: false }));
    expect(spy).toHaveBeenLastCalledWith(expect.anything(), USER, 501, { mailbox_id: 6 });
    expect(named).toMatchObject({ sender: { mailbox_id: 6, defaulted: false }, subject: 'Re: your Pat question', subject_defaulted: false, templated: true, reply: { quote_original: false } });
    // A reply may carry cc / bcc and a case like any email.
    const full = await norm(reply({ cc: [{ contact_id: 1400, email_id: 15 }], case_id: 'CASE1', evidence: [ROW(1), ROW(5), ROW(1, 'q2')] }));
    expect(full).toMatchObject({ cc: [{ email_id: 15 }], case: { case_id: 'CASE1' }, reply: { mail_message_id: 501 } });
  });

  test('a reply refuses: an un-cited or look-alike id, a bad id, quote_original off a reply or non-boolean', async () => {
    const spy = jest.spyOn(sendSvc, 'replyDefaults').mockResolvedValue(DEFAULTS());
    await expect(norm(reply({ evidence: [ROW(1)] }))).rejects.toThrow(/in_reply_to_message_fk 501 must be the mail_message_id of a mail.search \/ mail.message read row cited in evidence/);
    await expect(norm(reply({ in_reply_to_message_fk: 502, evidence: [ROW(1), ROW(1, 'q3')] }))).rejects.toThrow(/must be the mail_message_id of a mail.search \/ mail.message read row/);
    for (const bad of ['x', 0, -1, 1.5, [501], '501abc']) {
      await expect(norm(reply({ in_reply_to_message_fk: bad }))).rejects.toThrow(/exact positive mail_message_id/);
    }
    await expect(norm(email({ quote_original: true }))).rejects.toThrow(/quote_original applies only to a reply/);
    await expect(norm(reply({ quote_original: 'yes' }))).rejects.toThrow(/quote_original must be true or false/);
    expect(spy).not.toHaveBeenCalled();   // every refusal above came before the hub was asked
    // No subject and no reply: the subject is still required.
    await expect(norm(email({ subject: undefined }))).rejects.toThrow(/subject is required/);
  });

  test('a reply refuses what the hub refuses, and what Casey narrows: unreadable, no sendable box, several or another To, a box the hub would not use', async () => {
    const spy = jest.spyOn(sendSvc, 'replyDefaults');
    spy.mockRejectedValueOnce(Object.assign(new Error('Message not found'), { status: 404 }));
    await expect(norm(reply())).rejects.toThrow(/cannot reply to message #501: it does not exist, or it is in a mailbox the user holds no read grant on/);
    spy.mockRejectedValueOnce(Object.assign(new Error('mailbox_id must be a positive integer'), { status: 400 }));
    await expect(norm(reply())).rejects.toThrow(/cannot reply to message #501: mailbox_id must be a positive integer/);
    spy.mockRejectedValueOnce(new Error('pool is closed'));
    await expect(norm(reply())).rejects.toThrow('pool is closed');            // a 5xx is not dressed as a 422
    spy.mockResolvedValueOnce({ ...DEFAULTS(), mailbox_id: null });
    await expect(norm(reply())).rejects.toThrow(/no mailbox the user can send from can answer it/);
    spy.mockResolvedValueOnce({ ...DEFAULTS(), to: [{ email: 'pat@example.com' }, { email: 'other@example.com' }] });
    await expect(norm(reply())).rejects.toThrow(/would go to 2 addresses \(pat@example.com, other@example.com\) — Casey replies to ONE recipient/);
    spy.mockResolvedValueOnce({ ...DEFAULTS(), to: [] });
    await expect(norm(reply())).rejects.toThrow(/would go to no address/);
    spy.mockResolvedValueOnce({ ...DEFAULTS(), to: [{ email: 'trustee@court.test' }] });
    await expect(norm(reply())).rejects.toThrow(/goes to trustee@court.test, not to the cited email row \(pat@example.com\)/);
    // Case-insensitive on the address.
    spy.mockResolvedValueOnce({ ...DEFAULTS(), to: [{ email: 'PAT@Example.com' }] });
    await expect(norm(reply())).resolves.toMatchObject({ reply: { mail_message_id: 501 } });
    // A named box the user cannot send as is refused with the hub's reason before anything else.
    spy.mockResolvedValue(DEFAULTS());
    await expect(norm(reply({ mailbox_id: 99 }))).rejects.toThrow(/Mailbox 99 cannot be used: Mailbox not found/);
    // Belt and braces: a sendable named box the hub would NOT answer from (its pick differs) is refused.
    mailboxes[7] = { id: 7, address: 'other@4lsg.com', display_name: null, sendable: true };
    await expect(norm(reply({ mailbox_id: 7 }))).rejects.toThrow(/cannot reply to message #501 from mailbox 7 — the hub answers it from mailbox 5/);
    // The hub's subject is capped like a typed one.
    spy.mockResolvedValueOnce({ ...DEFAULTS(), subject: `Re: ${'s'.repeat(500)}` });
    await expect(norm(reply())).rejects.toThrow(/its subject is too long to reuse/);
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
