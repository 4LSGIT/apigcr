// tests/portalBranding.test.js
//
// S5 — the PUBLIC branding endpoint (routes/portal.branding.js):
//   • FIXED-SET INVARIANT — the handler serves the three hardcoded fe- keys
//     and NOTHING request-derived can reach the query: a request stuffed
//     with key names in query/params/body/headers still binds EXACTLY the
//     constant key set, and the response carries exactly the three fields.
//   • Missing rows → nulls, 200. Empty / JSON-quoted / non-scalar values
//     normalize per the api.firmData.js convention.
//   • DB error → fail-soft 200 with nulls (never a broken login page).
//   • Cache-Control: public, max-age=300.
//   • Per-IP limiter → 429 past 60/min.
//
// Stub pattern from tests/portalCardEngine.test.js (scripted mysql2 pool).
//
// Run:
//   npx jest tests/portalBranding.test.js

'use strict';

const branding = require('../routes/portal.branding');

const EXPECTED_KEYS = ['fe-firm_logo_url', 'fe-firm_site_url', 'fe-firm_phone'];

// Plain pool stub: query() shifts the next scripted [rows] result.
function stubDb(script) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params: params || [] });
      if (!script.length) throw new Error('stubDb: unscripted query: ' + sql);
      const next = script.shift();
      if (next instanceof Error) throw next;
      return [next];
    },
  };
}

function settingRows(map) {
  return Object.entries(map).map(([key, value]) => ({ key, value }));
}

// Minimal express-ish req/res for calling the exported handler directly.
// Distinct XFF per test — the limiter is module-scoped per-IP state.
let _ipSeq = 0;
function fakeReq(db, over = {}) {
  return Object.assign({
    db,
    headers: { 'x-forwarded-for': '10.9.9.' + (++_ipSeq) },
    query: {}, params: {}, body: {},
  }, over);
}
function fakeRes() {
  const res = {
    statusCode: 200, headers: {}, body: null,
    set(k, v) { res.headers[k] = v; return res; },
    status(c) { res.statusCode = c; return res; },
    json(b) { res.body = b; return res; },
  };
  return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// getBranding — data mapping
// ─────────────────────────────────────────────────────────────────────────────

describe('getBranding', () => {
  test('queries EXACTLY the constant key set (signature has no key input at all)', async () => {
    const db = stubDb([settingRows({
      'fe-firm_logo_url': 'https://iili.io/x.png',
      'fe-firm_site_url': 'https://legalsolutions.group',
      'fe-firm_phone': '2484179800',
    })]);
    const out = await branding._getBranding(db);
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].params.sort()).toEqual([...EXPECTED_KEYS].sort());
    expect(out).toEqual({
      logo_url: 'https://iili.io/x.png',
      site_url: 'https://legalsolutions.group',
      phone: '2484179800',
    });
    // The exported constant is the whole surface — three fields, frozen.
    expect(Object.isFrozen(branding._BRANDING_KEYS)).toBe(true);
    expect(Object.values(branding._BRANDING_KEYS).sort()).toEqual([...EXPECTED_KEYS].sort());
  });

  test('missing rows → nulls; partial rows → partial nulls', async () => {
    expect(await branding._getBranding(stubDb([[]])))
      .toEqual({ logo_url: null, site_url: null, phone: null });
    expect(await branding._getBranding(stubDb([settingRows({
      'fe-firm_logo_url': 'https://iili.io/x.png',
    })]))).toEqual({ logo_url: 'https://iili.io/x.png', site_url: null, phone: null });
  });

  test('value normalization — firmData convention: JSON-parse w/ raw fallback, trim, scalars only', async () => {
    const out = await branding._getBranding(stubDb([settingRows({
      'fe-firm_logo_url': '"https://iili.io/quoted.png"',   // JSON-quoted string → unwrapped
      'fe-firm_site_url': '   ',                            // whitespace → null
      'fe-firm_phone': 2484179800,                          // number (JSON column-ish) → string
    })]));
    expect(out).toEqual({
      logo_url: 'https://iili.io/quoted.png',
      site_url: null,
      phone: '2484179800',
    });
    // Non-scalar JSON is not a branding value.
    const out2 = await branding._getBranding(stubDb([settingRows({
      'fe-firm_logo_url': '{"nested":"object"}',
      'fe-firm_site_url': '[1,2]',
    })]));
    expect(out2.logo_url).toBeNull();
    expect(out2.site_url).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Handler — fixed set vs request input, envelope, cache, fail-soft, limiter
// ─────────────────────────────────────────────────────────────────────────────

describe('brandingHandler', () => {
  test('request-supplied key names in EVERY slot are ignored — SQL still binds the constant set', async () => {
    const db = stubDb([[]]);
    const req = fakeReq(db, {
      query:  { key: 'jwt_secret', name: 'portal_sms_counter', keys: 'zoho_refresh_token' },
      params: { key: 'esign_test_mode' },
      body:   { key: 'portal_email_from', sql: 'anything' },
    });
    req.headers['x-branding-key'] = 'credentials_encryption_key';
    const res = fakeRes();
    await branding._brandingHandler(req, res);

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].params.sort()).toEqual([...EXPECTED_KEYS].sort());
    for (const p of db.calls[0].params) {
      expect(String(p).startsWith('fe-firm_')).toBe(true);
    }
    // Response projection: envelope + exactly the three branding fields.
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['logo_url', 'phone', 'site_url', 'status']);
    expect(res.body).toEqual({ status: 'success', logo_url: null, site_url: null, phone: null });
  });

  test('Cache-Control: public, max-age=300', async () => {
    const res = fakeRes();
    await branding._brandingHandler(fakeReq(stubDb([[]])), res);
    expect(res.headers['Cache-Control']).toBe('public, max-age=300');
  });

  test('DB error → fail-soft 200 with nulls (branding must never break login)', async () => {
    const res = fakeRes();
    await branding._brandingHandler(fakeReq(stubDb([new Error('boom')])), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ status: 'success', logo_url: null, site_url: null, phone: null });
  });

  test('per-IP limiter: 61st call within the window → 429', async () => {
    const ipHeaders = { 'x-forwarded-for': '10.8.8.8' };
    for (let i = 0; i < 60; i++) {
      const res = fakeRes();
      await branding._brandingHandler(fakeReq(stubDb([[]]), { headers: { ...ipHeaders } }), res);
      expect(res.statusCode).toBe(200);
    }
    const res61 = fakeRes();
    const db61 = stubDb([[]]);
    await branding._brandingHandler(fakeReq(db61, { headers: { ...ipHeaders } }), res61);
    expect(res61.statusCode).toBe(429);
    expect(db61.calls).toHaveLength(0);          // limited BEFORE the read
    // A different IP is unaffected.
    const resOther = fakeRes();
    await branding._brandingHandler(fakeReq(stubDb([[]])), resOther);
    expect(resOther.statusCode).toBe(200);
  });
});
