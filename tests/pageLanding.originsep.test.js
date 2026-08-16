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

  test('app host is otherwise untouched — shell, login, root-slug NOT hijacked', async () => {
    expect(await (await appHost('/')).text()).toBe('SHELL');
    expect(await (await appHost('/login')).text()).toBe('LOGIN');
    // root slugs are a LANDING-host feature only
    expect(await (await appHost('/settings')).text()).toBe('SETTINGS_HTML');
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
