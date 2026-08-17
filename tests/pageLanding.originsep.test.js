// Origin separation (2026-08-16) — routes/pageLanding.js host router.
//
// Drives a live express app assembled in server.js order (host middleware →
// static stand-ins → /:page catch-all stand-in → req.db → routers). Hosts are
// spoofed via the x-original-host header — undici's fetch forbids setting
// Host directly, and effectiveHost() consults x-original-host FIRST, so this
// exercises the exact production resolution seam.
//
// Locks:
//   - Landing host serves EXACTLY the allowlist; /login, /api/firm-data,
//     the shell, and arbitrary static pages are dead-ended (firm-site 302).
//   - Root-slug pages serve/submit on the landing host; drafts don't.
//   - A page whose HTML contains <script> serves VERBATIM on the landing
//     host — pages stay ungated (Fred's ruling; do not "fix" this).
//   - App host 302s GET /p/*, /f/*, and ext-mode render to the landing host
//     WITH the query string intact; POSTs and internal render do NOT move.
//   - landing_redirect='0' and empty landing_hosts restore pre-slice
//     behavior exactly.
//   - Credentialed landing paths carry X-Robots-Tag noindex; pages don't.
//
// 2026-08-16 follow-up slice (booking + manage on the landing host):
//   - The booking + manage public surface serves on the landing host;
//     POST /api/contacts/:id/booking-link (jwtOrApiKey) still does NOT.
//   - App host 302s GET /book/*, /b/*, /m, /m/* — but NOT their XHR
//     endpoints, and never a POST.
//   - Allowlist BEATS root-slug pages: a live page slugged "m" cannot shadow
//     /m/:token. Bare /book is NOT allowlisted, so a page slugged "book"
//     still serves at 4lsg.com/book.
//   - The whole booking/manage set carries noindex; /api/manage-config
//     deliberately does not.
//   - No response cookie anywhere in the codebase (a Domain=.4lsg.com cookie
//     would bridge the origins this slice separates).
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

const firmConfig = require('../lib/firmConfig');
const pageService = require('../services/pageService');

const FIRM = 'https://firm-site.example';

// ── fake db: pages table only ──────────────────────────────────────────────
const PAGES = {
  mypage: {
    id: 1, slug: 'mypage', host: null, path: null, status: 'live',
    hook_slug: null, thankyou_url: null,
    html: '<h1>MYPAGE</h1><script>window.__x=1<\/script>',
  },
  draftpage: {
    id: 2, slug: 'draftpage', host: null, path: null, status: 'draft',
    hook_slug: null, thankyou_url: null, html: '<h1>DRAFT</h1>',
  },
  // Collision fixtures for the allowlist-vs-root-slug precedence lock.
  m: {
    id: 3, slug: 'm', host: null, path: null, status: 'live',
    hook_slug: null, thankyou_url: null, html: '<h1>PAGE_SLUG_M</h1>',
  },
  book: {
    id: 4, slug: 'book', host: null, path: null, status: 'live',
    hook_slug: null, thankyou_url: null, html: '<h1>PAGE_SLUG_BOOK</h1>',
  },
  v: {
    id: 5, slug: 'v', host: null, path: null, status: 'live',
    hook_slug: null, thankyou_url: null, html: '<h1>PAGE_SLUG_V</h1>',
  },
};

const db = {
  query: jest.fn(async (sql, params) => {
    if (/SELECT DISTINCT host FROM pages/i.test(sql)) return [[]];
    if (/FROM pages\s+WHERE host = \?/i.test(sql)) return [[]];
    if (/FROM pages WHERE slug = \?/i.test(sql)) {
      const row = PAGES[String(params[0])];
      return [row ? [row] : []];
    }
    return [[]];
  }),
};

// ── app assembled in server.js order ───────────────────────────────────────
let server, base;
const pageLanding = require('../routes/pageLanding');

beforeAll((done) => {
  process.env.LANDING_HOSTS = '4lsg.com';
  process.env.LANDING_REDIRECT = '1';
  process.env.FIRM_URL = FIRM;
  firmConfig._test({ resetCache: true });
  pageService.invalidateHostCache();

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(pageLanding.pageHostMiddleware(db));
  // express.static stand-ins for the allowlisted assets
  app.get('/forms/render.html', (req, res) => res.type('html').send('RENDER'));
  app.get('/forms/hooks/:name', (req, res) => res.type('js').send('//hook'));
  app.get('/css/yc-forms.css', (req, res) => res.type('css').send('/*css*/'));
  app.get('/js/yc-forms.js', (req, res) => res.type('js').send('//js'));
  // the server.js single-segment /:page static catch-all stand-in
  app.get('/:page', (req, res, next) => {
    if (req.params.page === 'settings') return res.send('SETTINGS_HTML');
    next();
  });
  app.use((req, res, next) => { req.db = db; next(); });
  app.use(require('../routes/f.js'));
  app.use(pageLanding); // the /p/:slug router half
  app.get('/api/ext/forms/:key', (req, res) => res.json({ probe: 'EXTGET' }));
  app.post('/api/ext/forms/:key/submit', (req, res) => res.json({ probe: 'EXTPOST' }));
  app.get('/r/:slug', (req, res) => res.redirect(302, 'https://target.example/x'));
  // routes/booking.js + routes/manage.js stand-ins. Shapes copied from the
  // real routers (booking.js: '/book/:slug' + the '/b/:slug' alias added
  // 2026-08-16; manage.js: '/m/:token' and the tokenless '/m'). The real
  // handlers pull DB rows and luxon; the host router never reaches them, so
  // probes are enough — what is under test is WHICH host lets them answer.
  app.get(['/book/:slug', '/b/:slug'], (req, res) => res.json({ probe: 'BOOKSHELL', slug: req.params.slug }));
  app.get('/api/book/:slug/config',  (req, res) => res.json({ probe: 'BOOKCONFIG' }));
  app.get('/api/book/:slug/contact', (req, res) => res.json({ probe: 'BOOKCONTACT' }));
  app.get('/api/book/:slug/slots',   (req, res) => res.json({ probe: 'BOOKSLOTS' }));
  app.post('/api/book/:slug',        (req, res) => res.json({ probe: 'BOOKPOST' }));
  app.post('/api/contacts/:id/booking-link', (req, res) => res.json({ probe: 'BOOKINGLINK' }));
  app.get(['/m', '/m/:token'],       (req, res) => res.json({ probe: 'MANAGESHELL' }));
  app.get('/api/manage-config',      (req, res) => res.json({ probe: 'MANAGECONFIG' }));
  app.get('/api/m/:token',           (req, res) => res.json({ probe: 'MGET' }));
  app.get('/api/m/:token/slots',     (req, res) => res.json({ probe: 'MSLOTS' }));
  app.post('/api/m/:token/cancel',       (req, res) => res.json({ probe: 'MCANCEL' }));
  app.post('/api/m/:token/reschedule',   (req, res) => res.json({ probe: 'MRESCHED' }));
  // routes/videoLanding.js + routes/api.videos.js stand-ins (2026-08-17
  // slice). Same convention as the booking/manage probes above: the host
  // router is what's under test, not the handlers.
  app.get('/v/:slug',                   (req, res) => res.type('html').send('VIDEOSHELL'));
  app.post('/api/v/:slug/track',        (req, res) => res.json({ probe: 'VTRACK' }));
  app.post('/api/v/:slug/cta-click',    (req, res) => res.json({ probe: 'VCTA' }));
  app.get('/api/videos',                (req, res) => res.json({ probe: 'VIDEOSAPI' }));
  // routes/taskActions.js + routes/decisionActions.js stand-ins (2026-08-17).
  app.get('/t/:token',                  (req, res) => res.type('html').send('TASKPAGE'));
  app.post('/t/:token/complete',        (req, res) => res.json({ probe: 'TCOMPLETE' }));
  app.post('/t/:token/cancel',          (req, res) => res.json({ probe: 'TCANCEL' }));
  app.get('/t/:token/status.svg',       (req, res) => res.type('image/svg+xml').send('<svg/>'));
  app.get('/d/:token',                  (req, res) => res.type('html').send('DECISIONPAGE'));
  app.get('/d/:token/:value',           (req, res) => res.type('html').send('DECISIONCONFIRM'));
  app.post('/d/:token/respond',         (req, res) => res.json({ probe: 'DRESPOND' }));
  app.post('/api/videos/upload-asset',  (req, res) => res.json({ probe: 'VIDEOUPLOAD' }));
  app.get('/login', (req, res) => res.send('LOGIN'));
  app.get('/api/firm-data', (req, res) => res.json({ probe: 'FIRMDATA' }));
  app.get('/api/form-templates', (req, res) => res.json({ probe: 'TEMPLATES' }));
  app.get('/', (req, res) => res.send('SHELL'));

  server = app.listen(0, () => {
    base = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => {
  delete process.env.LANDING_HOSTS;
  delete process.env.LANDING_REDIRECT;
  firmConfig._test({ resetCache: true });
  if (server.closeAllConnections) server.closeAllConnections();
  server.close(done);
});

const onHost = (host, p, opts = {}) =>
  fetch(base + p, {
    redirect: 'manual',
    ...opts,
    headers: { 'x-original-host': host, ...(opts.headers || {}) },
  });
const landing = (p, opts) => onHost('4lsg.com', p, opts);
const appHost = (p, opts) => onHost('app.4lsg.com', p, opts);

// ── landing host: the allowlist ────────────────────────────────────────────
describe('landing host — allowlist serves', () => {
  test('GET /p/:slug serves the live page', async () => {
    const res = await landing('/p/mypage');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('MYPAGE');
  });

  test('root-slug page serves — 4lsg.com/mypage', async () => {
    const res = await landing('/mypage');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('MYPAGE');
  });

  test('LOCK: authored <script> serves VERBATIM (pages stay ungated)', async () => {
    const res = await landing('/mypage');
    expect(await res.text()).toContain('<script>window.__x=1');
  });

  test('POST to a root-slug page follows the submit contract (always 303)', async () => {
    const res = await landing('/mypage', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'name=x',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/mypage?submitted=1');
  });

  test('draft page does NOT serve at root or /p — dead-page redirect', async () => {
    for (const p of ['/draftpage', '/p/draftpage']) {
      const res = await landing(p);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(FIRM);
    }
  });

  test('GET /f/:key redirects to the renderer, noindex header set', async () => {
    const res = await landing('/f/intake?case_id=AB12CD34');
    expect(res.status).toBe(302);
    expect(res.headers.get('location'))
      .toBe('/forms/render.html?form_key=intake&ext=1&case_id=AB12CD34');
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  test('renderer + hooks + assets serve; renderer carries noindex, css does not', async () => {
    const r = await landing('/forms/render.html?form_key=x&ext=1');
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('RENDER');
    expect(r.headers.get('x-robots-tag')).toBe('noindex, nofollow');

    expect((await landing('/forms/hooks/_yc_hook_util.js')).status).toBe(200);
    const css = await landing('/css/yc-forms.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('x-robots-tag')).toBeNull();
    expect((await landing('/js/yc-forms.js')).status).toBe(200);
  });

  test('/api/ext GET + submit work, noindex set', async () => {
    const g = await landing('/api/ext/forms/intake?case_id=x');
    expect(g.status).toBe(200);
    expect((await g.json()).probe).toBe('EXTGET');
    expect(g.headers.get('x-robots-tag')).toBe('noindex, nofollow');

    const p = await landing('/api/ext/forms/intake/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: {} }),
    });
    expect(p.status).toBe(200);
    expect((await p.json()).probe).toBe('EXTPOST');
  });

  test('/r/:slug short-links serve on the landing host', async () => {
    const res = await landing('/r/promo');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://target.example/x');
  });

  test('pages do NOT carry the noindex header (marketing stays indexable)', async () => {
    const res = await landing('/p/mypage');
    expect(res.headers.get('x-robots-tag')).toBeNull();
  });
});

describe('landing host — everything else is dead', () => {
  test('/login, APIs, and the shell root never answer', async () => {
    for (const p of ['/login', '/api/firm-data', '/api/form-templates']) {
      const res = await landing(p);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(FIRM);
      // and specifically: not the app's payloads
      expect(await res.text()).not.toContain('LOGIN');
    }
    const root = await landing('/');
    expect(root.status).toBe(302);
    expect(root.headers.get('location')).toBe(FIRM);
  });

  test('static shell pages are unreachable — /:page catch-all never fires', async () => {
    const res = await landing('/settings');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(FIRM);
  });

  test('POST to a dead path → 303 firm site; odd method → 405', async () => {
    const p = await landing('/login', { method: 'POST' });
    expect(p.status).toBe(303);
    expect(p.headers.get('location')).toBe(FIRM);
    const d = await landing('/anything', { method: 'DELETE' });
    expect(d.status).toBe(405);
  });
});

// ── app host: redirects ────────────────────────────────────────────────────
describe('app host — migrated GET surface redirects, query intact', () => {
  test('/p/* and /f/* 302 to the landing host with the full query string', async () => {
    const p = await appHost('/p/mypage?a=1&b=two%20words');
    expect(p.status).toBe(302);
    expect(p.headers.get('location')).toBe('https://4lsg.com/p/mypage?a=1&b=two%20words');

    const f = await appHost('/f/intake?case_id=AB12CD34&src=fb');
    expect(f.status).toBe(302);
    expect(f.headers.get('location')).toBe('https://4lsg.com/f/intake?case_id=AB12CD34&src=fb');
  });

  test('ext-mode render redirects; INTERNAL render stays on the app host', async () => {
    const ext = await appHost('/forms/render.html?form_key=x&ext=1');
    expect(ext.status).toBe(302);
    expect(ext.headers.get('location')).toBe('https://4lsg.com/forms/render.html?form_key=x&ext=1');

    const internal = await appHost('/forms/render.html?form_key=x&preview=1');
    expect(internal.status).toBe(200);
    expect(await internal.text()).toBe('RENDER');
  });

  test('POST /p/:slug does NOT redirect — in-flight submits finish where they started', async () => {
    const res = await appHost('/p/mypage', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'name=x',
    });
    expect(res.status).toBe(303); // handled locally by the /p router
    expect(res.headers.get('location')).toBe('/p/mypage?submitted=1');
  });

  test('/book/*, /b/* and /m* 302 to the landing host, query intact', async () => {
    const tok = 'e'.repeat(32);
    const cases = [
      ['/book/consult?c=' + tok, 'https://4lsg.com/book/consult?c=' + tok],
      ['/b/consult',             'https://4lsg.com/b/consult'],
      ['/m/' + tok,              'https://4lsg.com/m/' + tok],
      ['/m',                     'https://4lsg.com/m'],
    ];
    for (const [from, to] of cases) {
      const res = await appHost(from);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(to);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  test('the XHR endpoints do NOT move — they stay on whichever host served the shell', async () => {
    const tok = 'e'.repeat(32);
    for (const [p, probe] of [
      ['/api/book/consult/config', 'BOOKCONFIG'],
      ['/api/book/consult/slots?date=2026-09-01', 'BOOKSLOTS'],
      ['/api/manage-config', 'MANAGECONFIG'],
      ['/api/m/' + tok, 'MGET'],
    ]) {
      const res = await appHost(p);
      expect(res.status).toBe(200);
      expect((await res.json()).probe).toBe(probe);
    }
  });

  test('LOCK: POSTs to the booking/manage paths never redirect (302 drops the body)', async () => {
    const tok = 'e'.repeat(32);
    for (const [p, probe] of [
      ['/api/book/consult', 'BOOKPOST'],
      ['/api/m/' + tok + '/cancel', 'MCANCEL'],
      ['/api/m/' + tok + '/reschedule', 'MRESCHED'],
    ]) {
      const res = await appHost(p, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(200);
      expect((await res.json()).probe).toBe(probe);
    }
  });

  test('app host is otherwise untouched — shell, login, root-slug NOT hijacked', async () => {
    expect(await (await appHost('/')).text()).toBe('SHELL');
    expect(await (await appHost('/login')).text()).toBe('LOGIN');
    // root slugs are a LANDING-host feature only
    expect(await (await appHost('/settings')).text()).toBe('SETTINGS_HTML');
  });
});

// ── booking + manage on the landing host (2026-08-16 follow-up slice) ──────
describe('landing host — booking surface', () => {
  test('GET /book/:slug and the /b alias both serve the widget shell', async () => {
    for (const p of ['/book/consult', '/b/consult']) {
      const res = await landing(p);
      expect(res.status).toBe(200);
      const j = await res.json();
      expect(j.probe).toBe('BOOKSHELL');
      expect(j.slug).toBe('consult');
    }
  });

  test('the three GET /api/book/* endpoints serve', async () => {
    const tok = 'a'.repeat(32);
    const probes = [
      ['/api/book/consult/config', 'BOOKCONFIG'],
      ['/api/book/consult/contact?c=' + tok, 'BOOKCONTACT'],
      ['/api/book/consult/slots?date=2026-09-01', 'BOOKSLOTS'],
    ];
    for (const [p, probe] of probes) {
      const res = await landing(p);
      expect(res.status).toBe(200);
      expect((await res.json()).probe).toBe(probe);
    }
  });

  test('POST /api/book/:slug books — the one POST the booking set allows', async () => {
    const res = await landing('/api/book/consult', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ first: 'A' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).probe).toBe('BOOKPOST');
  });

  test('GET on the booking POST path is NOT allowlisted (method-aware)', async () => {
    const res = await landing('/api/book/consult');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(FIRM);
  });
});

describe('landing host — manage surface', () => {
  const tok = 'b'.repeat(32);

  test('/m/:token, bare /m, /api/manage-config and the /api/m/* GETs serve', async () => {
    const cases = [
      ['/m/' + tok, 'MANAGESHELL'],
      ['/m', 'MANAGESHELL'],
      ['/api/manage-config', 'MANAGECONFIG'],
      ['/api/m/' + tok, 'MGET'],
      ['/api/m/' + tok + '/slots?date=2026-09-01', 'MSLOTS'],
    ];
    for (const [p, probe] of cases) {
      const res = await landing(p);
      expect(res.status).toBe(200);
      expect((await res.json()).probe).toBe(probe);
    }
  });

  test('cancel + reschedule POSTs serve', async () => {
    for (const [action, probe] of [['cancel', 'MCANCEL'], ['reschedule', 'MRESCHED']]) {
      const res = await landing('/api/m/' + tok + '/' + action, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(200);
      expect((await res.json()).probe).toBe(probe);
    }
  });
});

describe('landing host — the internal booking route stays out', () => {
  test('LOCK: POST /api/contacts/:id/booking-link (jwtOrApiKey) is NOT allowlisted', async () => {
    // Lives in routes/booking.js next to the public set but on a different
    // path prefix. A startsWith('/api/book/') allowlist would also exclude it
    // — this test exists so a future "simplify to a prefix" refactor that
    // reaches for '/api/' or '/api/contacts' can't quietly widen the boundary.
    const res = await landing('/api/contacts/42/booking-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(303);            // POST dead-page → firm site
    expect(res.headers.get('location')).toBe(FIRM);
    expect(await res.text()).not.toContain('BOOKINGLINK');
  });

  test('the shells are not reachable by their raw static filenames', async () => {
    // public/book.html and public/manage.html exist; neither is allowlisted,
    // so express.static can never hand them out on the landing host.
    for (const p of ['/book.html', '/manage.html']) {
      const res = await landing(p);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(FIRM);
    }
  });
});

// ── the precedence lock ────────────────────────────────────────────────────
describe('allowlist beats root-slug pages (staff pages cannot shadow repo routes)', () => {
  test('a LIVE page slugged "m" does NOT shadow bare /m or /m/:token', async () => {
    const bare = await landing('/m');
    expect(bare.status).toBe(200);
    expect((await bare.json()).probe).toBe('MANAGESHELL');

    const tokened = await landing('/m/' + 'c'.repeat(32));
    expect((await tokened.json()).probe).toBe('MANAGESHELL');
  });

  test('…and that page is still reachable at its prefix form /p/m', async () => {
    const res = await landing('/p/m');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('PAGE_SLUG_M');
  });

  test('a LIVE page slugged "book" DOES serve at bare /book (not over-allowlisted)', async () => {
    // Only the two-segment /book/:slug is allowlisted, so a marketing page
    // named "book" keeps the pretty root URL and collides with nothing.
    const res = await landing('/book');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('PAGE_SLUG_BOOK');
  });

  test('…while /book/:slug underneath it still reaches the booking router', async () => {
    const res = await landing('/book/consult');
    expect((await res.json()).probe).toBe('BOOKSHELL');
  });
});

// ── robots ─────────────────────────────────────────────────────────────────
describe('noindex covers the whole booking/manage set', () => {
  test('shells and APIs carry X-Robots-Tag', async () => {
    const tok = 'd'.repeat(32);
    const paths = [
      '/book/consult', '/b/consult',
      '/api/book/consult/config', '/api/book/consult/contact?c=' + tok,
      '/api/book/consult/slots?date=2026-09-01',
      '/m', '/m/' + tok, '/api/m/' + tok, '/api/m/' + tok + '/slots',
    ];
    for (const p of paths) {
      const res = await landing(p);
      expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    }
  });

  test('/api/manage-config deliberately does NOT (firm-public, no token)', async () => {
    const res = await landing('/api/manage-config');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-robots-tag')).toBeNull();
  });
});

// ── video landing surface (2026-08-17 slice) ───────────────────────────────
describe('video landing on the landing host', () => {
  test('GET /v/:slug serves the video page', async () => {
    const res = await landing('/v/welcome?c=42');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('VIDEOSHELL');
  });

  test('the two beacon POSTs serve on the landing host', async () => {
    for (const [p, probe] of [
      ['/api/v/welcome/track', 'VTRACK'],
      ['/api/v/welcome/cta-click', 'VCTA'],
    ]) {
      const res = await landing(p, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(200);
      expect((await res.json()).probe).toBe(probe);
    }
  });

  test('LOCK: pageLanding adds no path-level noindex for /v/ — the bare page must stay indexable', async () => {
    // SCOPE, because the previous version of this test was misleading: this
    // suite mounts a STUB /v/:slug, so it can only prove the PATH-level
    // decision — that /v/ is absent from isCredentialedPath, which is
    // path-only by design. Putting /v/ there would noindex the bare marketing
    // URL, which is exactly what we do not want.
    //
    // The QUERY-level decision (?ct= and ?c= are both noindex) is made by the
    // real handler in routes/videoLanding.js and is locked in
    // tests/videoLanding.actionUrl.test.js → 'X-Robots-Tag on /v/:slug'.
    // Asserting it here against a stub would only prove the stub sets no
    // headers — which is how a ?ct= bearer went uncovered in the first place.
    const res = await landing('/v/welcome');
    expect(res.headers.get('x-robots-tag')).toBeNull();
  });

  test('LOCK: the authoring API stays dead on the landing host', async () => {
    const g = await landing('/api/videos');
    expect(g.status).toBe(302);
    expect(g.headers.get('location')).toBe(FIRM);
    const u = await landing('/api/videos/upload-asset', { method: 'POST' });
    expect(u.status).toBe(303);
    expect(u.headers.get('location')).toBe(FIRM);
  });

  test('app host 302s GET /v/* to the landing host, query intact', async () => {
    const res = await appHost('/v/welcome?c=42');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://4lsg.com/v/welcome?c=42');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test('LOCK: the beacon POSTs never meet a 302 — served in place on the app host', async () => {
    const res = await appHost('/api/v/welcome/track', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).probe).toBe('VTRACK');
  });

  test('LOCK: bare /v is NOT allowlisted — a page slugged "v" keeps 4lsg.com/v', async () => {
    const res = await landing('/v');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('PAGE_SLUG_V');
  });

  test('secondary landing host canonicalizes GET /v/* to the apex before serving', async () => {
    const res = await onHost('www.4lsg.com', '/v/welcome?c=42');
    // With www in landing_hosts this would 302 to the apex; with the test's
    // single-host config www is NOT a landing host, so the app-host redirect
    // branch answers — either way the browser lands on 4lsg.com with the
    // query intact, which is the invariant that matters.
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://4lsg.com/v/welcome?c=42');
  });
});

// ── header spoofing cannot widen access ────────────────────────────────────
describe('landing membership is spoof-proof (union rule)', () => {
  test('claiming app.4lsg.com via headers while another candidate names the landing host still gates', async () => {
    // Page JS on the landing origin trying to un-gate itself with a
    // same-origin fetch: x-original-host says app, but x-forwarded-host (or
    // in production the raw Host of the landing mapping) says 4lsg.com.
    const res = await fetch(base + '/login', {
      redirect: 'manual',
      headers: {
        'x-original-host': 'app.4lsg.com',
        'x-forwarded-host': '4lsg.com',
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(FIRM); // gated, not LOGIN
  });

  test('spoofing the landing host FROM the app host only restricts (harmless direction)', async () => {
    const res = await onHost('4lsg.com', '/login'); // x-original-host: 4lsg.com, raw Host 127.0.0.1
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(FIRM);
  });
});

// ── canonical landing host ─────────────────────────────────────────────────
describe('secondary landing hosts canonicalize to landing_hosts[0]', () => {
  const withWww = async (fn) => {
    process.env.LANDING_HOSTS = '4lsg.com,www.4lsg.com';
    try { await fn(); } finally { process.env.LANDING_HOSTS = '4lsg.com'; }
  };

  test('GET on www 302s to the canonical host, path + query intact', async () => {
    await withWww(async () => {
      const root = await onHost('www.4lsg.com', '/');
      expect(root.status).toBe(302);
      expect(root.headers.get('location')).toBe('https://4lsg.com/');

      const f = await onHost('www.4lsg.com', '/f/intake?case_id=AB12CD34&src=fb');
      expect(f.status).toBe(302);
      expect(f.headers.get('location'))
        .toBe('https://4lsg.com/f/intake?case_id=AB12CD34&src=fb');

      const p = await onHost('www.4lsg.com', '/p/mypage?x=1');
      expect(p.status).toBe(302);
      expect(p.headers.get('location')).toBe('https://4lsg.com/p/mypage?x=1');
    });
  });

  test('the canonical host itself never self-redirects', async () => {
    await withWww(async () => {
      const res = await landing('/p/mypage');
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('MYPAGE');
    });
  });

  test('www is still GATED — canonicalization is not a bypass', async () => {
    await withWww(async () => {
      // /login is not allowlisted; on a secondary landing host a GET is
      // canonicalized (and gated again on arrival), never served.
      const res = await onHost('www.4lsg.com', '/login');
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://4lsg.com/login');
      expect(await res.text()).not.toContain('LOGIN');
      // POST is served in place — and still dead-ended, not passed through.
      const post = await onHost('www.4lsg.com', '/login', { method: 'POST' });
      expect(post.status).toBe(303);
      expect(post.headers.get('location')).toBe(FIRM);
    });
  });

  test('POST to an allowlisted path on www is served in place (body preserved)', async () => {
    await withWww(async () => {
      const res = await onHost('www.4lsg.com', '/p/mypage', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'name=x',
      });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/p/mypage?submitted=1');
    });
  });

  test('a host NOT in landing_hosts is unaffected by canonicalization', async () => {
    await withWww(async () => {
      expect(await (await appHost('/login')).text()).toBe('LOGIN');
    });
  });

  test('booking/manage GETs on www canonicalize; their POSTs are served in place', async () => {
    // Interaction lock between this and the 2026-08-16 booking/manage slice:
    // canonicalization (step 0) runs BEFORE the allowlist, so a booking link
    // always ends on one origin. POSTs skip step 0 by design and must still
    // be ALLOWED here, not dead-ended — an in-flight booking or cancel from
    // a page loaded on www has to complete.
    await withWww(async () => {
      const tok = 'a'.repeat(32);
      for (const [from, to] of [
        ['/book/consult', 'https://4lsg.com/book/consult'],
        ['/b/consult',    'https://4lsg.com/b/consult'],
        ['/m/' + tok,     'https://4lsg.com/m/' + tok],
      ]) {
        const res = await onHost('www.4lsg.com', from);
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe(to);
      }

      for (const [p, probe] of [
        ['/api/book/consult', 'BOOKPOST'],
        ['/api/m/' + tok + '/cancel', 'MCANCEL'],
      ]) {
        const res = await onHost('www.4lsg.com', p, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        expect(res.status).toBe(200);
        expect((await res.json()).probe).toBe(probe);
      }
    });
  });
});

// ── kill switches ──────────────────────────────────────────────────────────
describe('rollout switches restore pre-slice behavior', () => {
  test("landing_redirect='0': app host serves /p and /f locally again", async () => {
    process.env.LANDING_REDIRECT = '0';
    try {
      const p = await appHost('/p/mypage');
      expect(p.status).toBe(200);
      expect(await p.text()).toContain('MYPAGE');
      const f = await appHost('/f/intake?case_id=x');
      expect(f.status).toBe(302);
      expect(f.headers.get('location')).toMatch(/^\/forms\/render\.html\?/);
    } finally {
      process.env.LANDING_REDIRECT = '1';
    }
  });

  test("landing_redirect='0': app host serves /book and /m locally again", async () => {
    process.env.LANDING_REDIRECT = '0';
    try {
      const b = await appHost('/book/consult');
      expect(b.status).toBe(200);
      expect((await b.json()).probe).toBe('BOOKSHELL');
      const m = await appHost('/m/' + 'f'.repeat(32));
      expect(m.status).toBe(200);
      expect((await m.json()).probe).toBe('MANAGESHELL');
    } finally {
      process.env.LANDING_REDIRECT = '1';
    }
  });

  test('empty landing_hosts: booking/manage behave exactly as pre-slice on both hosts', async () => {
    process.env.LANDING_HOSTS = '';
    try {
      // 4lsg.com is now just an unknown host — no gate, no redirect, no header.
      const b = await landing('/book/consult');
      expect(b.status).toBe(200);
      expect((await b.json()).probe).toBe('BOOKSHELL');
      expect(b.headers.get('x-robots-tag')).toBeNull();
      const app = await appHost('/m/' + 'f'.repeat(32));
      expect(app.status).toBe(200);
      expect((await app.json()).probe).toBe('MANAGESHELL');
    } finally {
      process.env.LANDING_HOSTS = '4lsg.com';
    }
  });

  test('empty landing_hosts: 4lsg.com traffic falls through like any unknown host', async () => {
    process.env.LANDING_HOSTS = '';
    try {
      const res = await landing('/login');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('LOGIN');
    } finally {
      process.env.LANDING_HOSTS = '4lsg.com';
    }
  });
});

// ── the no-cookie invariant ────────────────────────────────────────────────
describe('no response cookies anywhere (origin-bridge guard)', () => {
  test('codebase sets no cookies; nothing could ever be Domain=.4lsg.com scoped', () => {
    const roots = ['routes', 'lib', 'services'];
    const offenders = [];
    const scan = (file) => {
      const src = fs.readFileSync(file, 'utf8');
      // freelook.js READS set-cookie from an outbound PACER response and
      // forwards it OUT — it never sets one on our own responses.
      const isFreelook = file.endsWith('freelook.js');
      if (/\bres\.cookie\s*\(/.test(src)) offenders.push(`${file}: res.cookie(`);
      if (!isFreelook && /set-cookie/i.test(src)) offenders.push(`${file}: set-cookie`);
      if (/domain\s*[:=]\s*['"`]\.?4lsg\.com/i.test(src)) offenders.push(`${file}: domain-scoped cookie`);
    };
    for (const root of roots) {
      const walk = (dir) => {
        for (const e of fs.readdirSync(path.join(__dirname, '..', dir), { withFileTypes: true })) {
          const rel = path.join(dir, e.name);
          if (e.isDirectory()) walk(rel);
          else if (e.name.endsWith('.js')) scan(path.join(__dirname, '..', rel));
        }
      };
      walk(root);
    }
    scan(path.join(__dirname, '..', 'server.js'));
    expect(offenders).toEqual([]);
  });
});


// ── task + decision action links (2026-08-17 slice) ────────────────────────
describe('task + decision action links on the landing host', () => {
  const TOK = 'abcdefghij1234567890';   // 20 chars, matches {10,40}

  test('GET /t/:token and /d/:token serve', async () => {
    expect(await (await landing(`/t/${TOK}`)).text()).toBe('TASKPAGE');
    expect(await (await landing(`/d/${TOK}`)).text()).toBe('DECISIONPAGE');
  });

  test('GET /d/:token/:value (confirm step) serves', async () => {
    expect(await (await landing(`/d/${TOK}/approve`)).text()).toBe('DECISIONCONFIRM');
  });

  test('GET /t/:token/status.svg serves (email badge)', async () => {
    const res = await landing(`/t/${TOK}/status.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/svg/);
  });

  test('the mutating POSTs serve on the landing host', async () => {
    for (const [p, probe] of [
      [`/t/${TOK}/complete`, 'TCOMPLETE'],
      [`/t/${TOK}/cancel`,   'TCANCEL'],
    ]) {
      const res = await landing(p, { method: 'POST' });
      expect(res.status).toBe(200);
      expect((await res.json()).probe).toBe(probe);
    }
  });

  test('LOCK: POST /d/:token/respond is allowed — the :value pattern must not shadow it', async () => {
    // '/d/<tok>/respond' also matches D_VALUE_RE, which returns isRead
    // (false for POST). If the POST rule is ever reordered after it, the only
    // mutating decision route dies on the landing host. This is that guard.
    const res = await landing(`/d/${TOK}/respond`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()).probe).toBe('DRESPOND');
  });

  test('LOCK: all /t/ and /d/ paths are noindex (bearer token in the path)', async () => {
    const paths = [
      `/t/${TOK}`, `/t/${TOK}/status.svg`,
      `/d/${TOK}`, `/d/${TOK}/approve`,
    ];
    for (const p of paths) {
      expect((await landing(p)).headers.get('x-robots-tag')).toBe('noindex, nofollow');
    }
  });

  test('app host 302s the HTML entry points to the landing host', async () => {
    for (const p of [`/t/${TOK}`, `/d/${TOK}`, `/d/${TOK}/approve`]) {
      const res = await appHost(p);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://4lsg.com' + p);
    }
  });

  test('LOCK: status.svg is NOT redirected — already embedded in sent emails', async () => {
    const res = await appHost(`/t/${TOK}/status.svg`);
    expect(res.status).toBe(200);
  });

  test('LOCK: the mutating POSTs never meet a 302 on the app host', async () => {
    for (const [p, probe] of [
      [`/t/${TOK}/complete`, 'TCOMPLETE'],
      [`/d/${TOK}/respond`,  'DRESPOND'],
    ]) {
      const res = await appHost(p, { method: 'POST' });
      expect(res.status).toBe(200);
      expect((await res.json()).probe).toBe(probe);
    }
  });

  test('a too-short token is not allowlisted (pattern is not a prefix match)', async () => {
    const res = await landing('/t/short');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(FIRM);
  });
});
