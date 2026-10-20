// pages.host binding — services/pageService.js assertHostAllowed.
//
// Independent arc review 2026-10-21, P0 #2: POST/PATCH /api/pages took ANY
// well-shaped hostname, and the host middleware served a pinned page on any
// host carrying a live pin — so any staff login could pin a page to
// app.4lsg.com '/' and replace the shell on the origin that holds every staff
// JWT. The write half of the fix lives here: a non-null host must be a
// registered landing host (landing_hosts, the list the middleware gates on),
// and the app_url host is refused even if it were misregistered there. The
// serve half is locked in tests/pageLanding.originsep.test.js ("pinned pages
// serve ONLY on landing hosts").
//
// Config comes from the real lib/firmConfig (env fallback — firmConfig never
// queries under jest without an injected db). The db fake records SQL so each
// refusal also proves nothing was written.
'use strict';

const firmConfig = require('../lib/firmConfig');
const pageService = require('../services/pageService');

const EXISTING = {
  id: 7, slug: 'promo', host: null, path: null, status: 'live',
  hook_slug: null, thankyou_url: null, meta_title: null, html: '<h1>x</h1>',
};

function fakeDb(existing = EXISTING) {
  const writes = [];
  return {
    writes,
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/^INSERT INTO pages/.test(s)) { writes.push({ sql: s, params }); return [{ insertId: 7 }]; }
      if (/^UPDATE pages SET/.test(s)) { writes.push({ sql: s, params }); return [{ affectedRows: 1 }]; }
      if (/FROM pages WHERE id = \?/.test(s)) return [[{ ...existing, ...(writes.length ? writes[writes.length - 1].params[0] : {}) }]];
      return [[]];
    },
  };
}

const ENV_KEYS = ['LANDING_HOSTS', 'APP_URL'];
const saved = {};
beforeAll(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
afterAll(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  firmConfig._test({ resetCache: true });
});
function setCfg({ landing = '4lsg.com,www.4lsg.com', app = 'https://app.4lsg.com' } = {}) {
  process.env.LANDING_HOSTS = landing;
  process.env.APP_URL = app;
  firmConfig._test({ resetCache: true });
}
beforeEach(() => setCfg());

const create = (db, extra) => pageService.createPage(db, { slug: 'promo', html: '<h1>x</h1>', ...extra });

async function refused(promise, re) {
  let err = null;
  try { await promise; } catch (e) { err = e; }
  expect(err).not.toBeNull();
  expect(err.status).toBe(400);
  if (re) expect(err.message).toMatch(re);
}

describe('create refuses a host outside landing_hosts', () => {
  test.each([
    ['the app host', 'app.4lsg.com', /app host/],
    ['the app host, pasted as a URL', 'https://APP.4lsg.com:443/login', /app host/],
    ['an unregistered vanity domain', 'offers.720debtfree.com', /landing host/],
    ['a subdomain of a landing host', 'evil.4lsg.com', /landing host/],
  ])('%s', async (_label, host, re) => {
    const db = fakeDb();
    await refused(create(db, { host, status: 'live' }), re);
    expect(db.writes).toHaveLength(0);
  });

  test('the app host is refused even when misregistered in landing_hosts', async () => {
    setCfg({ landing: '4lsg.com,app.4lsg.com' });
    const db = fakeDb();
    await refused(create(db, { host: 'app.4lsg.com' }), /app host/);
    expect(db.writes).toHaveLength(0);
  });

  test('app host derives from app_url (not a hardcoded name)', async () => {
    setCfg({ landing: 'staff.example.org', app: 'https://staff.example.org/' });
    const db = fakeDb();
    await refused(create(db, { host: 'staff.example.org' }), /app host/);
    expect(db.writes).toHaveLength(0);
  });

  test('empty landing_hosts (feature off) accepts no host at all', async () => {
    setCfg({ landing: '' });
    const db = fakeDb();
    await refused(create(db, { host: '4lsg.com' }), /no landing hosts/);
    expect(db.writes).toHaveLength(0);
  });
});

describe('create accepts registered landing hosts and host-less pages', () => {
  test.each([
    ['the canonical landing host', '4lsg.com', '4lsg.com'],
    ['a secondary landing host', 'www.4lsg.com', 'www.4lsg.com'],
    ['a landing host pasted as a URL', 'HTTPS://4LSG.com:443/x', '4lsg.com'],
  ])('%s', async (_label, host, stored) => {
    const db = fakeDb();
    await create(db, { host, path: '/ch7' });
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0].params[0].host).toBe(stored);
  });

  test('no host (the /p/<slug> + root-slug case every live row uses)', async () => {
    const db = fakeDb();
    await create(db, {});
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0].params[0].host).toBeNull();
  });

  test('a blank host clears to NULL and is accepted', async () => {
    const db = fakeDb();
    await create(db, { host: '  ' });
    expect(db.writes[0].params[0].host).toBeNull();
  });
});

describe('update applies the same rule', () => {
  test('PATCH host → app host is refused, nothing written', async () => {
    const db = fakeDb();
    await refused(pageService.updatePage(db, 7, { host: 'app.4lsg.com' }), /app host/);
    expect(db.writes).toHaveLength(0);
  });

  test('PATCH host → unregistered host is refused, nothing written', async () => {
    const db = fakeDb();
    await refused(pageService.updatePage(db, 7, { host: 'offers.720debtfree.com' }), /landing host/);
    expect(db.writes).toHaveLength(0);
  });

  test('PATCH host → landing host is accepted', async () => {
    const db = fakeDb();
    await pageService.updatePage(db, 7, { host: '4lsg.com', path: '/promo' });
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0].params[0]).toMatchObject({ host: '4lsg.com', path: '/promo' });
  });

  test('PATCH host → null clears the pin (always allowed)', async () => {
    const db = fakeDb({ ...EXISTING, host: '4lsg.com' });
    await pageService.updatePage(db, 7, { host: null });
    expect(db.writes[0].params[0].host).toBeNull();
  });

  test('a PATCH that does not touch host is not re-judged (create-hook writes hook_slug only)', async () => {
    // An old row whose host has since left landing_hosts is inert at serve
    // time (the middleware only serves pins on landing hosts); editing its
    // other fields must not be blocked by the write rule.
    const db = fakeDb({ ...EXISTING, host: 'old.example.com' });
    await pageService.updatePage(db, 7, { hook_slug: 'lp-promo' });
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0].params[0]).toEqual({ hook_slug: 'lp-promo' });
  });
});
