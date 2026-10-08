// tests/ctaActions.routes.test.js
//
/**
 * CTA public surface (CTA arc S2) — routes/ctaActions.js, ref/CTA_DESIGN.md
 * §5.1 / §5.2 / §6.
 *
 * WHAT IS LOCKED
 *   - GET never mutates (landing, confirm, HEAD): zero writes reach the DB.
 *   - Every response — 429s and errors included — is no-store + noindex.
 *   - prompt is escaped text; context_html renders raw on the actionable
 *     pages only; terminal pages never show it.
 *   - The password field is on BOTH GETs (§5.1), with an Enter-key guard on
 *     the landing form; passwords are read from the body only, never echoed.
 *   - Content negotiation: JSON only for an explicit, preferred
 *     Accept: application/json; the descriptor never carries name, plans,
 *     result_template or context_html; respond JSON is {ok, status,
 *     execution_id, result?} (+plan_result only for return_plan_result=1),
 *     failures generic.
 *   - Public state hides WHY a link is off (the B1 minter kill switch reads
 *     as 'disabled').
 *   - LIMITERS ARE WIRED: reads 30/min/IP, respond 10/min/IP (the /d/ bug
 *     that sat unwired for seven weeks), password attempts 5/15 min/token+IP
 *     with reserve-then-refund (wrong guesses capped, burst-safe; correct
 *     passwords never spend budget). Each guard was mutation-checked: remove
 *     it and its test fails.
 *
 * HARNESS: the REAL router + REAL ctaService + REAL registry functions over
 * tests/helpers/ctaWorld.js (the stateful in-memory DB that evaluates each
 * guarded UPDATE's own SQL). Only the alert sink is mocked. The limiters are
 * module state, so every test gets its own client IP (last X-Forwarded-For
 * element — lib/rateLimiter.getClientIp) and cannot spend another's budget.
 */
'use strict';

jest.mock('../lib/alerting', () => ({ alert: jest.fn(async () => {}) }));

const express = require('express');
const bcrypt = require('bcrypt');
const cta = require('../services/ctaService');
const { makeCtaWorld } = require('./helpers/ctaWorld');

const PW = 'correct-horse-battery';
const PW_HASH = bcrypt.hashSync(PW, 4);   // cheap rounds: the cost lives in the hash, compare follows it
const HOUR = 3600e3;

let db;
let W;
let IP;
let ipSeq = 0;

let server;
let base;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => { req.db = db; next(); });
  app.use(require('../routes/ctaActions'));
  server = app.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => {
  if (server.closeAllConnections) server.closeAllConnections();
  server.close(done);
});

beforeEach(() => {
  db = makeCtaWorld();
  W = db.W;
  W.contacts.set(1001, {
    contact_id: 1001, contact_name: 'Pat <b>Doe</b>', contact_email: 'pat@example.com',
    contact_notes: 'SECRET-NOTES', contact_dob: null,
  });
  IP = `198.51.100.${++ipSeq}`;
});

const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

function req(path, { method = 'GET', ip = IP, accept, form, json, firstXff = '203.0.113.7' } = {}) {
  const headers = { 'x-forwarded-for': `${firstXff}, ${ip}` };
  if (accept) headers.accept = accept;
  let body;
  if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  } else if (json) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(json);
  }
  return fetch(base + path, { method, headers, body, redirect: 'manual' });
}
const asJson = { accept: 'application/json' };

const LOOKUP = (id = '1001') => ({ fn: 'lookup_contact', params: { contact_id: id } });

function seed(over = {}) {
  return W.seedLink({
    prompt: 'Is this lead <script>alert(1)</script> spam?',
    context_html: '<p class="ctx">Lead <em>details</em></p>',
    options: [
      { value: 'spam', label: 'Mark as spam', plan: [LOOKUP()] },
      { value: 'keep', label: 'Keep <it>', plan: [LOOKUP()] },
    ],
    ...over,
  });
}
const protectedLink = (over = {}) => seed({ protection: 'password', password_hash: PW_HASH, ...over });

const writes = () => W.queries.filter((q) => /^(UPDATE|INSERT|DELETE)\b/i.test(q.sql) && !/^INSERT INTO log\b/i.test(q.sql));
const allWrites = () => W.queries.filter((q) => /^(UPDATE|INSERT|DELETE)\b/i.test(q.sql));

function expectBaseHeaders(res) {
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
}

// ═════════════════════════════════════════════════════════════════════════════
// GET /c/:token — landing
// ═════════════════════════════════════════════════════════════════════════════

describe('GET /c/:token — landing page', () => {
  test('prompt escaped, context raw, one submit per option posting to /respond; no-store + noindex + Vary', async () => {
    const row = seed();
    const res = await req(`/c/${row.token}`, { accept: BROWSER_ACCEPT });
    expect(res.status).toBe(200);
    expectBaseHeaders(res);
    expect(res.headers.get('vary')).toMatch(/Accept/);
    const html = await res.text();
    expect(html).toContain('Is this lead &lt;script&gt;alert(1)&lt;/script&gt; spam?');
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('<p class="ctx">Lead <em>details</em></p>');
    expect(html).toContain(`action="/c/${row.token}/respond"`);
    expect(html.match(/<button type="submit" name="value"/g)).toHaveLength(2);
    expect(html).toContain('value="spam"');
    expect(html).toContain('Keep &lt;it&gt;');
    expect(html).not.toMatch(/name="password"/);
    expect(html).not.toMatch(/disabled aria-hidden/);
  });

  test('GET NEVER MUTATES — landing, confirm, HEAD and JSON reads write nothing', async () => {
    const row = protectedLink();
    await req(`/c/${row.token}`);
    await req(`/c/${row.token}/spam`);
    await req(`/c/${row.token}`, { method: 'HEAD' });
    await req(`/c/${row.token}`, asJson);
    await req(`/c/${row.token}/keep`, asJson);
    expect(W.queries.length).toBeGreaterThan(0);
    expect(allWrites()).toEqual([]);
    expect(W.link(row.id)).toMatchObject({ status: 'active', uses_count: 0, failed_attempts: 0 });
  });

  test('password field on the landing page too (§5.1), behind an Enter-key guard', async () => {
    const row = protectedLink();
    const html = await (await req(`/c/${row.token}`)).text();
    expect(html).toMatch(/<input id="cta-password" type="password" name="password" required/);
    // the FIRST submit button in the form is the disabled default — implicit
    // submission (Enter in the password field) must not pick option 1
    const form = html.slice(html.indexOf('<form'));
    expect(form.indexOf('<button type="submit" disabled')).toBeGreaterThan(-1);
    expect(form.indexOf('<button type="submit" disabled')).toBeLessThan(form.indexOf('name="value"'));
  });

  test('an option with confirm_text links to its confirm page instead of submitting directly', async () => {
    const row = seed({
      options: [
        { value: 'spam', label: 'Mark as spam', plan: [LOOKUP()], confirm_text: 'This deletes the lead.' },
        { value: 'keep', label: 'Keep', plan: [LOOKUP()] },
      ],
    });
    const html = await (await req(`/c/${row.token}`)).text();
    expect(html).toContain(`href="/c/${row.token}/spam"`);
    expect(html).not.toContain('name="value" value="spam"');
    expect(html).toContain('name="value" value="keep"');
  });

  test('unknown token: HTML "not valid"; JSON 404', async () => {
    const res = await req('/c/NoSuchToken1234567890');
    expect(res.status).toBe(200);
    expectBaseHeaders(res);
    expect(await res.text()).toContain('Link not valid');
    const j = await req('/c/NoSuchToken1234567890', asJson);
    expect(j.status).toBe(404);
    expect(await j.json()).toMatchObject({ ok: false, code: 'not_found' });
  });

  test('terminal states: no form, no context_html, the right words', async () => {
    const cases = [
      [{ status: 'used', uses_count: 1 }, 'Already used'],
      [{ status: 'disabled' }, 'Link unavailable'],
      [{ status: 'cancelled' }, 'No longer available'],
      [{ expires_at: new Date(Date.now() - 1000) }, 'Link expired'],
      [{ mode: 'repeatable', max_uses: 2, uses_count: 2 }, 'Use limit reached'],
    ];
    for (const [over, words] of cases) {
      const row = seed(over);
      const html = await (await req(`/c/${row.token}`)).text();
      expect(html).toContain(words);
      expect(html).not.toContain('<form');
      expect(html).not.toContain('class="ctx"');
      expect(html).toContain('Is this lead &lt;script&gt;');
    }
  });

  test('B1 kill switch reads as plain "unavailable" — never why; workflow mints skip the check', async () => {
    const row = seed({ minted_by: 22 });   // 22 is a non-SU in the world
    const html = await (await req(`/c/${row.token}`)).text();
    expect(html).toContain('Link unavailable');
    expect(html).not.toMatch(/superuser|minter/i);
    const j = await (await req(`/c/${row.token}`, asJson)).json();
    expect(j.status).toBe('disabled');
    const wf = seed({ mint_source: 'workflow', minted_by: 0, source_execution_id: 77 });
    expect((await (await req(`/c/${wf.token}`, asJson)).json()).status).toBe('active');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /c/:token/:value — confirm
// ═════════════════════════════════════════════════════════════════════════════

describe('GET /c/:token/:value — confirm page', () => {
  test('pre-selected option, confirm_text escaped, password field when protected', async () => {
    const row = protectedLink({
      options: [{ value: 'spam', label: 'Mark as spam', plan: [LOOKUP()], confirm_text: 'Really <b>sure</b>?' }],
    });
    const res = await req(`/c/${row.token}/spam`);
    expect(res.status).toBe(200);
    expectBaseHeaders(res);
    const html = await res.text();
    expect(html).toContain('<input type="hidden" name="value" value="spam">');
    expect(html).toContain('Really &lt;b&gt;sure&lt;/b&gt;?');
    expect(html).toMatch(/name="password"/);
    expect(html).toContain(`action="/c/${row.token}/respond"`);
  });

  test('unknown value, and the reserved "respond", 302 to the landing page (relative)', async () => {
    const row = seed();
    for (const v of ['nope', 'respond']) {
      const res = await req(`/c/${row.token}/${v}`);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(`/c/${row.token}`);
      expectBaseHeaders(res);
    }
  });

  test('JSON: the descriptor plus the selected option', async () => {
    const row = seed();
    const j = await (await req(`/c/${row.token}/keep`, asJson)).json();
    expect(j.selected).toEqual({ value: 'keep', label: 'Keep <it>' });
    expect(j.options).toHaveLength(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Content negotiation (§5.2)
// ═════════════════════════════════════════════════════════════════════════════

describe('content negotiation', () => {
  test('explicit Accept: application/json → the public descriptor, exactly', async () => {
    const row = seed({
      mode: 'repeatable', max_uses: 3, uses_count: 1, protection: 'password', password_hash: PW_HASH,
      options: [{ value: 'get', label: 'Get', plan: [LOOKUP()], result_template: 'Email: [[1.output.contact_email]]' }],
    });
    const res = await req(`/c/${row.token}`, asJson);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expectBaseHeaders(res);
    const j = await res.json();
    expect(Object.keys(j).sort()).toEqual(['expires_at', 'mode', 'options', 'prompt', 'protection', 'status', 'uses_remaining']);
    expect(j).toMatchObject({ mode: 'repeatable', protection: 'password', uses_remaining: 2, status: 'active', options: [{ value: 'get', label: 'Get' }] });
    const raw = JSON.stringify(j);
    for (const leak of [row.name, 'lookup_contact', 'result_template', 'Email:', 'ctx', 'password_hash', row.token]) {
      expect(raw).not.toContain(leak);
    }
  });

  test('*/*, a browser Accept, text/html-first and no Accept all get HTML', async () => {
    const row = seed();
    for (const accept of ['*/*', BROWSER_ACCEPT, 'text/html, application/json', undefined]) {
      const res = await req(`/c/${row.token}`, { accept });
      expect(res.headers.get('content-type')).toMatch(/text\/html/);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /c/:token/respond — HTML
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /c/:token/respond — HTML form', () => {
  test('success: receipt page, one execution via link, responder_ip is the LAST XFF element', async () => {
    const row = seed();
    const res = await req(`/c/${row.token}/respond`, { method: 'POST', form: { value: 'spam' } });
    expect(res.status).toBe(200);
    expectBaseHeaders(res);
    const html = await res.text();
    expect(html).toContain('✓ Done');
    expect(html).toContain('Mark as spam');
    const [ex] = W.execs(row.id);
    expect(ex).toMatchObject({ status: 'success', responded_via: 'link', responder_ip: IP, responder_user_id: null });
    expect(html).toContain(`Reference #${ex.id}`);
    expect(W.link(row.id).status).toBe('used');
    // the plan's raw output never reaches the page without a template
    expect(html).not.toContain('SECRET-NOTES');
    expect(html).not.toContain('pat@example.com');
  });

  test('result_template renders on the success page — HTML-escaped, and only the curated value', async () => {
    const row = seed({
      options: [{ value: 'get', label: 'Get name', plan: [LOOKUP()], result_template: 'Name: [[1.output.contact_name]]' }],
    });
    const html = await (await req(`/c/${row.token}/respond`, { method: 'POST', form: { value: 'get' } })).text();
    expect(html).toContain('Name: Pat &lt;b&gt;Doe&lt;/b&gt;');
    expect(html).not.toContain('Pat <b>Doe</b>');
    expect(html).not.toContain('SECRET-NOTES');
  });

  test('failed plan: generic page + reference, no internals', async () => {
    const row = seed({ options: [{ value: 'go', label: 'Go', plan: [LOOKUP('9999')] }] });
    const res = await req(`/c/${row.token}/respond`, { method: 'POST', form: { value: 'go' } });
    expect(res.status).toBe(200);
    const html = await res.text();
    const [ex] = W.execs(row.id);
    expect(ex.status).toBe('failed');
    const stepError = JSON.parse(ex.plan_result)[0].error;
    expect(stepError).toBeTruthy();
    expect(html).toContain("We couldn't complete that");
    expect(html).toContain(`Reference #${ex.id}`);
    expect(html).not.toContain(stepError);
    expect(html).not.toContain('lookup_contact');
    expect(html).not.toContain('9999');
  });

  test('unknown option: invalid-option page, nothing claimed', async () => {
    const row = seed();
    const html = await (await req(`/c/${row.token}/respond`, { method: 'POST', form: { value: 'nope' } })).text();
    expect(html).toContain('Invalid option');
    expect(writes()).toEqual([]);
  });

  test('a second click on a single-use link gets the terminal page', async () => {
    const row = seed();
    await req(`/c/${row.token}/respond`, { method: 'POST', form: { value: 'spam' } });
    const html = await (await req(`/c/${row.token}/respond`, { method: 'POST', form: { value: 'keep' } })).text();
    expect(html).toContain('Already used');
    expect(W.execs(row.id)).toHaveLength(1);
  });

  test('repeatable: the success page links back to the options', async () => {
    const row = seed({ mode: 'repeatable' });
    const html = await (await req(`/c/${row.token}/respond`, { method: 'POST', form: { value: 'spam' } })).text();
    expect(html).toContain(`href="/c/${row.token}"`);
    expect(W.link(row.id)).toMatchObject({ status: 'active', uses_count: 1 });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /c/:token/respond — JSON
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /c/:token/respond — JSON (agent surface)', () => {
  test('success: {ok, status, execution_id, result} — no result_html, no plan_result; via api', async () => {
    const row = seed({
      options: [{ value: 'get', label: 'Get', plan: [LOOKUP()], result_template: 'Email: [[1.output.contact_email]]' }],
    });
    const res = await req(`/c/${row.token}/respond`, { method: 'POST', ...asJson, json: { value: 'get' } });
    expect(res.status).toBe(200);
    expectBaseHeaders(res);
    const j = await res.json();
    const [ex] = W.execs(row.id);
    expect(j).toEqual({ ok: true, status: 'success', execution_id: ex.id, result: 'Email: pat@example.com' });
    expect(ex.responded_via).toBe('api');
  });

  test('return_plan_result=1 opts the raw plan_result in (B5)', async () => {
    const row = seed({ return_plan_result: 1 });
    const j = await (await req(`/c/${row.token}/respond`, { method: 'POST', ...asJson, json: { value: 'spam' } })).json();
    expect(j.plan_result).toEqual([expect.objectContaining({ fn: 'lookup_contact', ok: true })]);
  });

  test('failed plan: generic message, no internals', async () => {
    const row = seed({ options: [{ value: 'go', label: 'Go', plan: [LOOKUP('9999')] }] });
    const j = await (await req(`/c/${row.token}/respond`, { method: 'POST', ...asJson, json: { value: 'go' } })).json();
    expect(Object.keys(j).sort()).toEqual(['execution_id', 'message', 'ok', 'status']);
    expect(j).toMatchObject({ ok: true, status: 'failed' });
    expect(j.message).not.toMatch(/lookup|9999|not found/i);
  });

  test('error codes: 404 / 400 / 409 per state; the kill switch reads as disabled', async () => {
    const post = async (token, value) => {
      const res = await req(`/c/${token}/respond`, { method: 'POST', ...asJson, json: { value } });
      return [res.status, (await res.json()).code];
    };
    expect(await post('NoSuchToken1234567890', 'x')).toEqual([404, 'not_found']);
    expect(await post(seed().token, 'nope')).toEqual([400, 'unknown_option']);
    expect(await post(seed({ status: 'used', uses_count: 1 }).token, 'spam')).toEqual([409, 'used']);
    expect(await post(seed({ status: 'cancelled' }).token, 'spam')).toEqual([409, 'cancelled']);
    expect(await post(seed({ expires_at: new Date(Date.now() - 1000) }).token, 'spam')).toEqual([409, 'expired']);
    expect(await post(seed({ minted_by: 22 }).token, 'spam')).toEqual([409, 'disabled']);
    expect(W.execs()).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Passwords
// ═════════════════════════════════════════════════════════════════════════════

describe('passwords (§6, §8)', () => {
  test('wrong password: 403 confirm page, nothing claimed, the guess never echoed', async () => {
    const row = protectedLink();
    const guess = 'wrong-guess-XYZ-123';
    const res = await req(`/c/${row.token}/respond`, { method: 'POST', form: { value: 'spam', password: guess } });
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain('That password is not correct.');
    expect(html).not.toContain(guess);
    expect(html).toContain('<input type="hidden" name="value" value="spam">');   // back on the confirm page
    expect(W.link(row.id)).toMatchObject({ status: 'active', uses_count: 0, failed_attempts: 1 });
    expect(W.execs(row.id)).toHaveLength(0);
  });

  test('missing password: 401 "enter the password"; right password: success', async () => {
    const row = protectedLink();
    const r1 = await req(`/c/${row.token}/respond`, { method: 'POST', form: { value: 'spam' } });
    expect(r1.status).toBe(401);
    expect(await r1.text()).toContain('Enter the password to continue.');
    const r2 = await req(`/c/${row.token}/respond`, { method: 'POST', form: { value: 'spam', password: PW } });
    expect(r2.status).toBe(200);
    expect(await r2.text()).toContain('✓ Done');
    expect(W.link(row.id).status).toBe('used');
  });

  test('BODY ONLY: a ?password= query string is ignored (password_required)', async () => {
    const row = protectedLink();
    const res = await req(`/c/${row.token}/respond?password=${encodeURIComponent(PW)}`, {
      method: 'POST', ...asJson, json: { value: 'spam' },
    });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('password_required');
    expect(W.link(row.id).status).toBe('active');
  });

  test('JSON: 401 / 403 codes', async () => {
    const row = protectedLink();
    const bad = await req(`/c/${row.token}/respond`, { method: 'POST', ...asJson, json: { value: 'spam', password: 'nope-nope-nope' } });
    expect(bad.status).toBe(403);
    expect((await bad.json()).code).toBe('bad_password');
    const good = await req(`/c/${row.token}/respond`, { method: 'POST', ...asJson, json: { value: 'spam', password: PW } });
    expect((await good.json())).toMatchObject({ ok: true, status: 'success' });
  });

  test('PASSWORD LIMITER: the 6th wrong guess per token+IP is 429 and never reaches bcrypt; other IPs and tokens unaffected', async () => {
    const row = protectedLink();
    const other = protectedLink();
    const spy = jest.spyOn(bcrypt, 'compare');
    try {
      for (let i = 0; i < 5; i++) {
        const r = await req(`/c/${row.token}/respond`, { method: 'POST', form: { value: 'spam', password: `guess-${i}` } });
        expect(r.status).toBe(403);
      }
      expect(spy).toHaveBeenCalledTimes(5);
      const sixth = await req(`/c/${row.token}/respond`, { method: 'POST', form: { value: 'spam', password: PW } });
      expect(sixth.status).toBe(429);
      expectBaseHeaders(sixth);
      expect(await sixth.text()).toContain('Too many password attempts');
      expect(spy).toHaveBeenCalledTimes(5);                    // no bcrypt for the 6th…
      expect(W.link(row.id)).toMatchObject({ status: 'active', failed_attempts: 5 });   // …and nothing claimed

      const json6 = await req(`/c/${row.token}/respond`, { method: 'POST', ...asJson, json: { value: 'spam', password: PW } });
      expect(json6.status).toBe(429);
      expect((await json6.json()).code).toBe('too_many_passwords');

      // a different IP on the same token, and the same IP on another token, keep their own budgets
      const fromElsewhere = await req(`/c/${row.token}/respond`, { method: 'POST', ip: '192.0.2.200', form: { value: 'spam', password: 'x-wrong-x' } });
      expect(fromElsewhere.status).toBe(403);
      const otherToken = await req(`/c/${other.token}/respond`, { method: 'POST', ip: '192.0.2.201', form: { value: 'spam', password: PW } });
      expect(otherToken.status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });

  test('REFUND: correct passwords never spend the budget — a repeatable password link keeps working', async () => {
    const row = protectedLink({ mode: 'repeatable' });
    for (let i = 0; i < 6; i++) {
      const r = await req(`/c/${row.token}/respond`, { method: 'POST', ...asJson, json: { value: 'spam', password: PW } });
      expect(r.status).toBe(200);
    }
    // the budget is still a full 5 wrong guesses…
    for (let i = 0; i < 3; i++) {
      expect((await req(`/c/${row.token}/respond`, { method: 'POST', ...asJson, json: { value: 'spam', password: 'wrong-pw-' + i } })).status).toBe(403);
    }
    expect(W.execs(row.id)).toHaveLength(6);
    expect(W.link(row.id).uses_count).toBe(6);
  });

  test('BURST: 8 parallel wrong guesses — at most 5 reach bcrypt (reserve before compare)', async () => {
    const row = protectedLink();
    const spy = jest.spyOn(bcrypt, 'compare');
    try {
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
        req(`/c/${row.token}/respond`, { method: 'POST', ...asJson, json: { value: 'spam', password: `burst-${i}` } })
          .then((r) => r.status)));
      expect(results.filter((s) => s === 403)).toHaveLength(5);
      expect(results.filter((s) => s === 429)).toHaveLength(3);
      expect(spy).toHaveBeenCalledTimes(5);
      expect(W.link(row.id).failed_attempts).toBe(5);
    } finally {
      spy.mockRestore();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Limiters — WIRED (the /d/ respond limiter sat declared-but-unused for weeks)
// ═════════════════════════════════════════════════════════════════════════════

describe('limiters', () => {
  test('RESPOND LIMITER: 10 POSTs per minute per IP; the 11th is 429 and never touches the DB', async () => {
    const row = seed({ mode: 'repeatable' });
    for (let i = 0; i < 10; i++) {
      const r = await req(`/c/${row.token}/respond`, { method: 'POST', form: { value: 'spam' } });
      expect(r.status).toBe(200);
    }
    expect(W.execs(row.id)).toHaveLength(10);
    const before = W.queries.length;
    const eleventh = await req(`/c/${row.token}/respond`, { method: 'POST', form: { value: 'spam' } });
    expect(eleventh.status).toBe(429);
    expectBaseHeaders(eleventh);
    expect(W.queries.length).toBe(before);
    expect(W.execs(row.id)).toHaveLength(10);
    // keyed on the LAST XFF element: rotating the client-supplied first element buys nothing
    const rotated = await req(`/c/${row.token}/respond`, { method: 'POST', firstXff: '10.9.9.9', form: { value: 'spam' } });
    expect(rotated.status).toBe(429);
    const j = await req(`/c/${row.token}/respond`, { method: 'POST', ...asJson, json: { value: 'spam' } });
    expect(j.status).toBe(429);
    expect((await j.json()).code).toBe('rate_limited');
  });

  test('READ LIMITER: 30 GETs per minute per IP across both GET routes; the 31st is 429 and never touches the DB', async () => {
    const row = seed();
    for (let i = 0; i < 30; i++) {
      const r = await req(i % 2 ? `/c/${row.token}` : `/c/${row.token}/spam`);
      expect(r.status).toBe(200);
    }
    const before = W.queries.length;
    for (const p of [`/c/${row.token}`, `/c/${row.token}/spam`]) {
      const r = await req(p);
      expect(r.status).toBe(429);
      expectBaseHeaders(r);
    }
    expect(W.queries.length).toBe(before);
    // POST has its own bucket
    expect((await req(`/c/${row.token}/respond`, { method: 'POST', form: { value: 'spam' } })).status).toBe(200);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Clicker inputs (§12, slice S1i)
// ═════════════════════════════════════════════════════════════════════════════

describe('clicker inputs (§12)', () => {
  // Seeded rows carry STORED (already-normalized) declarations — the surface
  // is under test here; mint validation lives in tests/ctaInputs.test.js.
  const NOTE = { name: 'note', label: 'Your <b>note</b>', type: 'text', required: true, maxlen: 500, pattern: '[^#]+' };
  const PICK = { name: 'pick', label: 'Pick', type: 'enum', required: false, maxlen: 3, choices: ['yes', 'no'] };
  const SHORT = { name: 'ref', label: 'Ref', type: 'text', required: false, maxlen: 20, default: '"><b>dflt' };
  const LOGN = (msg = '[[input:note]]') => ({ fn: 'create_log', params: { type: 'note', message: msg } });
  const inputsLink = (over = {}) => seed({
    options: [
      { value: 'tell', label: 'Tell us', inputs: [NOTE, PICK, SHORT],
        plan: [LOGN(), LOGN('[[input:pick]]'), LOGN('[[input:ref]]')] },
      { value: 'keep', label: 'Keep <it>', plan: [LOOKUP()] },
    ],
    ...over,
  });
  const planMessages = () => W.logs.map((p) => require('./helpers/ctaWorld').decodeLog(p)).filter((l) => l.subject !== 'CTA');

  test('landing: an option with inputs links to its confirm page (no fields on the landing form)', async () => {
    const row = inputsLink();
    const html = await (await req(`/c/${row.token}`)).text();
    expect(html).toContain(`href="/c/${row.token}/tell"`);
    expect(html).not.toContain('name="value" value="tell"');
    expect(html).toContain('name="value" value="keep"');
    expect(html).not.toMatch(/name="in_/);
  });

  test('confirm page: escaped labels, house label/hint classes, type-appropriate controls, defaults escaped, never the pattern; GET writes nothing', async () => {
    const row = inputsLink();
    const res = await req(`/c/${row.token}/tell`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<label class="input-label" for="cta-in-note">Your &lt;b&gt;note&lt;/b&gt;</label>');
    expect(html).not.toContain('Your <b>note</b>');
    // long text → textarea with maxlength; required attr; hint in .sub-label
    expect(html).toMatch(/<textarea id="cta-in-note" name="in_note" class="cta-input" required aria-describedby="cta-in-note-hint" maxlength="500" rows="4"><\/textarea>/);
    expect(html).toContain('<div class="sub-label" id="cta-in-note-hint">Required · up to 500 characters</div>');
    // enum → select, optional → a blank choice
    expect(html).toMatch(/<select id="cta-in-pick" name="in_pick" class="cta-input" aria-describedby="cta-in-pick-hint"><option value="" selected>\(none\)<\/option><option value="yes">yes<\/option><option value="no">no<\/option><\/select>/);
    expect(html).toContain('<div class="sub-label" id="cta-in-pick-hint">Optional</div>');
    // short text → input, default pre-filled ESCAPED
    expect(html).toContain('<input type="text" maxlength="20" id="cta-in-ref" name="in_ref" class="cta-input" aria-describedby="cta-in-ref-hint" value="&quot;&gt;&lt;b&gt;dflt">');
    expect(html).not.toContain('"><b>dflt');
    expect(html).not.toContain('[^#]+');
    // fields sit inside the form, above the confirm button
    const form = html.slice(html.indexOf('<form'));
    expect(form.indexOf('name="in_note"')).toBeLessThan(form.indexOf('✓ Confirm'));
    expect(allWrites()).toEqual([]);
  });

  test('POST (form): valid inputs run the plan with normalized values; stored on the execution', async () => {
    const row = inputsLink();
    const res = await req(`/c/${row.token}/respond`, { method: 'POST', form: { value: 'tell', in_note: '  Hello <there>  ', in_pick: 'yes' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('✓ Done');
    // blank optional with a default → the default (raw: create_log.message is a text param)
    expect(planMessages().map((l) => l.message)).toEqual(['Hello <there>', 'yes', '"><b>dflt']);
    const [ex] = W.execs(row.id);
    expect(JSON.parse(ex.inputs)).toEqual({ note: 'Hello <there>', pick: 'yes', ref: '"><b>dflt' });
  });

  test('POST (form): rejected inputs → 400 confirm page, per-field errors, entered values ECHOED ESCAPED, nothing claimed', async () => {
    const row = inputsLink();
    const evil = '"><img src=x onerror=alert(1)>#';
    const res = await req(`/c/${row.token}/respond`, { method: 'POST', form: { value: 'tell', in_note: evil, in_pick: 'maybe', in_bogus: 'x' } });
    expect(res.status).toBe(400);
    expectBaseHeaders(res);
    const html = await res.text();
    expect(html).toContain('Please correct the highlighted fields.');
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;#</textarea>');
    expect(html).not.toContain('<img src=x');
    expect(html).toMatch(/<div class="cta-field has-error">\s*<label class="input-label" for="cta-in-note">/);
    expect(html).toContain('<div class="cta-field-error" role="alert">This is not in the expected format.</div>');
    expect(html).toContain('<div class="cta-field-error" role="alert">Choose one of the listed options.</div>');
    expect(html).toContain('aria-invalid="true"');
    expect(writes()).toEqual([]);
    expect(W.link(row.id)).toMatchObject({ status: 'active', uses_count: 0 });
  });

  test('POST (form): a wrong password re-renders with the inputs kept — never the password', async () => {
    const row = inputsLink({ protection: 'password', password_hash: PW_HASH });
    const res = await req(`/c/${row.token}/respond`, { method: 'POST', form: { value: 'tell', in_note: 'kept text', password: 'wrong-guess-123' } });
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain('That password is not correct.');
    expect(html).toContain('>kept text</textarea>');
    expect(html).not.toContain('wrong-guess-123');
    expect(writes().filter((q) => !/failed_attempts/.test(q.sql))).toEqual([]);
  });

  test('POST (form): the qs `inputs[name]` shape is the same submission', async () => {
    const row = inputsLink();
    const res = await req(`/c/${row.token}/respond`, { method: 'POST', form: { value: 'tell', 'inputs[note]': 'via qs' } });
    expect(res.status).toBe(200);
    expect(planMessages()[0].message).toBe('via qs');
  });

  test('confirm page: the SU\'s hint sits under its control, escaped, ahead of the Required line — both describe the field', async () => {
    const row = inputsLink({
      options: [{ value: 'tell', label: 'Tell us',
        inputs: [{ ...NOTE, hint: 'A sentence or two — <i>no</i> case numbers' }, PICK, SHORT],
        plan: [LOGN(), LOGN('[[input:pick]]'), LOGN('[[input:ref]]')] }],
    });
    const html = await (await req(`/c/${row.token}/tell`)).text();
    expect(html).toContain('aria-describedby="cta-in-note-help cta-in-note-hint"');
    const help = '<div class="sub-label" id="cta-in-note-help">A sentence or two — &lt;i&gt;no&lt;/i&gt; case numbers</div>';
    expect(html).toContain(help);
    expect(html).not.toContain('<i>no</i>');
    const at = (s) => html.indexOf(s);
    expect(at('<textarea id="cta-in-note"')).toBeLessThan(at(help));
    expect(at(help)).toBeLessThan(at('<div class="sub-label" id="cta-in-note-hint">'));
    // no hint, no help line, and the describedby stays single
    expect(html).toContain('aria-describedby="cta-in-pick-hint"');
    expect(html).not.toContain('cta-in-pick-help');
    const d = await (await req(`/c/${row.token}`, asJson)).json();
    expect(d.options[0].inputs[0].hint).toBe('A sentence or two — <i>no</i> case numbers');
  });

  test('JSON: descriptor + selected carry the declarations (never pattern/plans); respond takes inputs:{}', async () => {
    const row = inputsLink();
    const d = await (await req(`/c/${row.token}`, asJson)).json();
    expect(d.options).toEqual([
      { value: 'tell', label: 'Tell us', inputs: [
        { name: 'note', label: 'Your <b>note</b>', type: 'text', required: true, maxlen: 500 },
        { name: 'pick', label: 'Pick', type: 'enum', required: false, choices: ['yes', 'no'], maxlen: 3 },
        { name: 'ref', label: 'Ref', type: 'text', required: false, maxlen: 20, default: '"><b>dflt' },
      ] },
      { value: 'keep', label: 'Keep <it>' },
    ]);
    const sel = await (await req(`/c/${row.token}/tell`, asJson)).json();
    expect(sel.selected).toEqual(d.options[0]);
    expect(JSON.stringify(d) + JSON.stringify(sel)).not.toMatch(/\[\^#\]|\[\[input|create_log/);

    const bad = await req(`/c/${row.token}/respond`, { method: 'POST', ...asJson, json: { value: 'tell', inputs: { note: '#', extra: 1 } } });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({
      ok: false, code: 'invalid_inputs', message: 'Some inputs are not valid — see errors.',
      errors: { extra: 'Unknown field.', note: 'This is not in the expected format.' },
    });
    const notObj = await (await req(`/c/${row.token}/respond`, { method: 'POST', ...asJson, json: { value: 'tell', inputs: 'note=x' } })).json();
    expect(notObj).toMatchObject({ code: 'invalid_inputs', form_error: 'inputs must be an object of input name to value' });
    const onPlain = await req(`/c/${row.token}/respond`, { method: 'POST', ...asJson, json: { value: 'keep', inputs: { note: 'x' } } });
    expect([onPlain.status, (await onPlain.json()).errors]).toEqual([400, { note: 'Unknown field.' }]);
    expect(writes()).toEqual([]);

    const ok = await (await req(`/c/${row.token}/respond`, { method: 'POST', ...asJson, json: { value: 'tell', inputs: { note: 'agent says hi' } } })).json();
    expect(ok).toMatchObject({ ok: true, status: 'success' });
    expect(W.execs(row.id)[0].responded_via).toBe('api');
  });

  test('GET PRE-CHECK (S1i review): a refused link reads "unavailable" on the landing, confirm and JSON reads — no form offered', async () => {
    const SMS_IN = [{ name: 'to', label: 'Phone', type: 'phone', required: true, maxlen: 16 }];
    const SMS_PLAN = [{ fn: 'send_sms', params: { from: '2485559999', to: '[[input:to]]', message: 'hi' } }];
    const cases = [
      // B1: repeatable open-recipient link with no cap (a SQL edit — PATCH refuses it)
      seed({ mode: 'repeatable', max_uses: null, options: [{ value: 'go', label: 'Go', inputs: SMS_IN, plan: SMS_PLAN }] }),
      // a binding into a param that isn't open
      seed({ options: [{ value: 'go', label: 'Go', inputs: [{ ...NOTE, name: 'cid', pattern: undefined }],
        plan: [{ fn: 'lookup_contact', params: { contact_id: '[[input:cid]]' } }] }] }),
      // N2: a text input feeding a recipient
      seed({ options: [{ value: 'go', label: 'Go', inputs: [{ ...NOTE, name: 'to', pattern: undefined }], plan: SMS_PLAN }] }),
    ];
    for (const row of cases) {
      for (const path of [`/c/${row.token}`, `/c/${row.token}/go`]) {
        const html = await (await req(path)).text();
        expect(html).toContain('Link unavailable');
        expect(html).not.toContain('<form');
        expect(html).not.toMatch(/binding|recipient|max_uses|\[\[input/i);
      }
      expect((await (await req(`/c/${row.token}`, asJson)).json()).status).toBe('disabled');
    }
    // a capped link is offered normally
    const ok = seed({ mode: 'repeatable', max_uses: 3, options: [{ value: 'go', label: 'Go', inputs: SMS_IN, plan: SMS_PLAN }] });
    expect(await (await req(`/c/${ok.token}/go`)).text()).toContain('name="in_to"');
    expect(allWrites()).toEqual([]);
  });

  test('a binding closed since mint reads as plain "unavailable" — never why — and claims nothing', async () => {
    const row = seed({ options: [{ value: 'go', label: 'Go', inputs: [{ ...NOTE, name: 'cid', pattern: undefined }],
      plan: [{ fn: 'lookup_contact', params: { contact_id: '[[input:cid]]' } }] }] });
    const html = await (await req(`/c/${row.token}/respond`, { method: 'POST', form: { value: 'go', in_cid: '1001' } })).text();
    expect(html).toContain('Link unavailable');
    expect(html).not.toMatch(/binding|\[\[input|lookup_contact|closed/i);
    const j = await req(`/c/${row.token}/respond`, { method: 'POST', ...asJson, json: { value: 'go', inputs: { cid: '1001' } } });
    expect([j.status, (await j.json()).code]).toEqual([409, 'disabled']);
    expect(writes()).toEqual([]);
  });
});
