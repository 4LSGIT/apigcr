// tests/emailService.marketingOptions.test.js
//
/**
 * YisraMail T1 — the marketing path's contract in services/emailService.js
 * (ref/YISRAMAIL_DESIGN.md §5.2): bulk_ok rows send ONLY through
 * sendEmailDirect({bulk:true}); headers / reply_to / tags exist only there;
 * the public sendEmail strips all four and refuses a bulk_ok row outright,
 * and that refusal is permanent for campaignService.isTransientError.
 * Run: npx jest tests/emailService.marketingOptions.test.js
 *
 * Real emailService + real adapters; mocked: nodemailer's SMTP transport
 * (capture mailOptions) and credentialInjection's token minting (gmail).
 */

'use strict';

const mockSendMail = jest.fn();
jest.mock('nodemailer', () => {
  const actual = jest.requireActual('nodemailer');
  return { ...actual, createTransport: jest.fn(() => ({ sendMail: mockSendMail })) };
});
jest.mock('../lib/credentialInjection', () => {
  const actual = jest.requireActual('../lib/credentialInjection');
  return { ...actual, loadCredential: jest.fn(async (db, id) => ({ id, name: 'G', type: 'oauth2' })) };
});

const emailService = require('../services/emailService');
const smtp = require('../services/adapters/email/smtp');
const gmail = require('../services/adapters/email/gmail');
const pabbly = require('../services/adapters/email/pabbly');
const { isTransientError } = require('../services/campaignService');
const { encrypt } = require('../lib/credentialCrypto');

const SES_ROW = { id: 17, email: 'news@news.test', from_name: 'Firm News', provider: 'smtp', credential_id: null,
  smtp_host: 'email-smtp.us-east-2.amazonaws.com', smtp_port: 587, smtp_secure: 0, smtp_user: 'AKIAEXAMPLE', smtp_pass: encrypt('pw'),
  bulk_ok: 1, events_driver: 'ses', driver_config: { configuration_set: 'yisramail-marketing' } };
const PLAIN_ROW = { id: 4, email: 'it@mdbl.test', from_name: 'IT', provider: 'smtp', credential_id: null,
  smtp_host: 'mail.mdbl.test', smtp_port: 587, smtp_secure: 0, smtp_user: 'it@mdbl.test', smtp_pass: encrypt('pw'),
  bulk_ok: 0, events_driver: null, driver_config: null };
const GMAIL_ROW = { id: 1, email: 'stuart@firm.test', from_name: 'Stuart', provider: 'gmail', credential_id: 11, bulk_ok: 0 };
const MSG = { from: 'news@news.test', to: 'x@y.test', subject: 's', text: 't' };
const HEADERS = {
  'List-Unsubscribe': '<https://app.example/u/T1ACCEPTANCE000000000>',
  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  'List-Id': '<news.news.test>',
};
const MKT = { bulk: true, headers: HEADERS, reply_to: 'office@firm.test', tags: { campaign_id: 't1', result_id: 't1' } };
const db = () => ({ query: jest.fn(async () => [[]]) });

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  mockSendMail.mockReset();
  mockSendMail.mockImplementation(async (o) => ({ messageId: '<auto@x>', response: '250 Ok 0100018b5f6a1b2c-1a2b3c4d-5e6f-7a8b-9c0d-ef1234567890-000000', accepted: [o.to], rejected: [] }));
});
afterEach(() => jest.restoreAllMocks());

const rejects = async (p, code) => {
  let err;
  try { await p; } catch (e) { err = e; }
  expect(err).toBeDefined();
  expect(err.code).toBe(code);
  expect(err.message.startsWith(`${code}: `)).toBe(true);
  return err;
};

describe('capabilities (the adapter contract)', () => {
  test('smtp: bulk / headers / tags yes, batch / events no; gmail and pabbly: all five no', () => {
    const five = (c) => ({ bulk: c.bulk, headers: c.headers, tags: c.tags, batch: c.batch, events: c.events });
    expect(five(smtp.capabilities)).toEqual({ bulk: true, headers: true, tags: true, batch: false, events: false });
    expect(five(gmail.capabilities)).toEqual({ bulk: false, headers: false, tags: false, batch: false, events: false });
    expect(five(pabbly.capabilities)).toEqual({ bulk: false, headers: false, tags: false, batch: false, events: false });
  });
  test('the option lists', () => {
    expect(emailService.MARKETING_ONLY_OPTIONS).toEqual(['bulk', 'headers', 'reply_to', 'tags', 'log_body']);
    expect(emailService.MARKETING_HEADERS).toEqual(['List-Unsubscribe', 'List-Unsubscribe-Post', 'List-Id']);
    expect(emailService.HUB_ONLY_OPTIONS).toEqual(['cc', 'bcc', 'in_reply_to', 'references', 'message_id', 'thread_id']);
    expect(emailService.VALID_EVENTS_DRIVERS).toEqual(['ses']);
  });
});

describe('sendEmailDirect: the bulk fence', () => {
  test('a bulk_ok row without bulk:true is refused before any provider call — whatever the row value says', async () => {
    for (const bulk_ok of [1, true, '1', 'yes']) {
      await rejects(emailService.sendEmailDirect(db(), { ...SES_ROW, bulk_ok }, MSG), 'bulk_row_requires_marketing_path');
    }
    // the hub's own options do not open it either
    await rejects(emailService.sendEmailDirect(db(), SES_ROW, { ...MSG, cc: 'c@x.test', bulk: 1 }), 'bulk_row_requires_marketing_path');
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('bulk:true on a row that is not bulk_ok is refused', async () => {
    for (const bulk_ok of [0, false, null, undefined, '0']) {
      await rejects(emailService.sendEmailDirect(db(), { ...PLAIN_ROW, bulk_ok }, { ...MSG, bulk: true }), 'bulk_requires_bulk_row');
    }
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('headers / reply_to / tags without bulk:true are a programming error — thrown, never stripped', async () => {
    for (const o of [{ headers: HEADERS }, { reply_to: 'office@firm.test' }, { tags: { a: 'b' } }, { headers: {} }]) {
      await rejects(emailService.sendEmailDirect(db(), PLAIN_ROW, { ...MSG, ...o }), 'marketing_options_require_bulk');
    }
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('a plain row with none of them sends exactly as before (no new mailOptions key)', async () => {
    await emailService.sendEmailDirect(db(), PLAIN_ROW, { ...MSG, from: 'it@mdbl.test' });
    expect(Object.keys(mockSendMail.mock.calls[0][0])).toEqual(['from', 'to', 'subject', 'text', 'html']);
  });

  test('the marketing path: canonical headers, the reply-to, the tags and the driver reach the adapter', async () => {
    const spy = jest.spyOn(smtp, 'sendEmail');
    await emailService.sendEmailDirect(db(), SES_ROW, { ...MSG, ...MKT,
      headers: { 'list-unsubscribe': HEADERS['List-Unsubscribe'], 'LIST-UNSUBSCRIBE-POST': 'List-Unsubscribe=One-Click', 'List-Id': '<news.news.test>' } });
    const a = spy.mock.calls[0][1];
    expect(a.headers).toEqual(HEADERS);
    expect(a.replyTo).toBe('office@firm.test');
    expect(a.tags).toEqual({ campaign_id: 't1', result_id: 't1' });
    expect(a.driver && a.driver.name).toBe('ses');
  });
});

describe('sendEmailDirect: validation of the marketing options', () => {
  const send = (o) => emailService.sendEmailDirect(db(), SES_ROW, { ...MSG, bulk: true, ...o });

  test('a header outside the allowlist is refused (and nothing is sent)', async () => {
    for (const h of [{ 'X-Mailer': 'x' }, { 'Reply-To': 'a@b.test' }, { 'X-SES-CONFIGURATION-SET': 'other' }, { 'List-Unsubscribe ': 'x' }]) {
      await rejects(send({ headers: h }), 'marketing_header_refused');
    }
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('values: CR / LF / NUL, > 998 bytes, non-strings, empty and duplicates-by-case are refused', async () => {
    for (const v of ['<https://a.test/u/x>\r\nBcc: victim@x.test', 'a\nb', 'a\0b', 'é'.repeat(500), 42, '']) {
      await rejects(send({ headers: { 'List-Unsubscribe': v } }), 'marketing_header_refused');
    }
    await rejects(send({ headers: { 'List-Id': '<a>', 'list-id': '<b>' } }), 'marketing_header_refused');
    await rejects(send({ headers: ['List-Id'] }), 'marketing_header_refused');
    // exactly 998 bytes is fine
    await send({ headers: { 'List-Id': 'a'.repeat(998) } });
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  test('reply_to: one address by the hub\'s own rule', async () => {
    for (const r of ['office@firm.test, other@firm.test', 'not-an-address', 'a@b.test\r\nBcc: x@y.test', { email: 'office@firm.test' }, ['office@firm.test']]) {
      await rejects(send({ reply_to: r }), 'marketing_reply_to_invalid');
    }
    const spy = jest.spyOn(smtp, 'sendEmail');
    await send({ reply_to: 'Firm Office <office@firm.test>' });
    expect(spy.mock.calls[0][1].replyTo).toBe('"Firm Office" <office@firm.test>');
  });

  test('tags: [A-Za-z0-9_-]{1,256} keys and string values, at most 10', async () => {
    for (const t of [{ 'campaign id': '1' }, { campaign_id: 't 1' }, { campaign_id: 'a=b' }, { campaign_id: 'x,y' }, { c: 7 },
      { k: 'x'.repeat(257) }, Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, 'v'])), ['a']]) {
      await rejects(send({ tags: t }), 'marketing_tags_invalid');
    }
    await send({ tags: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, 'v'.repeat(256)])) });
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });
});

describe('drivers and capabilities', () => {
  test('an unknown events_driver is refused at send — no dynamic lookup', async () => {
    for (const d of ['mailgun', 'constructor', '__proto__', 'SES']) {
      await rejects(emailService.sendEmailDirect(db(), { ...SES_ROW, events_driver: d }, { ...MSG, bulk: true }), 'unknown_events_driver');
    }
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('gmail never takes the marketing path or a driver', async () => {
    await rejects(emailService.sendEmailDirect(db(), { ...GMAIL_ROW, bulk_ok: 1 }, { ...MSG, bulk: true }), 'adapter_lacks_capability');
    await rejects(emailService.sendEmailDirect(db(), { ...GMAIL_ROW, bulk_ok: 1, events_driver: 'ses' }, { ...MSG, bulk: true }), 'adapter_lacks_capability');
    const pab = { id: 9, email: 'p@firm.test', from_name: 'P', provider: 'pabbly', bulk_ok: 1 };
    await rejects(emailService.sendEmailDirect(db(), pab, { ...MSG, bulk: true, headers: HEADERS }), 'adapter_lacks_capability');
  });

  test('a driver on a row that is not bulk_ok fails loudly — its headers never ride operational or hub mail', async () => {
    const plainWithDriver = { ...PLAIN_ROW, events_driver: 'ses', driver_config: { configuration_set: 'ops' } };
    await rejects(emailService.sendEmailDirect(db(), plainWithDriver, { ...MSG, from: 'it@mdbl.test' }), 'events_driver_requires_bulk');
    await rejects(emailService.sendEmailDirect(db(), plainWithDriver, { ...MSG, from: 'it@mdbl.test', cc: 'c@x.test' }), 'events_driver_requires_bulk');
    const dbRow = { query: jest.fn(async (sql) => (/FROM email_credentials/.test(sql) ? [[plainWithDriver]] : [{}])) };
    await rejects(emailService.sendEmail(dbRow, { ...MSG, from: 'it@mdbl.test' }), 'events_driver_requires_bulk');
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('a bulk row whose driver has no config and no tags to add: no headers key at all', async () => {
    await emailService.sendEmailDirect(db(), { ...SES_ROW, driver_config: null }, { ...MSG, bulk: true });
    expect('headers' in mockSendMail.mock.calls[0][0]).toBe(false);
  });
});

describe('the public sendEmail', () => {
  const dbWith = (row) => ({ query: jest.fn(async (sql) => (/FROM email_credentials/.test(sql) ? [[row]] : [{}])) });

  test('strips the four marketing options — an automation caller can never set them', async () => {
    const spy = jest.spyOn(smtp, 'sendEmail');
    await emailService.sendEmail(dbWith(PLAIN_ROW), { ...MSG, from: 'it@mdbl.test', headers: HEADERS, reply_to: 'office@firm.test', tags: { a: 'b' } });
    const a = spy.mock.calls[0][1];
    for (const k of ['headers', 'replyTo', 'tags', 'driver']) expect(a[k]).toBeUndefined();
    expect(Object.keys(mockSendMail.mock.calls[0][0]).sort()).toEqual(['from', 'html', 'subject', 'text', 'to']);
    // a stray bulk:true is stripped too — the plain row still sends
    await emailService.sendEmail(dbWith(PLAIN_ROW), { ...MSG, from: 'it@mdbl.test', bulk: true });
    expect(mockSendMail).toHaveBeenCalledTimes(2);
  });

  test('refuses a bulk_ok row outright — even with every marketing option passed', async () => {
    const err = await rejects(emailService.sendEmail(dbWith(SES_ROW), { ...MSG, ...MKT }), 'bulk_sender_refused');
    expect(err.message).toBe('bulk_sender_refused: news@news.test is a marketing transport; automation, workflows and operational campaigns cannot send from it');
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('the refusal is PERMANENT for campaignService.isTransientError — whatever the address says', async () => {
    const err = await rejects(emailService.sendEmail(dbWith(SES_ROW), MSG), 'bulk_sender_refused');
    expect(isTransientError(err)).toBe(false);
    for (const email of ['timeout@news.test', 'news503@news.test', 'ratelimit@news.test']) {
      const e = await rejects(emailService.sendEmail(dbWith({ ...SES_ROW, email }), { ...MSG, from: email }), 'bulk_sender_refused');
      expect(isTransientError(e)).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// YisraMail C2 — log_body:false (the marketing broadcast's email_log row
// without its body) and the reworded bulk fence (D16: two bulk callers)
// ─────────────────────────────────────────────────────────────
describe('C2: log_body:false — the email_log row keeps the envelope, not the body', () => {
  const logged = (d) => d.query.mock.calls.filter((c) => /INSERT INTO email_log/.test(c[0])).map((c) => c[1]);

  test('marketing send with List-Unsubscribe: the success row body is LOG_BODY_OMITTED, delivery_info kept', async () => {
    const d = db();
    await emailService.sendEmailDirect(d, SES_ROW, { ...MSG, ...MKT, html: '<p>secret newsletter body</p>', text: 'secret newsletter body', log_body: false });
    const rows = logged(d);
    expect(rows).toHaveLength(1);
    expect(rows[0][4]).toBe(smtp.LOG_BODY_OMITTED);
    expect(rows[0][4]).not.toMatch(/secret/);
    expect(JSON.parse(rows[0][5]).response).toMatch(/^250 Ok/);
    expect(rows[0][1]).toBe('news@news.test');                    // envelope kept
  });

  test('without log_body (the D16 over-cap send, any operational send) the body is logged as before', async () => {
    const d = db();
    await emailService.sendEmailDirect(d, SES_ROW, { ...MSG, bulk: true, tags: { campaign_id: '1', result_id: '2' }, text: 'ops body' });
    expect(logged(d)[0][4]).toBe('ops body');
  });

  test('refused: log_body other than false; false without a List-Unsubscribe header; false without bulk', async () => {
    for (const v of [true, 0, '', 'false', {}]) {
      await rejects(emailService.sendEmailDirect(db(), SES_ROW, { ...MSG, ...MKT, log_body: v }), 'marketing_log_body_refused');
    }
    await rejects(emailService.sendEmailDirect(db(), SES_ROW, { ...MSG, bulk: true, log_body: false }), 'marketing_log_body_refused');
    await rejects(emailService.sendEmailDirect(db(), SES_ROW, { ...MSG, bulk: true, headers: { 'List-Id': '<a.b.test>' }, log_body: false }), 'marketing_log_body_refused');
    await rejects(emailService.sendEmailDirect(db(), PLAIN_ROW, { ...MSG, from: 'it@mdbl.test', log_body: false }), 'marketing_options_require_bulk');
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('an adapter without log_without_body cannot be asked to drop it (fail closed)', async () => {
    const caps = smtp.capabilities.log_without_body;
    try {
      smtp.capabilities.log_without_body = false;
      await rejects(emailService.sendEmailDirect(db(), SES_ROW, { ...MSG, ...MKT, log_body: false }), 'adapter_lacks_capability');
    } finally { smtp.capabilities.log_without_body = caps; }
    expect(smtp.capabilities.log_without_body).toBe(true);
    expect(gmail.capabilities.log_without_body).toBeFalsy();
    expect(pabbly.capabilities.log_without_body).toBeFalsy();
  });

  test('the public sendEmail strips log_body like the other bulk options (the body is logged)', async () => {
    const d = { query: jest.fn(async (sql) => (/FROM email_credentials/.test(sql) ? [[PLAIN_ROW]] : [{}])) };
    await emailService.sendEmail(d, { ...MSG, from: 'it@mdbl.test', log_body: false });
    expect(logged(d)[0][4]).toBe('t');
  });

  test('the bulk fence message names BOTH bulk callers (marketing, operational over the cap) — D16', async () => {
    const err = await rejects(emailService.sendEmailDirect(db(), SES_ROW, MSG), 'bulk_row_requires_marketing_path');
    expect(err.message).toBe('bulk_row_requires_marketing_path: email_credentials 17 (news@news.test) is a marketing (bulk) transport; only a campaign bulk send (bulk:true — the marketing path, or an operational campaign confirmed over the cap) may send from it');
  });
});
