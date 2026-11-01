// tests/yisramailT1.fences.routes.test.js
//
/**
 * YisraMail T1 — the bulk_ok fence at every reader of email_credentials that
 * lists or picks a sender (ref/YISRAMAIL_DESIGN.md §5.2): the compose pickers
 * (GET /api/firm-data emailFrom, GET /api/email-from), the diagnostic sender
 * (/internal/email-test), the sender editor's new 400s and test-send refusal
 * (routes/api.emailCredentials.js), createCampaign's sender check, and the
 * mailbox send credential (mailboxService.assertSendCredential, the hub's
 * whyNot). Run: npx jest tests/yisramailT1.fences.routes.test.js
 *
 * The scripted db holds a small email_credentials table and HONORS the
 * predicates the code sends (`bulk_ok = 0`, the editor's shared-login
 * lookups) — so a dropped fence shows up as the bulk row coming back, not as
 * a string compare. Auth middleware is stubbed (a provider boundary here);
 * the routes and services run for real.
 */

'use strict';

jest.mock('../lib/auth.jwtOrApiKey', () => (req, res, next) => { req.auth = { userId: 6, username: 'fred', type: 'jwt' }; next(); });
jest.mock('../lib/auth.superuser', () => {
  const actual = jest.requireActual('../lib/auth.superuser');
  return {
    ...actual,
    superuserOnlyFor: () => (req, res, next) => { req.auth = { userId: 6, username: 'fred', type: 'jwt' }; next(); },
    auditAdminAction: jest.fn(async () => {}),
  };
});
jest.mock('../lib/trusteeRoster', () => ({ loadTrusteeRoster: async () => [] }));
jest.mock('../services/entitlementService', () => ({ deniedFor: async () => [] }));
jest.mock('../services/uiConfigService', () => ({ readFor: async () => ({ firm: {}, user: {} }) }));
const mockSendMail = jest.fn(async (o) => ({ messageId: '<m@x>', response: '250 OK', accepted: [o.to], rejected: [] }));
jest.mock('nodemailer', () => {
  const actual = jest.requireActual('nodemailer');
  return { ...actual, createTransport: jest.fn(() => ({ sendMail: mockSendMail })) };
});

const express = require('express');
const { encrypt } = require('../lib/credentialCrypto');
const campaignService = require('../services/campaignService');
const mailboxService = require('../services/mailboxService');
const sendSvc = require('../services/mailbox/mailboxSendService');

const ROWS = () => ([
  { id: 3, email: 'it@firm.test', from_name: 'IT', provider: 'gmail', credential_id: 11, smtp_host: '', smtp_user: '', smtp_port: 0, smtp_pass: '', smtp_secure: 0, bulk_ok: 0, events_driver: null, driver_config: null, signature_html: null, signature_text: null, owner_user: 6 },
  { id: 4, email: 'ops@firm.test', from_name: 'Ops', provider: 'smtp', credential_id: null, smtp_host: 'mail.firm.test', smtp_user: 'ops@firm.test', smtp_port: 587, smtp_pass: encrypt('pw'), smtp_secure: 0, bulk_ok: 0, events_driver: null, driver_config: null, signature_html: null, signature_text: null, owner_user: null },
  { id: 17, email: 'news@news.test', from_name: 'News', provider: 'smtp', credential_id: null, smtp_host: 'email-smtp.us-east-2.amazonaws.com', smtp_user: 'AKIAEXAMPLE', smtp_port: 587, smtp_pass: encrypt('pw'), smtp_secure: 0, bulk_ok: 1, events_driver: 'ses', driver_config: { configuration_set: 'yisramail-marketing' }, signature_html: null, signature_text: null, owner_user: 6 },
]);

/** A scripted db: email_credentials as a table that honors the predicates the code under test sends. */
function makeDb({ mailboxes = [] } = {}) {
  const T = { email_credentials: ROWS(), mailboxes };
  const writes = [];
  const sqls = [];
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const query = jest.fn(async (rawSql, p = []) => {
    const sql = norm(rawSql);
    sqls.push(sql);
    if (/^INSERT INTO email_credentials SET \?/.test(sql)) { writes.push({ kind: 'insert', data: p[0] }); return [{ insertId: 99 }]; }
    if (/^UPDATE email_credentials SET \? WHERE id = \?/.test(sql)) {
      writes.push({ kind: 'update', data: p[0], id: p[1] });
      const r = T.email_credentials.find((x) => x.id === Number(p[1]));
      if (r) Object.assign(r, p[0], p[0].driver_config ? { driver_config: JSON.parse(p[0].driver_config) } : {});
      return [{ affectedRows: 1 }];
    }
    if (/FROM email_credentials/.test(sql)) {
      let rows = T.email_credentials;
      if (/\bbulk_ok = 0\b/.test(sql)) rows = rows.filter((r) => !r.bulk_ok);
      if (/\bbulk_ok = 1\b/.test(sql)) rows = rows.filter((r) => r.bulk_ok);
      if (/provider = 'smtp' AND (bulk_ok = 1 AND )?smtp_host = \? AND smtp_user = \? AND id <> \?/.test(sql)) {
        rows = rows.filter((r) => r.provider === 'smtp' && r.smtp_host.toLowerCase() === String(p[0]).toLowerCase() &&
          r.smtp_user.toLowerCase() === String(p[1]).toLowerCase() && r.id !== Number(p[2]));
      } else if (/WHERE (ec\.)?id = \?/.test(sql)) rows = rows.filter((r) => r.id === Number(p[0]));
      else if (/WHERE email = \?/.test(sql)) rows = rows.filter((r) => r.email.toLowerCase() === String(p[0]).toLowerCase());
      else if (/WHERE owner_user = \?/.test(sql)) rows = rows.filter((r) => r.owner_user === Number(p[0]));
      return [rows.map((r) => ({ ...r }))];
    }
    if (/FROM mailboxes WHERE send_credential_id = \?/.test(sql)) return [T.mailboxes.filter((m) => m.send_credential_id === Number(p[0]))];
    if (/FROM mailboxes WHERE id = \?/.test(sql)) return [T.mailboxes.filter((m) => m.id === Number(p[0]))];
    if (/FROM credentials WHERE id = \?/.test(sql)) return [[{ id: 11, name: 'G', type: 'oauth2', oauth_status: 'connected' }]];
    if (/INSERT INTO (email_log|admin_audit_log)/.test(sql)) return [{}];
    if (/FROM users WHERE user = \?/.test(sql)) return [[{ user: 6, username: 'fred', default_email: null }]];
    return [[]];
  });
  return { T, writes, sqls, query };
}

let currentDb;
let server;
let base;
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.db = currentDb; next(); });
app.use(require('../routes/api.firmData'));
app.use(require('../routes/api.sending'));
app.use(require('../routes/internal/emailTest'));
app.use(require('../routes/api.emailCredentials'));
app.use(require('../routes/api.mySignatures'));
app.use(require('../routes/auth.profile'));

beforeAll(async () => {
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockSendMail.mockClear();
  currentDb = makeDb({ mailboxes: [{ id: 3, address: 'ops@firm.test', send_credential_id: 4 }] });
});
afterEach(() => jest.restoreAllMocks());

async function call(method, url, body) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json() };
}

describe('sender pickers leave the bulk row out', () => {
  test('GET /api/firm-data emailFrom', async () => {
    const r = await call('GET', '/api/firm-data');
    expect(r.status).toBe(200);
    expect(r.json.emailFrom.map((e) => e.email)).toEqual(['it@firm.test', 'ops@firm.test']);
  });
  test('GET /api/email-from', async () => {
    const r = await call('GET', '/api/email-from');
    expect(r.json.emails.map((e) => e.email)).toEqual(['it@firm.test', 'ops@firm.test']);
  });
  test('GET /internal/email-test/credentials', async () => {
    const r = await call('GET', '/internal/email-test/credentials');
    expect(r.json.credentials.map((e) => e.id)).toEqual([3, 4]);
  });
  test('the editor list still shows it (the editor needs it) and carries bulk_ok / events_driver', async () => {
    const r = await call('GET', '/api/email-credentials');
    const by = Object.fromEntries(r.json.email_credentials.map((e) => [e.id, e]));
    expect(by[17]).toMatchObject({ bulk_ok: 1, events_driver: 'ses' });
    expect(currentDb.sqls.find((q) => /FROM email_credentials ec/.test(q))).toMatch(/ec\.bulk_ok, ec\.events_driver, c\.name/);
  });
});

describe('self-service: signatures and the default sender never offer the bulk row', () => {
  test('GET /api/me/signatures leaves out a bulk row even when it is assigned to the caller', async () => {
    const r = await call('GET', '/api/me/signatures');
    expect(r.status).toBe(200);
    expect(r.json.signatures.map((x) => x.id)).toEqual([3]);
  });
  test('PUT /api/me/signatures/:id refuses the bulk row even when it is assigned to the caller (404); its own plain row saves', async () => {
    const sig = { signature_html: '<b>x</b>', signature_text: 'x' };
    const bad = await call('PUT', '/api/me/signatures/17', sig);
    expect(bad.status).toBe(404);
    expect(currentDb.sqls.some((q) => /^UPDATE email_credentials SET signature_html/.test(q))).toBe(false);
    const ok = await call('PUT', '/api/me/signatures/3', sig);
    expect(ok.status).toBe(200);
  });
  test('update-profile refuses the bulk address as default_email; a plain sender passes that check', async () => {
    const body = { user_fname: 'Fred', user_lname: 'F', username: 'fred', email: 'fred@firm.test' };
    const bad = await call('POST', '/api/auth/update-profile', { ...body, default_email: 'news@news.test' });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('Default email must be one of the configured sending addresses');
    const ok = await call('POST', '/api/auth/update-profile', { ...body, default_email: 'ops@firm.test' });
    expect(ok.json.error).not.toBe('Default email must be one of the configured sending addresses');
  });
});

describe('the diagnostic sender refuses the bulk row — with and without overrides', () => {
  test('public path: 400, nothing sent', async () => {
    const r = await call('POST', '/internal/email-test/send', { from_id: 17, to: 'x@y.test', subject: 's', text: 't' });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/^bulk_sender_refused/);
    expect(mockSendMail).not.toHaveBeenCalled();
  });
  test('overrides path (which clones the SMTP login): 400, nothing sent', async () => {
    const r = await call('POST', '/internal/email-test/send', { from_id: 17, provider_override: 'smtp', from_email_override: 'other@news.test', to: 'x@y.test', subject: 's', text: 't' });
    expect(r.status).toBe(400);
    expect(mockSendMail).not.toHaveBeenCalled();
  });
  test('a plain row still sends', async () => {
    const r = await call('POST', '/internal/email-test/send', { from_id: 4, provider_override: 'smtp', to: 'x@y.test', subject: 's', text: 't' });
    expect(r.status).toBe(200);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });
});

describe('the sender editor', () => {
  const SMTP_BODY = { email: 'promo@news.test', from_name: 'Promo', provider: 'smtp', smtp_host: 'smtp.other.test', smtp_port: 587, smtp_user: 'promo-user', smtp_pass: 'pw' };

  test('POST: bulk_ok on a gmail row → 400 (gmail never gets bulk_ok)', async () => {
    const r = await call('POST', '/api/email-credentials', { email: 'g@firm.test', from_name: 'G', provider: 'gmail', credential_id: 11, bulk_ok: 1 });
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(/SMTP senders only/);
    expect(currentDb.writes).toEqual([]);
  });

  test('POST: an unknown events_driver → 400; an events_driver on gmail → 400; a bad driver_config → 400', async () => {
    let r = await call('POST', '/api/email-credentials', { ...SMTP_BODY, events_driver: 'mailgun' });
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(/events_driver must be one of: ses/);
    r = await call('POST', '/api/email-credentials', { email: 'g@firm.test', from_name: 'G', provider: 'gmail', credential_id: 11, events_driver: 'ses' });
    expect(r.status).toBe(400);
    r = await call('POST', '/api/email-credentials', { ...SMTP_BODY, events_driver: 'ses', driver_config: { configuration_set: 'bad name' } });
    expect(r.status).toBe(400);
    r = await call('POST', '/api/email-credentials', { ...SMTP_BODY, bulk_ok: 1, driver_config: { configuration_set: 'x' } });
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(/needs an events_driver/);
    expect(currentDb.writes).toEqual([]);
  });

  test('a driver or config set on a row that is not bulk → 400 (POST and PUT)', async () => {
    for (const extra of [{ events_driver: 'ses' }, { driver_config: { configuration_set: 'x' } }]) {
      const r = await call('POST', '/api/email-credentials', { ...SMTP_BODY, ...extra });
      expect(r.status).toBe(400);
      expect(r.json.message).toMatch(/for bulk \(marketing\) senders only/);
    }
    const r = await call('PUT', '/api/email-credentials/4', { events_driver: 'ses' });
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(/for bulk \(marketing\) senders only/);
    expect(currentDb.writes).toEqual([]);
  });

  test('PUT: un-marking bulk clears the driver and its config', async () => {
    const r = await call('PUT', '/api/email-credentials/17', { bulk_ok: 0 });
    expect(r.status).toBe(200);
    expect(currentDb.writes[0].data).toEqual({ bulk_ok: 0, events_driver: null, driver_config: null });
  });

  test('POST: a bulk row on a login another row uses → 400 naming that row', async () => {
    const r = await call('POST', '/api/email-credentials', { ...SMTP_BODY, smtp_host: 'MAIL.firm.test', smtp_user: 'ops@firm.test', bulk_ok: 1 });
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(/email_credentials 4 uses the same host and user/);
    expect(currentDb.writes).toEqual([]);
  });

  test('POST: a plain row on the bulk row\'s login → 400 naming the bulk row', async () => {
    const r = await call('POST', '/api/email-credentials', { ...SMTP_BODY, smtp_host: 'email-smtp.us-east-2.amazonaws.com', smtp_user: 'AKIAEXAMPLE' });
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(/bulk \(marketing\) sender — email_credentials 17/);
  });

  test('POST: a valid bulk SES row is written with the three columns (driver_config as JSON text)', async () => {
    const r = await call('POST', '/api/email-credentials', { ...SMTP_BODY, bulk_ok: 1, events_driver: 'ses', driver_config: { configuration_set: 'yisramail-marketing' } });
    expect(r.status).toBe(200);
    expect(currentDb.writes[0].data).toMatchObject({ bulk_ok: 1, events_driver: 'ses', driver_config: '{"configuration_set":"yisramail-marketing"}' });
  });

  test('PUT: marking a row bulk while a mailbox sends through it → 400', async () => {
    const r = await call('PUT', '/api/email-credentials/4', { bulk_ok: 1 });
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(/Mailbox 3 \(ops@firm.test\) sends through this sender/);
    expect(currentDb.writes).toEqual([]);
  });

  test('PUT: row 17 can be set up the way Fred will (bulk + ses + config set)', async () => {
    currentDb.T.email_credentials[2] = { ...currentDb.T.email_credentials[2], bulk_ok: 0, events_driver: null, driver_config: null };
    const r = await call('PUT', '/api/email-credentials/17', { bulk_ok: 1, events_driver: 'ses', driver_config: { configuration_set: 'yisramail-marketing' } });
    expect(r.status).toBe(200);
    expect(currentDb.writes[0]).toMatchObject({ kind: 'update', id: '17', data: { bulk_ok: 1, events_driver: 'ses', driver_config: '{"configuration_set":"yisramail-marketing"}' } });
  });

  test('PUT: leaving smtp drops the three columns', async () => {
    const r = await call('PUT', '/api/email-credentials/17', { provider: 'pabbly' });
    expect(r.status).toBe(200);
    expect(currentDb.writes[0].data).toMatchObject({ bulk_ok: 0, events_driver: null, driver_config: null, smtp_host: '' });
  });

  test('PUT: switching a bulk row to gmail while asking to keep bulk_ok → 400', async () => {
    const r = await call('PUT', '/api/email-credentials/17', { provider: 'gmail', credential_id: 11, bulk_ok: 1 });
    expect(r.status).toBe(400);
  });

  test('the test send refuses a bulk row (400) and still works for a plain one', async () => {
    let r = await call('POST', '/api/email-credentials/17/test', { to: 'x@y.test' });
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(/cannot be test-sent/);
    expect(mockSendMail).not.toHaveBeenCalled();
    r = await call('POST', '/api/email-credentials/4/test', { to: 'x@y.test' });
    expect(r.status).toBe(200);
  });
});

describe('createCampaign checks an email sender (new in T1)', () => {
  const base = { type: 'email', subject: 'S', body: 'B', contactIds: [0], createdBy: 6 };
  test('an unknown sender throws', async () => {
    await expect(campaignService.createCampaign(makeDb(), { ...base, sender: 'nobody@firm.test' })).rejects.toThrow('Email sender nobody@firm.test is not a configured sender');
  });
  test('a bulk sender throws', async () => {
    await expect(campaignService.createCampaign(makeDb(), { ...base, sender: 'news@news.test' })).rejects.toThrow('Operational campaigns cannot send from a marketing transport (news@news.test)');
  });
  test('a configured plain sender passes the check (and reaches the next validation)', async () => {
    await expect(campaignService.createCampaign(makeDb(), { ...base, sender: 'OPS@firm.test' })).rejects.toThrow(/No valid contact IDs/);
  });
  test('a type other than exactly "email" / "sms" throws before any lookup', async () => {
    for (const type of ['EMAIL', 'Email', 'mms', 'e-mail']) {
      const d = makeDb();
      await expect(campaignService.createCampaign(d, { ...base, type, sender: 'news@news.test' })).rejects.toThrow(/type must be "email" or "sms"/);
      expect(d.sqls).toEqual([]);
    }
  });
  test('SMS campaigns do not look at email_credentials', async () => {
    const d = makeDb();
    await expect(campaignService.createCampaign(d, { ...base, type: 'sms', sender: '2485551234' })).rejects.toThrow(/No valid contact IDs/);
    expect(d.sqls.some((s) => /email_credentials/.test(s))).toBe(false);
  });
});

describe('the mailbox send credential', () => {
  test('assertSendCredential (via updateMailbox) refuses a bulk row; a plain row passes it', async () => {
    const d = makeDb({ mailboxes: [{ id: 3, address: 'ops@firm.test', imap_host: 'h', imap_port: 993, alias_of: null, send_credential_id: 4 }] });
    await expect(mailboxService.updateMailbox(d, 3, { send_credential_id: 17 }, { su: true })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/marketing \(bulk\) transport/) });
    let err;
    try { await mailboxService.updateMailbox(d, 3, { send_credential_id: 4 }, { su: true }); } catch (e) { err = e; }
    expect(err && /marketing/.test(err.message)).toBeFalsy();
  });
});
