// tests/smtpAdapter.deliveryInfo.test.js
//
// Guards the 2026-09-15 delivery_info slice: services/adapters/email/smtp.js
// must PERSIST what the SMTP relay said, because an email_log row on its own
// proves only that the relay took the handoff — not that anything was
// delivered, and not that it escaped the recipient's spam folder.
//
// nodemailer and credentialCrypto are mocked (dependencies, not the module
// under test); the adapter itself runs for real against a fake db that records
// the INSERT it is handed.

'use strict';

const mockSendMail = jest.fn();
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: mockSendMail })),
}));
jest.mock('../lib/credentialCrypto', () => ({
  isEncrypted: jest.fn(() => true),
  decrypt:     jest.fn(() => 'plaintext-pw'),
}));

const smtp = require('../services/adapters/email/smtp');

const EMAIL_ROW = {
  id: 4,
  smtp_host: 'gcam1191.siteground.biz',
  smtp_port: 587,
  smtp_secure: false,
  smtp_user: 'IT@metrodetroitbankruptcylaw.com',
  smtp_pass: 'ENCv1:whatever',
};

/** Fake db that records every query. `.query` must return a thenable. */
function makeDb() {
  const calls = [];
  return {
    calls,
    query: jest.fn((sql, params) => { calls.push({ sql, params }); return Promise.resolve([{}]); }),
  };
}

/** The email_log INSERT the adapter emitted, parsed into named fields. */
function loggedRow(db) {
  const call = db.calls.find(c => /INSERT INTO email_log/.test(c.sql));
  if (!call) return null;
  const cols = /INSERT INTO email_log \(([^)]+)\)/.exec(call.sql)[1]
    .split(',').map(s => s.trim());
  const row = {};
  // First column is the literal 'outbound-smtp'; params line up after it.
  cols.slice(1).forEach((c, i) => { row[c] = call.params[i]; });
  row.__cols = cols;
  return row;
}

const send = (db, over = {}) => smtp.sendEmail(db, {
  from: 'it@metrodetroitbankruptcylaw.com',
  to: 'it@4lsg.com',
  subject: '[YC-ALERT:INFO] Test',
  text: 'body',
  emailRow: EMAIL_ROW,
  ...over,
});

beforeEach(() => { mockSendMail.mockReset(); jest.clearAllMocks(); });

describe('smtp adapter delivery_info', () => {
  test('the INSERT carries a delivery_info column, positioned before processed_at', async () => {
    mockSendMail.mockResolvedValue({ messageId: '<a@b>', response: '250 OK', accepted: ['it@4lsg.com'], rejected: [] });
    const db = makeDb();
    await send(db);
    const row = loggedRow(db);
    expect(row.__cols).toContain('delivery_info');
    // Guards the params/columns alignment that a positional INSERT depends on.
    expect(row.__cols).toEqual(
      ['source', 'message_id', 'from_email', 'to_email', 'subject', 'body', 'delivery_info', 'processed_at']
    );
  });

  test('persists the relay reply line — the queue id is the only trace handle', async () => {
    mockSendMail.mockResolvedValue({
      messageId: '<a@b>',
      response: '250 2.0.0 Ok: queued as 4cKp1R2b',
      accepted: ['it@4lsg.com'],
      rejected: [],
      envelope: { from: 'it@metrodetroitbankruptcylaw.com', to: ['it@4lsg.com'] },
    });
    const db = makeDb();
    await send(db);
    const info = JSON.parse(loggedRow(db).delivery_info);
    expect(info.response).toBe('250 2.0.0 Ok: queued as 4cKp1R2b');
    expect(info.accepted).toEqual(['it@4lsg.com']);
    expect(info.rejected).toEqual([]);
    expect(info.envelope).toEqual({ from: 'it@metrodetroitbankruptcylaw.com', to: ['it@4lsg.com'] });
  });

  test('a RESOLVED send with rejected recipients is recorded and warned, not swallowed', async () => {
    // nodemailer does not throw when at least one recipient is accepted — this
    // is the silent partial failure the slice exists to surface.
    mockSendMail.mockResolvedValue({
      messageId: '<a@b>', response: '250 OK',
      accepted: ['it@4lsg.com'], rejected: ['gone@4lsg.com'],
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const db = makeDb();
    await expect(send(db)).resolves.toBeTruthy();   // contract unchanged: still resolves
    expect(JSON.parse(loggedRow(db).delivery_info).rejected).toEqual(['gone@4lsg.com']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('gone@4lsg.com'));
    warn.mockRestore();
  });

  test('a refusal records responseCode / response / command, not just err.message', async () => {
    const err = Object.assign(new Error('Message rejected'), {
      code: 'EENVELOPE', responseCode: 550,
      response: '550 5.1.1 recipient rejected', command: 'RCPT TO',
    });
    mockSendMail.mockRejectedValue(err);
    const db = makeDb();
    await expect(send(db)).rejects.toThrow('Message rejected');
    const info = JSON.parse(loggedRow(db).delivery_info);
    expect(info.responseCode).toBe(550);
    expect(info.response).toBe('550 5.1.1 recipient rejected');
    expect(info.command).toBe('RCPT TO');
    expect(loggedRow(db).message_id).toMatch(/^FAILED-/);
  });
});
