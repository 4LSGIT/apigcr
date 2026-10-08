// tests/apiCta.send.test.js
//
/**
 * POST /api/cta/:id/send — send an ACTIVE CTA link by email or SMS (send
 * slice, 2026-10-08). routes/api.cta.js + lib/ctaLinks.composeSend.
 *
 * WHAT IS LOCKED
 *   - Auth: the same superuserOnlyFor('cta') chain as every /api/cta route.
 *   - Active only: used / disabled / cancelled / expired / exhausted → 409
 *     not_active, and NOTHING is sent, logged or audited.
 *   - Email: default subject + default email with the REAL token's URLs and a
 *     plain-text part; a send-time email_template / subject resolves the same
 *     [[...]] tokens as a mint, and an unknown [[respond_url:X]] is a 400
 *     before anything is sent. The template is never stored.
 *   - SMS: prompt + "Respond: <landing>" (request_decision's default SMS);
 *     subject / email_template are refused for SMS.
 *   - from defaults: email_automations (taskService.getFromEmail); SMS
 *     sms_staff_from → sms_default_from (taskService.getSmsFrom); neither
 *     set and no from → 400.
 *   - Log: against the link when set — an 'email' row for email, a 'note'
 *     row (never an 'sms' row: the provider webhook writes that) for SMS;
 *     no link → no row.
 *   - Audit: every real attempt (ok, or error with the transport message);
 *     never the token or a password. dry_run sends/logs/audits nothing.
 *   - A password-protected link's password never appears in anything sent.
 *
 * HARNESS: the REAL superuserOnlyFor chain + REAL ctaService over
 * tests/helpers/ctaWorld.js (as tests/apiCta.routes.test.js). Mocked: the
 * alert sink and the two transports (emailService.sendEmail,
 * phoneService.sendSms) — external side effects, not the code under test.
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-cta-send';
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'test-internal-key-cta-send';

jest.mock('../lib/alerting', () => ({ alert: jest.fn(async () => {}) }));
jest.mock('../services/emailService', () => ({
  ...jest.requireActual('../services/emailService'),
  sendEmail: jest.fn(async () => ({ messageId: 'm-1' })),
}));
jest.mock('../services/phoneService', () => ({
  ...jest.requireActual('../services/phoneService'),
  sendSms: jest.fn(async () => ({ id: 's-1' })),
}));

const express = require('express');
const jwt = require('jsonwebtoken');
const firmConfig = require('../lib/firmConfig');
const emailService = require('../services/emailService');
const phoneService = require('../services/phoneService');
const { mintElevationToken, _resetRateLimits } = require('../lib/auth.superuser');
const { makeCtaWorld, decodeAudit, decodeLog } = require('./helpers/ctaWorld');

const SECRET = process.env.JWT_SECRET;
const SU_ID = 6;

let db;
let W;
let server;
let base;

beforeAll((done) => {
  process.env.LANDING_HOSTS = '4lsg.com';
  firmConfig._test({ resetCache: true });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.db = db; next(); });
  app.use(require('../routes/api.cta'));
  server = app.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => {
  delete process.env.LANDING_HOSTS;
  firmConfig._test({ resetCache: true });
  if (server.closeAllConnections) server.closeAllConnections();
  server.close(done);
});

beforeEach(() => {
  db = makeCtaWorld();
  W = db.W;
  W.contacts.set(1001, { contact_id: 1001, contact_name: 'Pat Doe', contact_email: 'pat@example.com' });
  W.settings.set('email_automations', 'automations@example.com');
  W.settings.set('sms_staff_from', '5555550100');
  _resetRateLimits();
  emailService.sendEmail.mockReset().mockImplementation(async () => ({ messageId: 'm-1' }));
  phoneService.sendSms.mockReset().mockImplementation(async () => ({ id: 's-1' }));
});

const staffToken = (over = {}) => jwt.sign(
  { sub: SU_ID, username: 'fred', user_type: 'staff', user_auth: 'authorized - SU', aud: 'staff', roles: [], ...over },
  SECRET, { expiresIn: '1h' }
);
function call(p, { method = 'GET', bearer, elev, body } = {}) {
  return fetch(base + p, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(elev ? { 'x-su-elevation': elev } : {}),
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body || {}) }),
  });
}
const su = (p, opts = {}) => call(p, { bearer: staffToken(), elev: mintElevationToken(SU_ID), ...opts });
const send = (id, body) => su(`/api/cta/${id}/send`, { method: 'POST', body });

const LOOKUP = { fn: 'lookup_contact', params: { contact_id: '1001' } };
const mintBody = (over = {}) => ({
  name: 'Suspect lead 42',
  prompt: 'Is this lead   spam?\nFrom the contact form.',
  options: [
    { value: 'spam', label: 'Mark as spam', plan: [LOOKUP] },
    { value: 'keep', label: 'Keep', plan: [LOOKUP] },
  ],
  link_type: 'contact',
  link_id: '1001',
  ...over,
});
async function mint(over) {
  const r = await su('/api/cta', { method: 'POST', body: mintBody(over) });
  expect(r.status).toBe(201);
  return r.json();
}
const sendAudits = () => W.audits.map(decodeAudit).filter((a) => a.tool === 'cta' && a.details && a.details.action === 'send');
const logs = () => W.logs.map(decodeLog);

// ═════════════════════════════════════════════════════════════════════════════

describe('auth', () => {
  test('same SU chain: no elevation → 401 elevation_required; non-SU → 403; nothing sent', async () => {
    const m = await mint();
    const noElev = await call(`/api/cta/${m.id}/send`, { method: 'POST', bearer: staffToken(), body: { channel: 'email', to: 'a@example.com' } });
    expect(noElev.status).toBe(401);
    expect((await noElev.json()).code).toBe('elevation_required');
    const nonSu = await call(`/api/cta/${m.id}/send`, { method: 'POST', bearer: staffToken({ sub: 22, user_auth: 'authorized' }), body: { channel: 'email', to: 'a@example.com' } });
    expect(nonSu.status).toBe(403);
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });
});

describe('email', () => {
  test('default: subject + email with the real URLs + a text part; from = email_automations; logged on the link; audited', async () => {
    const m = await mint();
    const r = await send(m.id, { channel: 'email', to: 'ss@example.com' });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toEqual({
      sent: true, channel: 'email', cta_id: m.id, to: 'ss@example.com', from: 'automations@example.com',
      template: 'default', subject: 'Action requested: Is this lead spam? From the contact form.', log_id: expect.any(Number),
    });

    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    const [, mail] = emailService.sendEmail.mock.calls[0];
    expect(mail.from).toBe('automations@example.com');
    expect(mail.to).toBe('ss@example.com');
    expect(mail.subject).toBe(j.subject);
    expect(mail.html).toContain(`href="https://4lsg.com/c/${m.token}/spam"`);
    expect(mail.html).toContain('YisraCase — Action Requested');
    expect(mail.text).toContain(`Mark as spam: https://4lsg.com/c/${m.token}/spam`);
    expect(mail.text).toContain(`All options: https://4lsg.com/c/${m.token}`);

    const [log] = logs();
    expect(log).toMatchObject({ type: 'email', link_type: 'contact', link_id: '1001', by: SU_ID });
    expect(log.data).toMatchObject({ from: 'automations@example.com', to: 'ss@example.com', subject: j.subject, cta_id: m.id, template: 'default' });
    expect(log.data.body).toContain(`Keep: https://4lsg.com/c/${m.token}/keep`);

    const [a] = sendAudits();
    expect(a).toMatchObject({ status: 'ok', method: 'POST', route: `/api/cta/${m.id}/send` });
    expect(a.details).toEqual({
      action: 'send', cta_id: m.id, name: 'Suspect lead 42', channel: 'email', to: 'ss@example.com',
      from: 'automations@example.com', template: 'default', subject: j.subject, log_id: j.log_id,
    });
    expect(JSON.stringify(W.audits)).not.toContain(m.token);
  });

  test('send-time template + subject resolve the [[...]] tokens; template kind "custom"; no text part forced; never stored', async () => {
    const m = await mint();
    const r = await send(m.id, {
      channel: 'email', to: 'ss@example.com', from: 'office@example.com',
      subject: 'Please decide by [[expires_at]]',
      email_template: '<p>Hi — <a href="[[respond_url:spam]]">spam</a> or [[options_html]]</p>',
    });
    expect(r.status).toBe(200);
    const [, mail] = emailService.sendEmail.mock.calls[0];
    expect(mail.from).toBe('office@example.com');
    expect(mail.subject).toMatch(/^Please decide by \w{3} \d{1,2}, \d{4} at /);
    expect(mail.html).toContain(`<a href="https://4lsg.com/c/${m.token}/spam">spam</a>`);
    expect(mail.html).toContain(`href="https://4lsg.com/c/${m.token}/keep"`);
    expect(mail).not.toHaveProperty('text');
    expect(sendAudits()[0].details.template).toBe('custom');
    expect(logs()[0].data.template).toBe('custom');
    // never stored: the row carries no trace of the template
    expect(JSON.stringify(W.link(m.id))).not.toContain('Please decide');
  });

  test('an unknown [[respond_url:X]] in the template is a 400 BEFORE anything is sent, logged or audited', async () => {
    const m = await mint();
    const r = await send(m.id, { channel: 'email', to: 'ss@example.com', email_template: '<a href="[[respond_url:nope]]">x</a>' });
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.code).toBe('invalid');
    expect(j.message).toContain('unknown option value "nope"');
    expect(emailService.sendEmail).not.toHaveBeenCalled();
    expect(logs()).toEqual([]);
    expect(sendAudits()).toEqual([]);
  });

  test('an unknown [[respond_url:X]] in the SUBJECT is the same 400', async () => {
    const m = await mint();
    const r = await send(m.id, { channel: 'email', to: 'ss@example.com', subject: 'Go: [[respond_url:nope]]' });
    expect(r.status).toBe(400);
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });

  test('a transport failure is a 502 send_failed, audited as error with the message, and not logged', async () => {
    emailService.sendEmail.mockImplementation(async () => { throw new Error('No credentials found for sender: x@example.com'); });
    const m = await mint();
    const r = await send(m.id, { channel: 'email', to: 'ss@example.com', from: 'x@example.com' });
    expect(r.status).toBe(502);
    const j = await r.json();
    expect(j).toMatchObject({ code: 'send_failed', message: 'cta: email send failed — No credentials found for sender: x@example.com' });
    expect(logs()).toEqual([]);
    const all = W.audits.map(decodeAudit).filter((a) => a.details && a.details.action === 'send');
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: 'error', error_message: 'No credentials found for sender: x@example.com' });
  });
});

describe('sms', () => {
  test('prompt + "Respond: <landing>" from sms_staff_from; logged as a NOTE (never an sms row); audited', async () => {
    const m = await mint();
    const r = await send(m.id, { channel: 'sms', to: '(313) 555-0199' });
    expect(r.status).toBe(200);
    expect(phoneService.sendSms).toHaveBeenCalledTimes(1);
    const [, from, to, text] = phoneService.sendSms.mock.calls[0];
    expect(from).toBe('5555550100');
    expect(to).toBe('(313) 555-0199');
    expect(text).toBe(`Is this lead spam? From the contact form.\nRespond: https://4lsg.com/c/${m.token}`);
    const [log] = logs();
    expect(log.type).toBe('note');
    expect(log).toMatchObject({ link_type: 'contact', link_id: '1001', by: SU_ID });
    expect(log.message).toContain('link sent by SMS to (313) 555-0199 from 5555550100');
    expect(logs().some((l) => l.type === 'sms')).toBe(false);
    expect(sendAudits()[0].details).toMatchObject({ channel: 'sms', template: 'default', to: '(313) 555-0199', from: '5555550100' });
  });

  test('from falls back to sms_default_from; neither set and no from → 400, nothing sent', async () => {
    const m = await mint();
    W.settings.delete('sms_staff_from');
    W.settings.set('sms_default_from', '5555550111');
    expect((await send(m.id, { channel: 'sms', to: '3135550199' })).status).toBe(200);
    expect(phoneService.sendSms.mock.calls[0][1]).toBe('5555550111');
    W.settings.delete('sms_default_from');
    const r = await send(m.id, { channel: 'sms', to: '3135550199' });
    expect(r.status).toBe(400);
    expect((await r.json()).message).toContain('no sending line');
    expect(phoneService.sendSms).toHaveBeenCalledTimes(1);
  });

  test('subject / email_template are refused for SMS', async () => {
    const m = await mint();
    for (const extra of [{ subject: 'x' }, { email_template: '<p>x</p>' }]) {
      const r = await send(m.id, { channel: 'sms', to: '3135550199', ...extra });
      expect(r.status).toBe(400);
    }
    expect(phoneService.sendSms).not.toHaveBeenCalled();
  });
});

describe('active links only', () => {
  const states = {
    used: (id) => { W.link(id).status = 'used'; W.link(id).uses_count = 1; },
    disabled: (id) => { W.link(id).status = 'disabled'; },
    cancelled: (id) => { W.link(id).status = 'cancelled'; },
    expired: (id) => { W.link(id).expires_at = new Date(Date.now() - 60e3); },
  };
  for (const [state, apply] of Object.entries(states)) {
    test(`${state} → 409 not_active; nothing sent, logged or audited (email and SMS)`, async () => {
      const m = await mint();
      apply(m.id);
      for (const body of [{ channel: 'email', to: 'ss@example.com' }, { channel: 'sms', to: '3135550199' }, { channel: 'email', dry_run: true }]) {
        const r = await send(m.id, body);
        expect([state, r.status]).toEqual([state, 409]);
        const j = await r.json();
        expect(j).toMatchObject({ code: 'not_active', message: `cta: only an active link can be sent — CTA ${m.id} is ${state}` });
      }
      expect(emailService.sendEmail).not.toHaveBeenCalled();
      expect(phoneService.sendSms).not.toHaveBeenCalled();
      expect(logs()).toEqual([]);
      expect(sendAudits()).toEqual([]);
    });
  }

  test('exhausted (repeatable at max_uses) → 409 not_active', async () => {
    const m = await mint({ mode: 'repeatable', max_uses: 2 });
    W.link(m.id).uses_count = 2;
    const r = await send(m.id, { channel: 'email', to: 'ss@example.com' });
    expect(r.status).toBe(409);
    expect((await r.json()).message).toContain('is exhausted');
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });

  test('missing CTA → 404', async () => {
    expect((await send(999, { channel: 'email', to: 'ss@example.com' })).status).toBe(404);
  });
});

describe('password, dry run, validation, unlinked', () => {
  test('a protected link: the generated password appears in nothing that is sent, logged or audited', async () => {
    const m = await mint({ protection: 'password' });
    expect(m.password).toMatch(/^[0-9A-Za-z]{22}$/);
    await send(m.id, { channel: 'email', to: 'ss@example.com' });
    await send(m.id, { channel: 'sms', to: '3135550199' });
    const sent = JSON.stringify([emailService.sendEmail.mock.calls, phoneService.sendSms.mock.calls.map((c) => c.slice(1)), W.logs, W.audits]);
    expect(sent).not.toContain(m.password);
    expect(emailService.sendEmail.mock.calls[0][1].html).toContain("You'll need the password you were given");
  });

  test('dry_run: the composed message and resolved from; to optional; nothing sent, logged or audited', async () => {
    const m = await mint();
    const r = await send(m.id, { channel: 'email', dry_run: true });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toMatchObject({ dry_run: true, channel: 'email', cta_id: m.id, from: 'automations@example.com', to: null, template: 'default' });
    expect(j.html).toContain(`https://4lsg.com/c/${m.token}/keep`);
    expect(j.subject).toBe('Action requested: Is this lead spam? From the contact form.');
    const s = await (await send(m.id, { channel: 'sms', dry_run: true })).json();
    expect(s.text).toBe(`Is this lead spam? From the contact form.\nRespond: https://4lsg.com/c/${m.token}`);
    expect(emailService.sendEmail).not.toHaveBeenCalled();
    expect(phoneService.sendSms).not.toHaveBeenCalled();
    expect(logs()).toEqual([]);
    expect(sendAudits()).toEqual([]);
  });

  test('validation 400s: unknown field, channel, dry_run type, missing / malformed to', async () => {
    const m = await mint();
    const bad = [
      { channel: 'email', to: 'a@example.com', cc: 'x' },
      { channel: 'fax', to: 'a@example.com' },
      { channel: 'email', to: 'a@example.com', dry_run: 'true' },
      { channel: 'email' },
      { channel: 'email', to: 'not-an-email' },
      { channel: 'sms', to: '555-0199' },
    ];
    for (const body of bad) {
      const r = await send(m.id, body);
      expect([body, r.status]).toEqual([body, 400]);
    }
    expect(emailService.sendEmail).not.toHaveBeenCalled();
    expect(phoneService.sendSms).not.toHaveBeenCalled();
  });

  test('a link with no link_type/link_id: sent and audited, no log row, log_id null', async () => {
    const m = await mint({ link_type: undefined, link_id: undefined });
    const j = await (await send(m.id, { channel: 'email', to: 'ss@example.com' })).json();
    expect(j.sent).toBe(true);
    expect(j.log_id).toBeNull();
    expect(logs()).toEqual([]);
    expect(sendAudits()).toHaveLength(1);
  });
});
