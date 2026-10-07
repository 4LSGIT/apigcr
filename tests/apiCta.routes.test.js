// tests/apiCta.routes.test.js
//
/**
 * CTA SU management API (CTA arc S2) — routes/api.cta.js, ref/CTA_DESIGN.md
 * §5.3, plus the [[...]] email tokens and default email in lib/ctaLinks.js.
 *
 * WHAT IS LOCKED
 *   - Auth: superuserOnlyFor('cta') — no JWT 401, non-SU 403, API key 403,
 *     SU without step-up 401 elevation_required.
 *   - Mint: minted_by is the caller and mint_source 'su', always — a body
 *     that tries to set either (or source_execution_id) is 400 with no row;
 *     dry_run must be a real boolean (a stringly "true" must not INSERT).
 *   - dry_run: full validation, "<token>" URLs, rendered email, no insert,
 *     no audit.
 *   - email_template: the four tokens resolve; an unknown
 *     [[respond_url:X]] is 400 BEFORE any row is written (dry run too).
 *   - Audit: mint and changing PATCHes write admin_audit_log (tool 'cta')
 *     with a field diff — never the token, the password or password_hash.
 *   - Reads: list counts + filter, executions carry the FULL plan_result;
 *     no response anywhere carries password_hash.
 *   - PATCH surfaces ctaService.patchCta codes (400/404/409) and the S2
 *     stale-running re-enable (finalized_execution_id, audited).
 *
 * HARNESS: the REAL superuserOnlyFor chain (JWTs + elevation, as
 * tests/apiTools.routes.test.js) + REAL ctaService over tests/helpers/
 * ctaWorld.js. Only the alert sink is mocked.
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-cta';
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'test-internal-key-cta';

jest.mock('../lib/alerting', () => ({ alert: jest.fn(async () => {}) }));

const express = require('express');
const jwt = require('jsonwebtoken');
const firmConfig = require('../lib/firmConfig');
const { mintElevationToken, _resetRateLimits } = require('../lib/auth.superuser');
const ctaLinks = require('../lib/ctaLinks');
const { makeCtaWorld, decodeAudit } = require('./helpers/ctaWorld');

const SECRET = process.env.JWT_SECRET;
const SU_ID = 6;   // 'authorized - SU' in the world

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
  _resetRateLimits();
  delete process.env.SU_STEPUP;
});

const staffToken = (over = {}) => jwt.sign(
  { sub: SU_ID, username: 'fred', user_type: 'staff', user_auth: 'authorized - SU', aud: 'staff', roles: [], ...over },
  SECRET, { expiresIn: '1h' }
);

function call(p, { method = 'GET', bearer, elev, apiKey, body } = {}) {
  return fetch(base + p, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(elev ? { 'x-su-elevation': elev } : {}),
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body || {}) }),
  });
}
const su = (p, opts = {}) => call(p, { bearer: staffToken(), elev: mintElevationToken(SU_ID), ...opts });

const LOOKUP = (id = '1001') => ({ fn: 'lookup_contact', params: { contact_id: id } });
const mintBody = (over = {}) => ({
  name: 'Suspect lead 42',
  prompt: 'Is this lead <spam>?',
  options: [
    { value: 'spam', label: 'Mark as spam', plan: [LOOKUP()] },
    { value: 'keep', label: 'Keep', plan: [LOOKUP()] },
  ],
  ...over,
});

const audits = () => W.audits.map(decodeAudit).filter((a) => a.tool === 'cta' && a.status === 'ok');
const B62_22 = /^[0-9A-Za-z]{22}$/;

// ═════════════════════════════════════════════════════════════════════════════
// Auth
// ═════════════════════════════════════════════════════════════════════════════

describe('auth — superuserOnlyFor(cta)', () => {
  test('no JWT 401; non-SU 403; API key 403; SU without step-up 401 elevation_required', async () => {
    expect((await call('/api/cta')).status).toBe(401);
    expect((await call('/api/cta', { bearer: staffToken({ sub: 22, user_auth: 'authorized' }) })).status).toBe(403);
    expect((await call('/api/cta', { apiKey: process.env.INTERNAL_API_KEY })).status).toBe(403);
    const noElev = await call('/api/cta', { method: 'POST', bearer: staffToken(), body: mintBody() });
    expect(noElev.status).toBe(401);
    expect((await noElev.json()).code).toBe('elevation_required');
    expect(W.tables.cta_links.size).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/cta — mint
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/cta — mint', () => {
  test('201: receipt + public URLs + options_html + default email; minted_by is the caller; audited without secrets', async () => {
    const res = await su('/api/cta', { method: 'POST', body: mintBody() });
    expect(res.status).toBe(201);
    const r = await res.json();
    expect(r.token).toMatch(B62_22);
    expect(r).toMatchObject({ dry_run: false, mode: 'once', protection: 'none', name: 'Suspect lead 42' });
    expect(r.cta_url).toBe(`https://4lsg.com/c/${r.token}`);
    expect(r.urls).toEqual({ spam: `${r.cta_url}/spam`, keep: `${r.cta_url}/keep` });
    expect(r.options_html).toContain(`href="${r.cta_url}/spam"`);
    expect(r.email_html).toContain('Is this lead &lt;spam&gt;?');
    expect(r.email_html).toContain(`href="${r.cta_url}/keep"`);
    expect(r.email_html).toContain('nothing happens until you confirm');
    expect(r).not.toHaveProperty('password');

    const row = W.link(r.id);
    expect(row).toMatchObject({ minted_by: SU_ID, mint_source: 'su', source_execution_id: null, status: 'active' });

    const a = audits();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ user_id: SU_ID, method: 'POST', route: '/api/cta' });
    expect(a[0].details).toMatchObject({
      action: 'mint', cta_id: r.id, mode: 'once', protection: 'none', password_generated: false,
      options: [{ value: 'spam', steps: ['lookup_contact'] }, { value: 'keep', steps: ['lookup_contact'] }],
    });
    expect(JSON.stringify(W.audits)).not.toContain(r.token);
  });

  test('auto-generated password: shown ONCE in the mint response, never in the audit row', async () => {
    const r = await (await su('/api/cta', { method: 'POST', body: mintBody({ protection: 'password' }) })).json();
    expect(r.password).toMatch(B62_22);
    expect(r.email_html).toContain("You'll need the password you were given");
    const raw = JSON.stringify(W.audits);
    expect(raw).not.toContain(r.password);
    expect(raw).not.toContain(W.link(r.id).password_hash);
    expect(audits()[0].details.password_generated).toBe(true);
    // supplied secrets are never echoed either
    const s = await (await su('/api/cta', { method: 'POST', body: mintBody({ password: 'supplied-secret-123' }) })).json();
    expect(s).not.toHaveProperty('password');
    expect(JSON.stringify(W.audits)).not.toContain('supplied-secret-123');
  });

  test('SERVER-OWNED: minted_by / mint_source / source_execution_id in the body → 400, no row, no audit', async () => {
    for (const extra of [{ minted_by: 22 }, { mint_source: 'workflow' }, { source_execution_id: 5 }]) {
      const res = await su('/api/cta', { method: 'POST', body: mintBody(extra) });
      expect(res.status).toBe(400);
      expect((await res.json()).message).toMatch(/set by the server/);
    }
    expect(W.tables.cta_links.size).toBe(0);
    expect(audits()).toHaveLength(0);
  });

  test('dry_run: 200, "<token>" URLs + rendered email, nothing inserted, nothing audited', async () => {
    const res = await su('/api/cta', { method: 'POST', body: mintBody({ dry_run: true, protection: 'password' }) });
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r.dry_run).toBe(true);
    expect(r).not.toHaveProperty('token');
    expect(r).not.toHaveProperty('id');
    expect(r).not.toHaveProperty('password');
    expect(r.cta_url).toBe('https://4lsg.com/c/<token>');
    expect(r.urls.spam).toBe('https://4lsg.com/c/<token>/spam');
    expect(r.email_html).toContain('href="https://4lsg.com/c/&lt;token&gt;/spam"');
    expect(r.notes.join(' ')).toMatch(/password will be generated/);
    expect(W.tables.cta_links.size).toBe(0);
    expect(audits()).toHaveLength(0);
  });

  test('dry_run must be a real boolean — a stringly "true" never INSERTs', async () => {
    const res = await su('/api/cta', { method: 'POST', body: mintBody({ dry_run: 'true' }) });
    expect(res.status).toBe(400);
    expect(W.tables.cta_links.size).toBe(0);
  });

  test('ctaService validation maps to 400 with its message (dry run too)', async () => {
    const bad = mintBody({ options: [{ value: 'x', label: 'X', plan: [{ fn: 'wait_until_time', params: {} }] }] });
    for (const dry of [false, true]) {
      const res = await su('/api/cta', { method: 'POST', body: { ...bad, dry_run: dry } });
      expect(res.status).toBe(400);
      const j = await res.json();
      expect(j).toMatchObject({ status: 'error', code: 'invalid' });
      expect(j.message).toMatch(/denied for CTA plans/);
    }
    const tpl = mintBody({ options: [{ value: 'g', label: 'G', plan: [LOOKUP()], result_template: '[[2.output]]' }] });
    expect((await su('/api/cta', { method: 'POST', body: tpl })).status).toBe(400);
    expect(W.tables.cta_links.size).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// [[...]] email tokens (lib/ctaLinks.js)
// ═════════════════════════════════════════════════════════════════════════════

describe('email_template — [[cta_url]] [[respond_url:VALUE]] [[options_html]] [[expires_at]]', () => {
  const TPL = '<p>Review: <a href="[[cta_url]]">all</a> or <a href="[[respond_url:spam]]">spam</a></p>' +
    '[[options_html]]<p>Until [[expires_at]]</p><p>[[unknown_token]]</p>';

  test('all four resolve in the mint response; unknown [[...]] stays as written', async () => {
    // A naive firm-time expiry ~40 days out (relative, so the test never ages
    // into "expiry must be in the future"); [[expires_at]] renders it back in
    // firm time with the zone abbreviation.
    const { DateTime } = require('luxon');
    const local = DateTime.now().setZone('America/Detroit').plus({ days: 40 }).set({ hour: 9, minute: 30, second: 0, millisecond: 0 });
    const r = await (await su('/api/cta', {
      method: 'POST', body: mintBody({ email_template: TPL, expires_at: local.toFormat('yyyy-MM-dd HH:mm') }),
    })).json();
    expect(r.expires_at).toBe(local.toUTC().toISO({ suppressMilliseconds: false }));
    expect(r.email_html).toContain(`<a href="${r.cta_url}">all</a>`);
    expect(r.email_html).toContain(`<a href="${r.cta_url}/spam">spam</a>`);
    expect(r.email_html).toContain(r.options_html);
    expect(r.email_html).toContain(`Until ${local.toFormat("MMM d, yyyy 'at' 9:30 'AM' ZZZZ")}`);
    expect(r.email_html).toContain('[[unknown_token]]');
    expect(r.email_html).not.toContain('[[cta_url]]');
    expect(audits()[0].details.email_template).toBe(true);
  });

  test('THROW on an unknown [[respond_url:X]] — 400 BEFORE any row is written, dry run included', async () => {
    for (const dry of [false, true]) {
      const res = await su('/api/cta', {
        method: 'POST', body: mintBody({ email_template: '<a href="[[respond_url:nope]]">x</a>', dry_run: dry }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).message).toMatch(/unknown option value "nope" in \[\[respond_url:nope\]\]/);
    }
    // a malformed value is unknown too — never silently left in the mail
    const odd = await su('/api/cta', { method: 'POST', body: mintBody({ email_template: '[[respond_url:sp am]]' }) });
    expect(odd.status).toBe(400);
    expect(W.tables.cta_links.size).toBe(0);
    expect(audits()).toHaveLength(0);
  });

  test('resolveCtaTokens text mode: raw URLs, no options_html', () => {
    const opts = [{ value: 'spam', label: 'Spam' }];
    const out = ctaLinks.resolveCtaTokens('Go [[cta_url]] / [[respond_url:spam]] [[options_html]]|', {
      token: '<token>', options: opts, expiresAt: new Date(), html: false,
    });
    expect(out).toBe('Go https://4lsg.com/c/<token> / https://4lsg.com/c/<token>/spam |');
    expect(() => ctaLinks.resolveCtaTokens('[[respond_url:x]]', { token: 't', options: opts, expiresAt: new Date() }))
      .toThrow(/unknown option value "x"/);
  });

  test('default email: timeout note only for a timeout_option link', async () => {
    const a = await (await su('/api/cta', { method: 'POST', body: mintBody({ dry_run: true }) })).json();
    expect(a.email_html).not.toMatch(/default action runs automatically/);
    const b = await (await su('/api/cta', { method: 'POST', body: mintBody({ dry_run: true, timeout_option: 'keep' }) })).json();
    expect(b.email_html).toMatch(/default action runs automatically/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Reads
// ═════════════════════════════════════════════════════════════════════════════

describe('GET /api/cta + /executions', () => {
  async function mintAndRun() {
    const ok = await (await su('/api/cta', { method: 'POST', body: mintBody({ protection: 'password' }) })).json();
    const bad = await (await su('/api/cta', {
      method: 'POST', body: mintBody({ name: 'Broken', options: [{ value: 'go', label: 'Go', plan: [LOOKUP('9999')] }] }),
    })).json();
    const cta = require('../services/ctaService');
    await cta.respond(db, { token: ok.token, value: 'spam', password: ok.password });
    await cta.respond(db, { token: bad.token, value: 'go' });
    return { ok, bad };
  }

  test('list: newest first, exec counts, derived state, cta_url, option summary — never password_hash', async () => {
    const { ok, bad } = await mintAndRun();
    const res = await su('/api/cta');
    expect(res.status).toBe(200);
    const { ctas } = await res.json();
    expect(ctas.map((c) => c.id)).toEqual([bad.id, ok.id]);
    expect(ctas[0]).toMatchObject({ name: 'Broken', exec_count: 1, failed_count: 1, status: 'used', state: 'used' });
    expect(ctas[1]).toMatchObject({ exec_count: 1, failed_count: 0, protection: 'password', cta_url: `https://4lsg.com/c/${ok.token}` });
    expect(ctas[1].options).toEqual([
      { value: 'spam', label: 'Mark as spam', steps: ['lookup_contact'] },
      { value: 'keep', label: 'Keep', steps: ['lookup_contact'] },
    ]);
    expect(ctas[1].last_executed_at).toBeTruthy();
    const raw = JSON.stringify(ctas);
    expect(raw).not.toContain('password_hash');
    expect(raw).not.toContain('contact_id');   // plan params stay out of the list
  });

  test('list filter: stored status only; a bad filter is 400', async () => {
    await mintAndRun();
    await su('/api/cta', { method: 'POST', body: mintBody({ name: 'fresh' }) });
    const { ctas } = await (await su('/api/cta?status=active')).json();
    expect(ctas.map((c) => c.name)).toEqual(['fresh']);
    expect((await su('/api/cta?status=expired')).status).toBe(400);
    const page = await (await su('/api/cta?limit=1&offset=1')).json();
    expect(page.ctas).toHaveLength(1);
  });

  test('executions: the FULL plan_result (error text included) — the one surface that carries it', async () => {
    const { bad } = await mintAndRun();
    const res = await su(`/api/cta/${bad.id}/executions`);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.cta).toMatchObject({ id: bad.id, name: 'Broken', cta_url: `https://4lsg.com/c/${bad.token}` });
    expect(j.cta).not.toHaveProperty('password_hash');
    expect(j.executions).toHaveLength(1);
    expect(j.executions[0]).toMatchObject({ status: 'failed', option_value: 'go', responded_via: 'link' });
    expect(j.executions[0].plan_result[0]).toMatchObject({ fn: 'lookup_contact', ok: false });
    expect(j.executions[0].plan_result[0].error).toBeTruthy();
    expect((await su('/api/cta/999/executions')).status).toBe(404);
    expect((await su('/api/cta/abc/executions')).status).toBe(400);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PATCH /api/cta/:id
// ═════════════════════════════════════════════════════════════════════════════

describe('PATCH /api/cta/:id', () => {
  const mint = async (over) => (await su('/api/cta', { method: 'POST', body: mintBody(over) })).json();
  const patch = (id, body) => su(`/api/cta/${id}`, { method: 'PATCH', body });

  test('disable → enable → cancel: each audited with its action and field diff; no password_hash in the response', async () => {
    const m = await mint({ protection: 'password' });
    const r1 = await patch(m.id, { status: 'disabled' });
    expect(r1.status).toBe(200);
    const j1 = await r1.json();
    expect(j1).toMatchObject({ changed: true, cta: { id: m.id, status: 'disabled', state: 'disabled' } });
    expect(j1.cta).not.toHaveProperty('password_hash');
    expect((await (await patch(m.id, { status: 'active' })).json()).cta.status).toBe('active');
    expect((await (await patch(m.id, { status: 'cancelled' })).json()).cta.status).toBe('cancelled');

    const acts = audits().filter((a) => a.details.action !== 'mint');
    expect(acts.map((a) => a.details.action)).toEqual(['disable', 'enable', 'cancel']);
    expect(acts[0]).toMatchObject({ method: 'PATCH', route: `/api/cta/${m.id}` });
    expect(acts[0].details).toEqual({
      action: 'disable', cta_id: m.id, name: 'Suspect lead 42',
      changes: { status: { from: 'active', to: 'disabled' } },
    });
    expect(JSON.stringify(W.audits)).not.toContain(m.token);
  });

  test('extend: audited as patch with the expires_at diff; a no-op PATCH is unchanged and unaudited', async () => {
    const m = await mint();
    const later = new Date(Date.now() + 10 * 24 * 3600e3).toISOString();
    const j = await (await patch(m.id, { expires_at: later })).json();
    expect(j.changed).toBe(true);
    const last = audits().pop();
    expect(last.details.action).toBe('patch');
    expect(last.details.changes.expires_at).toEqual({ from: m.expires_at, to: later });
    const before = audits().length;
    const same = await (await patch(m.id, { status: 'active' })).json();
    expect(same.changed).toBe(false);
    expect(audits()).toHaveLength(before);
  });

  test('service codes pass through: 409 cancelled (unaudited), 400 bad field, 404 unknown', async () => {
    const m = await mint();
    await patch(m.id, { status: 'cancelled' });
    const n = audits().length;
    const c = await patch(m.id, { status: 'active' });
    expect(c.status).toBe(409);
    expect(await c.json()).toMatchObject({ status: 'error', code: 'cancelled' });
    expect(audits()).toHaveLength(n);
    expect((await patch(m.id, { uses_count: 0 })).status).toBe(400);
    expect((await patch(999, { status: 'disabled' })).status).toBe(404);
  });

  test('STALE RUNNING re-enable (S2 ruling): finalized_execution_id in the response and the audit row', async () => {
    const m = await mint();
    Object.assign(W.link(m.id), { status: 'used', uses_count: 1 });
    const exId = W.nextId.cta_executions++;
    W.tables.cta_executions.set(exId, {
      id: exId, cta_id: m.id, option_value: 'spam', status: 'running', plan_result: null,
      responded_via: 'link', responder_user_id: null, responder_ip: null,
      executed_at: new Date(Date.now() - 20 * 60e3),
    });
    const j = await (await patch(m.id, { status: 'active' })).json();
    expect(j).toMatchObject({ changed: true, finalized_execution_id: exId, cta: { status: 'active', uses_count: 0 } });
    expect(W.tables.cta_executions.get(exId).status).toBe('failed');
    const last = audits().pop();
    expect(last.details).toMatchObject({
      action: 'reenable', finalized_execution_id: exId,
      changes: { status: { from: 'used', to: 'active' }, uses_count: { from: '1', to: '0' } },
    });
  });
});
