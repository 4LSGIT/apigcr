/**
 * Copied public links name the LANDING host, not the staff host.
 *
 * Fred, 2026-11-19: the booking manager's Link / Embed buttons copied
 * "app.4lsg.com/book/…" when the link a client gets is "4lsg.com/b/…". Every
 * staff pane that copies a public link built it on its own location.origin —
 * the staff host. It worked only because the app host 302s the public surface
 * to the landing host (landing_redirect = '1'); the copied text, and every
 * pasted embed, named the wrong host.
 *
 * Fix: GET /api/firm-data carries `publicUrl` (lib/firmConfig publicUrl() =
 * https://<landing_hosts[0]>, else app_url), and the five panes build on
 * window.top.firmData.publicUrl: bookingviewsmanager (/b/ — the short alias),
 * pageManager (/p/), formBuilder + formBuilderSimple (/f/, /p/form),
 * videoManager (/v/, was a hard-coded literal).
 *
 * firmConfig never opens a DB pool under jest (refresh() bails on
 * JEST_WORKER_ID), so cfg() reads the env fallbacks set here.
 */
process.env.JWT_SECRET = 'public-origin-links-test-secret';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const express = require('express');
const jwt = require('jsonwebtoken');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

// Lift a top-level `function name(…) { … }` out of a page by brace matching.
function fnSrc(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`function ${name} unterminated`);
}

// Run the lifted functions in a context whose window.top carries firmData.
function load(file, names, firmData) {
  const src = read(file);
  const win = { location: { origin: 'https://app.4lsg.com' }, top: { firmData } };
  const ctx = { window: win, location: win.location, P: win.top };
  vm.createContext(ctx);
  vm.runInContext(names.map((n) => fnSrc(src, n)).join('\n'), ctx);
  return ctx;
}

const FD = { publicUrl: 'https://4lsg.com' };

describe('GET /api/firm-data publicUrl', () => {
  const saved = {};
  let server;
  beforeAll(async () => {
    for (const k of ['LANDING_HOSTS', 'APP_URL']) saved[k] = process.env[k];
    const app = express();
    app.use((req, _res, next) => {
      req.db = { query: async (sql) => {
        if (/jwt_api_audit_log/.test(sql)) return [{ affectedRows: 1 }];
        if (/SELECT \* FROM users WHERE user = \?/.test(sql)) return [[{ user: 9, user_name: 'U', roles: 'staff' }]];
        return [[]];
      } };
      next();
    });
    app.use(require('../routes/api.firmData'));
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const get = async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const auth = 'Bearer ' + jwt.sign({ sub: 9, username: 'u9', user_type: 1, user_auth: 'authorized', roles: ['staff'], aud: 'staff' },
      process.env.JWT_SECRET, { expiresIn: '5m' });
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/firm-data`, { headers: { authorization: auth } });
    jest.restoreAllMocks();
    return { status: r.status, body: await r.json() };
  };

  test('the first landing host, with scheme', async () => {
    process.env.LANDING_HOSTS = '4lsg.com,www.4lsg.com';
    process.env.APP_URL = 'https://app.4lsg.com';
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body.publicUrl).toBe('https://4lsg.com');
  });

  test('no landing host configured → app_url (links still work)', async () => {
    process.env.LANDING_HOSTS = '';
    process.env.APP_URL = 'https://app.example.test/';
    const r = await get();
    expect(r.body.publicUrl).toBe('https://app.example.test');
  });
});

describe('index.html loadFirmData — the shell carries publicUrl to the panes', () => {
  // The shell copies /api/firm-data field by field; a field the route sends
  // but the loader skips never reaches window.top.firmData (review, 2026-11-19).
  async function runLoader(payload) {
    const win = { firmData: { currentUser: null } };
    const ctx = { window: win, apiSend: async (url, method) => {
      expect([url, method]).toEqual(['/api/firm-data', 'GET']);
      return payload;
    } };
    vm.createContext(ctx);
    vm.runInContext('async ' + fnSrc(read('index.html'), 'loadFirmData'), ctx);   // fnSrc starts at `function`
    await vm.runInContext('loadFirmData()', ctx);
    return win.firmData;
  }
  test('the route field lands on window.firmData.publicUrl', async () => {
    const fd = await runLoader({ currentUser: { user: 6 }, publicUrl: 'https://4lsg.com' });
    expect(fd.publicUrl).toBe('https://4lsg.com');
  });
  test('absent or non-string → \'\' (panes fall back)', async () => {
    expect((await runLoader({ currentUser: { user: 6 } })).publicUrl).toBe('');
    expect((await runLoader({ currentUser: { user: 6 }, publicUrl: { x: 1 } })).publicUrl).toBe('');
  });
  test('end to end: the loaded firmData drives the booking manager link', async () => {
    const fd = await runLoader({ currentUser: { user: 6 }, publicUrl: 'https://4lsg.com' });
    const c = load('bookingviewsmanager.html', ['publicOrigin', 'publicUrl'], fd);
    expect(c.publicUrl({ slug: 'consult' })).toBe('https://4lsg.com/b/consult');
  });
});

describe('bookingviewsmanager.html', () => {
  test('Link and Embed name the landing host and the /b/ alias', () => {
    const c = load('bookingviewsmanager.html', ['publicOrigin', 'publicUrl', 'embedSnippet'], FD);
    expect(c.publicUrl({ slug: 'consult' })).toBe('https://4lsg.com/b/consult');
    expect(c.embedSnippet({ slug: 'consult' })).toBe(
      '<iframe src="https://4lsg.com/b/consult" style="width:100%;height:700px;border:0"></iframe>');
  });

  test('firmData without publicUrl falls back to the page origin', () => {
    const c = load('bookingviewsmanager.html', ['publicOrigin', 'publicUrl'], {});
    expect(c.publicUrl({ slug: 'consult' })).toBe('https://app.4lsg.com/b/consult');
  });

  test('the personal (minted) link is built on the same origin', () => {
    const src = fnSrc(read('bookingviewsmanager.html'), 'mintLink');
    expect(src).toContain('const url = `${publicOrigin()}/b/${viewSlug}?c=${data.token}`;');
  });
});

describe('pageManager.html', () => {
  test('page links name the landing host', () => {
    const c = load('pageManager.html', ['publicOrigin', 'publicUrl'], FD);
    expect(c.publicUrl({ slug: 'intake' })).toBe('https://4lsg.com/p/intake');
  });
});

describe('videoManager.html', () => {
  test('the origin comes from firmData, the literal only as a fallback', () => {
    expect(load('videoManager.html', ['publicVideoOrigin'], { publicUrl: 'https://landing.example.test' })
      .publicVideoOrigin()).toBe('https://landing.example.test');
    expect(load('videoManager.html', ['publicVideoOrigin'], {}).publicVideoOrigin()).toBe('https://4lsg.com');
  });
});

describe('formBuilderSimple.html', () => {
  test('share rows and the go-live dialog use publicOrigin()', () => {
    const src = read('formBuilderSimple.html');
    expect(load('formBuilderSimple.html', ['publicOrigin'], FD).publicOrigin()).toBe('https://4lsg.com');
    expect(fnSrc(src, 'shareRows')).toContain('const origin = publicOrigin();');
    expect(src).toContain("text: publicOrigin() + '/p/form?f=' + ROW.form_key");
  });
});

describe('formBuilder.html', () => {
  test('the share-links block reads firmData.publicUrl', () => {
    expect(read('formBuilder.html')).toContain('const origin = (P.firmData && P.firmData.publicUrl) || location.origin;');
  });
});

describe('no pane builds a public link on its own origin', () => {
  // A link built directly on location.origin (`${location.origin}/x`,
  // location.origin + '/x') is the bug; the origin may appear only as a fallback.
  // One staff-host link is RIGHT: formBuilder's live preview, /forms/liveHost.html,
  // which needs the staff JWT and so must stay on the app host.
  const BAD = /location\.origin\s*\}\/|location\.origin\s*\+\s*['"`]\/(?!forms\/liveHost\.html)/g;
  test.each(['bookingviewsmanager.html', 'pageManager.html', 'formBuilder.html',
    'formBuilderSimple.html', 'videoManager.html'])('%s', (f) => {
    expect(read(f).match(BAD)).toBeNull();
  });
});
