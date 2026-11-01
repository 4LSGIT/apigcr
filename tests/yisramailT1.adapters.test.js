// tests/yisramailT1.adapters.test.js
//
/**
 * YisraMail T1 — what the smtp adapter and the SES driver put on the wire
 * (services/adapters/email/smtp.js, services/adapters/email/drivers/ses.js;
 * ref/YISRAMAIL_DESIGN.md §5.2). The key-set pin of a call WITHOUT the new
 * options stays in tests/mailboxS3.adapters.test.js (unchanged).
 * Run: npx jest tests/yisramailT1.adapters.test.js
 *
 * Mocked: nodemailer's SMTP transport (capture mailOptions); the MIME is then
 * built by the REAL nodemailer (streamTransport), as the S3 test does.
 */

'use strict';

const mockSendMail = jest.fn();
jest.mock('nodemailer', () => {
  const actual = jest.requireActual('nodemailer');
  return { ...actual, createTransport: jest.fn(() => ({ sendMail: mockSendMail })) };
});

const emailService = require('../services/emailService');
const smtp = require('../services/adapters/email/smtp');
const ses = require('../services/adapters/email/drivers/ses');
const { encrypt } = require('../lib/credentialCrypto');

const SES_LINE = '250 Ok 0100018b5f6a1b2c-1a2b3c4d-5e6f-7a8b-9c0d-ef1234567890-000000';
const SES_ID = '0100018b5f6a1b2c-1a2b3c4d-5e6f-7a8b-9c0d-ef1234567890-000000';
const ROW = { id: 17, email: 'news@news.test', from_name: 'Firm News', provider: 'smtp', credential_id: null,
  smtp_host: 'email-smtp.us-east-2.amazonaws.com', smtp_port: 587, smtp_secure: 0, smtp_user: 'AKIAEXAMPLE', smtp_pass: encrypt('pw'),
  bulk_ok: 1, events_driver: 'ses', driver_config: { configuration_set: 'yisramail-marketing' } };
const HEADERS = {
  'List-Unsubscribe': '<https://app.example/u/T1ACCEPTANCE000000000>',
  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  'List-Id': '<news.news.test>',
};
const TAGS = { campaign_id: 't1', result_id: 't1' };
const base = { from: 'news@news.test', fromName: 'Firm News', to: 'x@y.test', subject: 's', text: 't', html: '<p>t</p>', emailRow: ROW };
const db = () => ({ calls: [], query(sql, p) { this.calls.push({ sql, p }); return Promise.resolve([[]]); } });

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  mockSendMail.mockReset();
  mockSendMail.mockImplementation(async (o) => ({ messageId: '<auto@x>', response: SES_LINE, accepted: [o.to], rejected: [] }));
});
afterEach(() => jest.restoreAllMocks());

describe('smtp adapter on the marketing path', () => {
  test('mailOptions carry exactly the allowlisted headers + the driver\'s two, and replyTo', async () => {
    await smtp.sendEmail(db(), { ...base, headers: HEADERS, replyTo: 'office@firm.test', tags: TAGS, driver: ses });
    const o = mockSendMail.mock.calls[0][0];
    expect(o.headers).toEqual({ ...HEADERS, 'X-SES-CONFIGURATION-SET': 'yisramail-marketing', 'X-SES-MESSAGE-TAGS': 'campaign_id=t1, result_id=t1' });
    expect(Object.keys(o.headers)).toEqual(['List-Unsubscribe', 'List-Unsubscribe-Post', 'List-Id', 'X-SES-CONFIGURATION-SET', 'X-SES-MESSAGE-TAGS']);
    expect(o.replyTo).toBe('office@firm.test');
    expect(Object.keys(o)).toEqual(['from', 'to', 'subject', 'text', 'html', 'headers', 'replyTo']);
  });

  test('the REAL MIME build shows every header on the wire', async () => {
    const actual = jest.requireActual('nodemailer');
    const t = actual.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    await smtp.sendEmail(db(), { ...base, headers: HEADERS, replyTo: 'office@firm.test', tags: TAGS, driver: ses });
    const raw = (await t.sendMail(mockSendMail.mock.calls[0][0])).message.toString('utf8');
    const head = raw.split('\n\n')[0];
    // nodemailer re-cases header NAMES on the wire (List-ID, X-Ses-Message-Tags):
    // field names are case-insensitive (RFC 5322 §1.2.2) — that SES matches its
    // own headers that way is confirmed by scripts/yisramailT1Acceptance.js
    // --check (SES strips the headers it recognized).
    expect(head).toMatch(/^List-Unsubscribe: <https:\/\/app\.example\/u\/T1ACCEPTANCE000000000>$/m);
    expect(head).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m);
    expect(head).toMatch(/^List-ID: <news\.news\.test>$/m);
    expect(head).toMatch(/^X-Ses-Message-Tags: campaign_id=t1, result_id=t1$/m);
    expect(head).toMatch(/^X-Ses-Configuration-Set: yisramail-marketing$/m);
    expect(head).toMatch(/^Reply-To: office@firm\.test$/m);
    expect(head.match(/^[A-Za-z-]+(?=:)/gm).filter((n) => /^(list-|x-ses-|reply-to)/i.test(n)))
      .toEqual(['List-Unsubscribe', 'List-Unsubscribe-Post', 'List-ID', 'X-Ses-Configuration-Set', 'X-Ses-Message-Tags', 'Reply-To']);
  });

  test('providerMessageId: parsed from the 250 line by the driver; null without one or when it does not parse', async () => {
    const d = db();
    const info = await smtp.sendEmail(d, { ...base, driver: ses });
    expect(info.providerMessageId).toBe(SES_ID);
    // email_log is unchanged: one outbound-smtp row, delivery_info.response = the raw line
    const logs = d.calls.filter((c) => /INSERT INTO email_log/.test(c.sql));
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0].p[5]).response).toBe(SES_LINE);
    expect((await smtp.sendEmail(db(), { ...base, emailRow: { ...ROW, events_driver: null } })).providerMessageId).toBeNull();
    mockSendMail.mockImplementation(async (o) => ({ messageId: '<auto@x>', response: '250 2.0.0 OK queued as ABC', accepted: [o.to], rejected: [] }));
    expect((await smtp.sendEmail(db(), { ...base, driver: ses })).providerMessageId).toBeNull();
  });

  test('a driver header outside driver.HEADERS (or a bad value) throws before anything is sent', async () => {
    const rogue = { ...ses, name: 'rogue', headersFor: () => ({ 'X-SES-MESSAGE-TAGS': 'a=b', Bcc: 'victim@x.test' }) };
    await expect(smtp.sendEmail(db(), { ...base, driver: rogue })).rejects.toThrow(/may not set header "Bcc"/);
    const crlf = { ...ses, name: 'crlf', headersFor: () => ({ 'X-SES-MESSAGE-TAGS': 'a=b\r\nBcc: v@x.test' }) };
    await expect(smtp.sendEmail(db(), { ...base, driver: crlf })).rejects.toThrow(/invalid value/);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('end to end through sendEmailDirect with the SES row', async () => {
    const info = await emailService.sendEmailDirect(db(), ROW, { from: ROW.email, to: 'x@y.test', subject: 's', text: 't',
      bulk: true, headers: HEADERS, reply_to: 'office@firm.test', tags: TAGS });
    const o = mockSendMail.mock.calls[0][0];
    expect(o.headers['X-SES-MESSAGE-TAGS']).toBe('campaign_id=t1, result_id=t1');
    expect(o.replyTo).toBe('office@firm.test');
    expect(info.providerMessageId).toBe(SES_ID);
  });
});

describe('the SES driver', () => {
  test('headersFor: only its two headers, each only when it has a value', () => {
    expect(ses.HEADERS).toEqual(['X-SES-CONFIGURATION-SET', 'X-SES-MESSAGE-TAGS']);
    expect(ses.headersFor({ emailRow: ROW, tags: TAGS })).toEqual({ 'X-SES-CONFIGURATION-SET': 'yisramail-marketing', 'X-SES-MESSAGE-TAGS': 'campaign_id=t1, result_id=t1' });
    expect(ses.headersFor({ emailRow: { ...ROW, driver_config: null }, tags: TAGS })).toEqual({ 'X-SES-MESSAGE-TAGS': 'campaign_id=t1, result_id=t1' });
    expect(ses.headersFor({ emailRow: { ...ROW, driver_config: '{"configuration_set":"cs-1"}' } })).toEqual({ 'X-SES-CONFIGURATION-SET': 'cs-1' });
    expect(ses.headersFor({ emailRow: { ...ROW, driver_config: {} }, tags: {} })).toEqual({});
  });

  test('validateConfig: null, or {configuration_set} with an SES name — anything else is a message', () => {
    expect(ses.validateConfig(null)).toBeNull();
    expect(ses.validateConfig({ configuration_set: 'yisramail-marketing' })).toBeNull();
    expect(ses.validateConfig('{"configuration_set":"a_b-1"}')).toBeNull();
    for (const bad of [{ configuration_set: 'has space' }, { configuration_set: 'x'.repeat(65) }, { configuration_set: 3 },
      { other: 'x' }, ['configuration_set'], 'not json', 5]) {
      expect(typeof ses.validateConfig(bad)).toBe('string');
    }
    expect(() => ses.headersFor({ emailRow: { ...ROW, driver_config: { configuration_set: 'a\r\nb' } } })).toThrow(/configuration_set/);
  });

  test('messageIdFromResponse', () => {
    expect(ses.messageIdFromResponse(SES_LINE)).toBe(SES_ID);
    expect(ses.messageIdFromResponse(`250 Ok <${SES_ID}>`)).toBe(SES_ID);
    expect(ses.messageIdFromResponse(`${SES_LINE}\r\n`)).toBe(SES_ID);
    for (const r of [null, undefined, '', '250 OK', '550 Ok 0100018b5f6a1b2c', '250 2.0.0 Ok: queued as 4ABC', 42]) {
      expect(ses.messageIdFromResponse(r)).toBeNull();
    }
    expect(typeof ses.events.parseDetailed).toBe('function');   // T2 filled the driver's events (tests/sesEvents.parse.test.js)
  });

  test('emailService.validateDriverConfig: the editor\'s check', () => {
    expect(emailService.validateDriverConfig(null, null)).toBeNull();
    expect(emailService.validateDriverConfig('', null)).toBeNull();
    expect(emailService.validateDriverConfig(null, { configuration_set: 'x' })).toMatch(/needs an events_driver/);
    expect(emailService.validateDriverConfig('mailgun', null)).toMatch(/unknown events_driver/);
    expect(emailService.validateDriverConfig('ses', { configuration_set: 'ok' })).toBeNull();
    expect(emailService.validateDriverConfig('ses', { nope: 1 })).toMatch(/unknown key/);
  });
});
