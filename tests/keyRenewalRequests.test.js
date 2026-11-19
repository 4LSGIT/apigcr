// tests/keyRenewalRequests.test.js
//
/**
 * Session-key renewal requests — the parts that need no MySQL (key-renew-req).
 * The SQL, the UNIQUE pending row, approve / deny and the email flow end to end
 * are in tests/keyRenewalRequests.mysql.test.js (gated on YC_TEST_MYSQL_URL).
 *
 * WHAT IS LOCKED
 *   - the email: key id / label / prefix / scopes, Expired vs Expires, the
 *     reason, the TTL asked (or the default) and the max, the request IP, and
 *     the pane link — whose rest the shell's ycSubTab accepts unchanged;
 *   - readonlyApiKeyAuthAllowExpired: an expired key passes with
 *     auth.expired, the usage counter untouched; revoked / unknown / missing
 *     still 401; the ordinary readonlyApiKeyAuth still refuses the expired key;
 *   - the POST's refusals before anything is written: a child 409, a reason
 *     outside 10–200 → 400, a TTL over the cap → 400 naming default + max;
 *   - readonlyKeys.html: a pending card offers the TTL choices within the cap,
 *     preselects the one asked, Approve sends it, Deny posts; a decided card
 *     has no buttons; the email link's renew-<id> outlines that card, and a
 *     linked request outside the list is fetched by id.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const express = require('express');
const { JSDOM } = require('jsdom');
const { readonlyApiKeyAuth, readonlyApiKeyAuthAllowExpired } = require('../lib/auth.readonly');
const { _test: T } = require('../routes/api.keyRenewalRequests');

const ROOT = path.join(__dirname, '..');
const flush = () => new Promise(r => setTimeout(r, 0));

function loadYcSubTab() {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public/js/ycSubTab.js'), 'utf8'), ctx);
  return ctx.window.ycSubTab;
}

describe('the email', () => {
  const key = {
    id: 34, label: 'docs review', key_prefix: 'ycro_AbCdEfG', scopes: '["sql.ro","scratch"]',
    expires_at: new Date('2026-11-19T15:00:00Z'), last_used_at: new Date('2026-11-19T14:58:00Z'),
  };
  const caps = { default_minutes: 1440, max_minutes: 4320, sensitive: false };
  const request = { id: 57, reason: 'finishing the docs review arc', requested_ttl_min: 240, request_ip: '203.0.113.9' };

  test('names the key, its expiry, the reason, the TTL asked + max, the IP and the link', () => {
    const { subject, text } = T.buildEmail({ request, key, caps, now: Date.parse('2026-11-19T16:00:00Z') });
    expect(subject).toBe('[YisraCase] Session key #34 "docs review" asks to be renewed');
    expect(text).toContain('Key:        #34 "docs review" (ycro_AbCdEfG…)');
    expect(text).toContain('Scopes:     sql.ro, scratch');
    expect(text).toMatch(/Expired:    Thu Nov 19, 2026 10:00 AM EST/);
    expect(text).toMatch(/Last used:  Thu Nov 19, 2026 9:58 AM EST/);
    expect(text).toContain('Reason:     finishing the docs review arc');
    expect(text).toContain('Asked for:  4 hours — the max for this key is 3 days');
    expect(text).toContain('From IP:    203.0.113.9');
    expect(text).toContain('https://app.4lsg.com/?open=tabPanel~adminReadonlyKeys~renew-57');
    expect(text).toContain("The key's secret does not change");
  });

  test('a live key reads "Expires"; no TTL asked reads the default; legacy scopes say so', () => {
    const { text } = T.buildEmail({
      request: { ...request, requested_ttl_min: null }, key: { ...key, scopes: null }, caps,
      now: Date.parse('2026-11-19T14:00:00Z'),
    });
    expect(text).toMatch(/Expires:    Thu Nov 19/);
    expect(text).toContain('Asked for:  the default (1 day) — the max for this key is 3 days');
    expect(text).toContain('Scopes:     legacy (full historical surface)');
  });

  test("the link's rest is one the shell keeps as-is (ycSubTab), for any id", () => {
    const ycSubTab = loadYcSubTab();
    for (const id of [1, 57, 999999999999]) {
      const rest = new URL(T.requestLink(id)).searchParams.get('open').replace(/^tabPanel~/, '');
      expect(ycSubTab.normalize(rest)).toBe(`adminReadonlyKeys~renew-${id}`);
    }
  });

  test('the HTML part: the same rows, one button into the pane, the plain link as a fallback', () => {
    const { html } = T.buildEmail({ request, key, caps, now: Date.parse('2026-11-19T16:00:00Z') });
    const link = 'https://app.4lsg.com/?open=tabPanel~adminReadonlyKeys~renew-57';
    const buttons = html.match(/<a href="[^"]*" style="display:inline-block[^"]*">[^<]*<\/a>/g);
    expect(buttons).toEqual([`<a href="${link}" style="display:inline-block;padding:10px 22px;background:#2563eb;border:1px solid #2563eb;border-radius:6px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none">Review &amp; renew key #34</a>`]);
    expect(html).toContain(`Button not working? <a href="${link}"`);
    for (const label of ['Key', 'Scopes', 'Expired', 'Last used', 'Reason', 'Asked for', 'From IP']) expect(html).toContain(`>${label}</td>`);
    expect(html).toMatch(/font-weight:600;">finishing the docs review arc<\/td>/);
    expect(html).toContain('4 hours — the max for this key is 3 days');
  });

  test('the HTML part escapes the label and the reason', () => {
    const { html, text } = T.buildEmail({
      request: { ...request, reason: 'need it <img src=x onerror=alert(1)> & "now"' },
      key: { ...key, label: '<script>x</script>' }, caps,
    });
    expect(html).not.toMatch(/<script>|<img/);
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).toContain('need it &lt;img src=x onerror=alert(1)&gt; &amp; &quot;now&quot;');
    expect(text).toContain('Reason:     need it <img src=x onerror=alert(1)> & "now"');   // text-only: emailService escapes
  });

  test('fmtMinutes', () => {
    expect([30, 90, 240, 1440, 1800, 4320, 1441].map(T.fmtMinutes))
      .toEqual(['30 minutes', '1 hour 30 minutes', '4 hours', '1 day', '1 day 6 hours', '3 days', '1 day 1 minute']);
  });
});

// ── auth ─────────────────────────────────────────────────────────────────────

function keyDb(row) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      const s = String(sql);
      calls.push(s);
      if (/FROM readonly_api_keys k/.test(s)) return [row ? [row] : []];
      if (/UPDATE readonly_api_keys/.test(s)) return [{}];
      if (/admin_audit_log/.test(s)) return [{ insertId: 1 }];
      throw new Error('unscripted: ' + s);
    },
  };
}
async function through(mw, row, header = 'ycro_abc') {
  const db = keyDb(row);
  const req = { headers: header ? { 'x-readonly-api-key': header } : {}, db, originalUrl: '/x', method: 'POST', socket: {} };
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  let passed = false;
  await mw(req, res, () => { passed = true; });
  await flush();
  return { passed, res, req, db };
}
const keyRow = (over = {}) => ({ id: 70, label: 'k', expires_at: new Date(Date.now() - 3600e3), revoked_at: null,
  scopes: '["sql.ro"]', parent_key_id: null, created_by: 6, ...over });

describe('readonlyApiKeyAuthAllowExpired', () => {
  test('an expired key passes with auth.expired; the usage counter is not touched', async () => {
    const r = await through(readonlyApiKeyAuthAllowExpired, keyRow());
    expect(r.passed).toBe(true);
    expect(r.req.auth).toMatchObject({ keyId: 70, expired: true, createdBy: 6 });
    expect(r.db.calls.some(s => /UPDATE readonly_api_keys/.test(s))).toBe(false);
  });

  test('a live key passes with expired:false', async () => {
    const r = await through(readonlyApiKeyAuthAllowExpired, keyRow({ expires_at: new Date(Date.now() + 3600e3) }));
    expect(r.req.auth.expired).toBe(false);
  });

  test('revoked, unknown, missing → 401 as ever; the ordinary auth still refuses the expired key', async () => {
    expect((await through(readonlyApiKeyAuthAllowExpired, keyRow({ revoked_at: new Date() }))).res.statusCode).toBe(401);
    expect((await through(readonlyApiKeyAuthAllowExpired, null)).res.statusCode).toBe(401);
    expect((await through(readonlyApiKeyAuthAllowExpired, keyRow(), null)).res.statusCode).toBe(401);
    const plain = await through(readonlyApiKeyAuth, keyRow());
    expect([plain.passed, plain.res.statusCode, plain.res.body.error]).toEqual([false, 401, 'Readonly API key expired']);
  });

  test("the ordinary auth's expired 401 points a ROOT key at the renewal route; a child gets no pointer", async () => {
    const root = await through(readonlyApiKeyAuth, keyRow());
    expect(root.res.body.renewal).toMatch(/^POST \/api\/readonly\/renewal-request .*reason.*10-200.*GET \/api\/readonly\/renewal-request.*SAME key/);
    const child = await through(readonlyApiKeyAuth, keyRow({ parent_key_id: 9, parent_id: 9, parent_expires_at: new Date(Date.now() + 1e6) }));
    expect(child.res.statusCode).toBe(401);
    expect(child.res.body).not.toHaveProperty('renewal');
  });

  test('a child of a revoked parent is refused; of an expired parent it passes (the route answers 409)', async () => {
    const child = { parent_key_id: 9, parent_id: 9, parent_scopes: '["sql.ro","keys.mint"]' };
    const dead = await through(readonlyApiKeyAuthAllowExpired, keyRow({ ...child, parent_revoked_at: new Date(), parent_expires_at: new Date() }));
    expect(dead.res.statusCode).toBe(401);
    const old = await through(readonlyApiKeyAuthAllowExpired, keyRow({ ...child, parent_revoked_at: null, parent_expires_at: new Date(Date.now() - 1e3) }));
    expect(old.passed).toBe(true);
    expect(old.req.auth.parentKeyId).toBe(9);
  });
});

// ── the POST's refusals (nothing written) ────────────────────────────────────

describe('POST /api/readonly/renewal-request refusals', () => {
  let server, base, writes;
  const row = { current: null };
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.db = {
        query: async (sql) => {
          const s = String(sql);
          if (/FROM readonly_api_keys k\s+LEFT JOIN readonly_api_keys p/.test(s)) return [[row.current]];
          if (/FROM readonly_api_keys k\s+LEFT JOIN users/.test(s)) return [[{ ...row.current, key_prefix: 'ycro_x', creator_username: 'IT', creator_email: 'it@x.test' }]];
          if (/admin_audit_log/.test(s)) return [{ insertId: 1 }];
          writes.push(s);
          return [[]];
        },
      };
      next();
    });
    app.use(require('../routes/api.keyRenewalRequests'));
    server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise(r => server.close(r)));
  beforeEach(() => { writes = []; row.current = keyRow(); });
  const ask = async (body) => {
    const r = await fetch(base + '/api/readonly/renewal-request', {
      method: 'POST', headers: { 'x-readonly-api-key': 'ycro_abc', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };

  test('a child key → 409 naming its manager route', async () => {
    row.current = keyRow({ parent_key_id: 9, parent_id: 9, parent_scopes: '["sql.ro","keys.mint"]', parent_expires_at: new Date(Date.now() + 1e6) });
    const r = await ask({ reason: 'a perfectly fine reason' });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('/api/readonly-keys/children/70/renew');
    expect(writes).toEqual([]);
  });

  test('reason outside 10–200 (after trim) → 400', async () => {
    for (const reason of [undefined, '', '  nine ch  ', 'x'.repeat(201), 5]) {
      const r = await ask({ reason });
      expect([JSON.stringify(reason), r.status]).toEqual([JSON.stringify(reason), 400]);
      expect(r.body.error).toMatch(/10–200 characters/);
    }
    expect(writes).toEqual([]);
  });

  test('a TTL over the cap → 400 naming default + max (ordinary 3 days; sensitive 24h)', async () => {
    let r = await ask({ reason: 'a perfectly fine reason', ttlMinutes: 4321 });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ maxTtlMinutes: 4320, defaultTtlMinutes: 1440 });
    row.current = keyRow({ scopes: '["sql.ro","sql.ro.sensitive"]' });
    r = await ask({ reason: 'a perfectly fine reason', ttlMinutes: 1441 });
    expect(r.body).toMatchObject({ maxTtlMinutes: 1440, defaultTtlMinutes: 240 });
    expect(writes).toEqual([]);
  });
});

// ── the pane ─────────────────────────────────────────────────────────────────

function bootPane({ requests = [], byId = {}, held = null } = {}) {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'readonlyKeys.html'), 'utf8');
  const sent = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    beforeParse(w) {
      w.alert = (m) => sent.push({ alert: m });
      w.HTMLElement.prototype.scrollIntoView = function () { sent.push({ scrolled: this.id }); };
      if (held !== null) w.ycSubTab = { leaf: { take: () => held } };
      w.apiSend = async (url, method, body) => {
        sent.push({ url, method, body });
        if (method === 'GET' && url.startsWith('/api/readonly-keys/renewal-requests?id=')) {
          const id = Number(url.split('=').pop());
          return { ok: true, requests: byId[id] ? [byId[id]] : [] };
        }
        if (method === 'GET' && url.startsWith('/api/readonly-keys/renewal-requests')) return { ok: true, requests };
        if (method === 'GET') return { ok: true, keys: [] };
        if (/\/approve$/.test(url)) return { ok: true, keyId: 34, ttlMinutes: body.ttlMinutes, expiresAt: new Date().toISOString() };
        return { ok: true };
      };
    },
  });
  return { w: dom.window, d: dom.window.document, sent };
}
const pendingReq = (over = {}) => ({
  id: 57, key_id: 34, key_label: 'docs review', key_prefix: 'ycro_AbCdEfG', key_scopes: ['sql.ro', 'scratch'],
  reason: 'finishing <b>the</b> docs review', requested_ttl_min: 240, status: 'pending',
  key_expires_at: '2026-11-19T15:00:00Z', requested_at: '2026-11-19T16:00:00Z', key_last_used_at: '2026-11-19T14:58:00Z',
  request_ip: '203.0.113.9', notify_user: 6, notify_username: 'IT', email_error: null, key_revoked_at: null,
  caps: { default_minutes: 1440, max_minutes: 4320, sensitive: false }, ...over,
});

describe('readonlyKeys.html — renewal requests', () => {
  test('the boot is the script\'s LAST statement (a boot above a top-level const read it in its TDZ, twice)', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'readonlyKeys.html'), 'utf8');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toMatch(/\(function waitForParent\(\) \{\s*if \(P && P\.apiSend\) return init\(\);\s*setTimeout\(waitForParent, 100\);\s*\}\)\(\);\s*$/);
    expect(scripts[0].match(/waitForParent\(\)/g)).toHaveLength(1);
  });

  test('waiting requests open; past ones folded in a CLOSED "Past requests (N)"', async () => {
    const { d } = bootPane({ requests: [pendingReq(),
      pendingReq({ id: 50, status: 'approved', decided_by_username: 'IT', decided_at: '2026-11-18T10:00:00Z', granted_ttl_min: 60, new_expires_at: '2026-11-18T11:00:00Z' }),
      pendingReq({ id: 49, status: 'denied', decided_by_username: 'IT', decided_at: '2026-11-17T10:00:00Z' })] });
    await flush(); await flush();
    expect([...d.querySelectorAll('#rrList .rr-card')].map(c => c.id)).toEqual(['rr-57']);   // waiting ones only
    const hist = d.getElementById('rrHistory');
    expect([hist.style.display, hist.open]).toEqual(['', false]);
    expect(d.getElementById('rrHistorySum').textContent).toBe('Past requests (2)');
    expect([...d.querySelectorAll('#rrHistoryList .rr-card')].map(c => c.id)).toEqual(['rr-50', 'rr-49']);
  });

  test('nothing waiting → one line; no past → no fold; a full page says so', async () => {
    let p = bootPane({ requests: [] });
    await flush(); await flush();
    expect(p.d.getElementById('rrList').textContent.trim()).toBe('No requests waiting.');
    expect(p.d.getElementById('rrHistory').style.display).toBe('none');
    const many = Array.from({ length: 50 }, (_, i) => pendingReq({ id: 100 + i, status: 'denied', decided_at: '2026-11-01T00:00:00Z' }));
    p = bootPane({ requests: many });
    await flush(); await flush();
    expect(p.d.getElementById('rrHistorySum').textContent).toBe('Past requests (50+, newest shown)');
  });

  test('a link to a DECIDED request opens the fold', async () => {
    const past = pendingReq({ id: 50, status: 'approved', decided_by_username: 'IT', decided_at: '2026-11-18T10:00:00Z', granted_ttl_min: 60, new_expires_at: '2026-11-18T11:00:00Z' });
    let p = bootPane({ requests: [pendingReq(), past], held: 'renew-50' });
    await flush(); await flush();
    expect(p.d.getElementById('rrHistory').open).toBe(true);
    expect(p.d.getElementById('rr-50').classList.contains('rr-focus')).toBe(true);
    p = bootPane({ requests: [pendingReq(), past], held: 'renew-57' });   // a waiting one: the fold stays shut
    await flush(); await flush();
    expect(p.d.getElementById('rrHistory').open).toBe(false);
  });

  test('a pending card: choices within the cap, the asked TTL preselected, the reason escaped', async () => {
    const { d } = bootPane({ requests: [pendingReq()] });
    await flush(); await flush();
    const card = d.getElementById('rr-57');
    expect(card.textContent).toContain('Key #34 "docs review"');
    expect(card.querySelector('.rr-reason').innerHTML).toContain('&lt;b&gt;the&lt;/b&gt;');
    expect(card.textContent).toMatch(/Expired/);
    const opts = [...card.querySelectorAll('select option')].map(o => [o.value, o.textContent, o.selected]);
    expect(opts).toEqual([
      ['240', '4 hours (asked)', true],
      ['1440', '1 day (default)', false],
      ['4320', '3 days (max)', false],
    ]);
  });

  test('Approve sends the chosen TTL; Deny posts; both reload the list', async () => {
    const { w, d, sent } = bootPane({ requests: [pendingReq()] });
    await flush(); await flush();
    d.getElementById('rrTtl-57').value = '4320';
    await w.approveRequest(57);
    expect(sent.find(s => /approve$/.test(s.url))).toEqual({ url: '/api/readonly-keys/renewal-requests/57/approve', method: 'POST', body: { ttlMinutes: 4320 } });
    expect(d.getElementById('rrNotice').textContent).toMatch(/Request #57 approved: key #34 renewed for 3 days/);
    await w.denyRequest(57);
    expect(sent.find(s => /deny$/.test(s.url))).toMatchObject({ method: 'POST' });
    expect(sent.filter(s => s.method === 'GET' && s.url.startsWith('/api/readonly-keys/renewal-requests')).length).toBeGreaterThanOrEqual(3);
  });

  test('a sensitive key caps the choices at 24h; no TTL asked preselects the default', async () => {
    const { d } = bootPane({ requests: [pendingReq({ requested_ttl_min: null, caps: { default_minutes: 240, max_minutes: 1440, sensitive: true } })] });
    await flush(); await flush();
    const opts = [...d.querySelectorAll('#rr-57 select option')].map(o => [o.value, o.selected]);
    expect(opts).toEqual([['240', true], ['1440', false]]);
  });

  test('a decided card has no buttons; a revoked key offers Deny only', async () => {
    const { d } = bootPane({ requests: [
      pendingReq({ id: 58, key_revoked_at: '2026-11-19T17:00:00Z' }),
      pendingReq({ id: 50, status: 'approved', decided_by_username: 'IT', decided_at: '2026-11-18T10:00:00Z', granted_ttl_min: 1440, new_expires_at: '2026-11-19T10:00:00Z' }),
    ] });
    await flush(); await flush();
    expect(d.querySelector('#rr-50 button')).toBeNull();
    expect(d.getElementById('rr-50').textContent).toMatch(/approved by IT .* 1 day/);
    expect(d.querySelector('#rr-58 .rr-approve')).toBeNull();
    expect(d.querySelector('#rr-58 .rr-deny')).not.toBeNull();
    expect(d.getElementById('rr-58').textContent).toMatch(/revoked/);
  });

  test('the email link (renew-<id>) outlines and scrolls to that card', async () => {
    const { d, sent } = bootPane({ requests: [pendingReq({ id: 56 }), pendingReq()], held: 'renew-57' });
    await flush(); await flush();
    expect(d.getElementById('rr-57').classList.contains('rr-focus')).toBe(true);
    expect(d.getElementById('rr-56').classList.contains('rr-focus')).toBe(false);
    expect(sent).toContainEqual({ scrolled: 'rr-57' });
  });

  test('a linked request outside the list is fetched by id; junk rests are ignored', async () => {
    let p = bootPane({ requests: [], byId: { 9: pendingReq({ id: 9, status: 'denied', decided_at: '2026-11-01T00:00:00Z' }) }, held: 'renew-9' });
    await flush(); await flush(); await flush();
    expect(p.sent.some(s => s.url === '/api/readonly-keys/renewal-requests?id=9')).toBe(true);
    expect(p.d.getElementById('rr-9').classList.contains('rr-focus')).toBe(true);
    p = bootPane({ requests: [pendingReq()], held: 'renew-57x' });
    await flush(); await flush();
    expect(p.d.querySelector('.rr-focus')).toBeNull();
    expect(p.sent.some(s => /\?id=/.test(s.url || ''))).toBe(false);
  });
});
