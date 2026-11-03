// tests/emailNoFileAccess.test.js
//
/**
 * YisraMail C2 security fix — an email attachment `path` is NEVER read from the local disk.
 * nodemailer (smtp transport, and the MailComposer the gmail adapter compiles with) reads any
 * attachment `path` that is not a URL as a FILE: '/proc/self/environ' would have mailed the
 * server's secrets to whoever picked the recipient. The smtp adapter's transport and the gmail
 * adapter's MailComposer both set disableFileAccess (URL paths and inline content keep working;
 * disableUrlAccess is not set).
 *
 * The smtp transport here is REAL nodemailer (streamTransport) built from the config the adapter
 * passes — so the adapter's own flag decides whether the file is read.
 * Run: npx jest tests/emailNoFileAccess.test.js
 */
'use strict';

const transportConfigs = [];
jest.mock('nodemailer', () => {
  const actual = jest.requireActual('nodemailer');
  return {
    ...actual,
    createTransport: jest.fn((cfg) => {
      transportConfigs.push(cfg);
      const t = actual.createTransport({ streamTransport: true, buffer: true, disableFileAccess: cfg.disableFileAccess, disableUrlAccess: cfg.disableUrlAccess });
      return { sendMail: async (o) => { const info = await t.sendMail(o); return { ...info, response: '250 Ok', accepted: [o.to], rejected: [] }; } };
    }),
  };
});
jest.mock('../lib/credentialInjection', () => {
  const actual = jest.requireActual('../lib/credentialInjection');
  return { ...actual, loadCredential: jest.fn(async (db, id) => ({ id, name: 'G', type: 'oauth2' })) };
});

const emailService = require('../services/emailService');
const { encrypt } = require('../lib/credentialCrypto');

const PLAIN_ROW = { id: 4, email: 'it@mdbl.test', from_name: 'IT', provider: 'smtp', credential_id: null,
  smtp_host: 'mail.mdbl.test', smtp_port: 587, smtp_secure: 0, smtp_user: 'it@mdbl.test', smtp_pass: encrypt('pw'), bulk_ok: 0 };
const GMAIL_ROW = { id: 1, email: 'stuart@firm.test', from_name: 'Stuart', provider: 'gmail', credential_id: 11, bulk_ok: 0 };
const MSG = { from: 'it@mdbl.test', to: 'x@y.test', subject: 's', text: 't' };
const SECRET_FILE = __filename;   // any readable local file stands in for /proc/self/environ
const db = () => ({ query: jest.fn(async () => [[]]) });

beforeEach(() => {
  transportConfigs.length = 0;
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('smtp adapter', () => {
  test('the transport is built with disableFileAccess (and NOT disableUrlAccess)', async () => {
    await emailService.sendEmailDirect(db(), PLAIN_ROW, MSG);
    expect(transportConfigs[0].disableFileAccess).toBe(true);
    expect(transportConfigs[0].disableUrlAccess).toBeUndefined();
  });

  test('a local-path attachment — inline nodemailer form or as attachment_urls — fails the send (EFILEACCESS)', async () => {
    for (const o of [{ attachments: [{ filename: 'env', path: SECRET_FILE }] }, { attachment_urls: SECRET_FILE }, { attachment_urls: [{ url: SECRET_FILE, name: 'env' }] }]) {
      // EFILEACCESS is the stream transport's code; a real SMTP transport reports the same refusal as
      // ESTREAM (executeSend classifies it definite + permanent) — both refuse to read the file.
      await expect(emailService.sendEmailDirect(db(), PLAIN_ROW, { ...MSG, ...o })).rejects.toMatchObject({ code: 'EFILEACCESS' });
    }
  });

  test('inline content attachments still send', async () => {
    const info = await emailService.sendEmailDirect(db(), PLAIN_ROW, { ...MSG, attachments: [{ filename: 'a.txt', content: 'inline-ok' }] });
    expect(info.message.toString()).toContain(Buffer.from('inline-ok').toString('base64'));
  });
});

describe('gmail adapter', () => {
  test('a local-path attachment fails at MIME compile — before any token or provider call', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    await expect(emailService.sendEmailDirect(db(), GMAIL_ROW, { ...MSG, from: 'stuart@firm.test', attachments: [{ filename: 'env', path: SECRET_FILE }] }))
      .rejects.toThrow(/File access rejected/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
