/**
 * Redirect after booking (Fred, 2026-11-19).
 *
 * A booking view may carry booking_views.redirect_url (https only). On success
 * the widget ALWAYS shows thankyou_html first — fail-safe — then:
 *   - embedded: posts { type:'yc-booking', event:'booked', slug, redirect_url }
 *     to its parent and tries to move the top window (a cross-origin frame may
 *     do that only with a recent click, so it can be blocked);
 *   - full page: waits a beat, then goes.
 * The Booking Manager's "Embed help" popup hands out the host-page listener
 * that performs the redirect on the message (the guaranteed path on another
 * site, e.g. a landing page on Cloudflare), and a short brief for an AI
 * assistant that builds the same thing.
 *
 * Covered here: the route's validation and storage (routes/api.bookingViews.js,
 * same in-memory harness as unifiedEventsU5.booking), the ONE success shape
 * real and fake share (routes/booking.js successBody), the widget's
 * afterBooked (public/book.html, lifted and run in a vm), and the manager's
 * snippet + brief + client validation (public/bookingviewsmanager.html).
 * The column itself: tests/bookingRedirectColumn.mysql.test.js (real engine).
 */
process.env.CREDENTIALS_ENCRYPTION_KEY = process.env.CREDENTIALS_ENCRYPTION_KEY || 'x'.repeat(64);

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const express = require('express');
const calendarTypeService = require('../services/calendarTypeService');
const SEED = require('./fixtures/calendar_item_types.seed.json');

jest.mock('../lib/auth.jwtOrApiKey', () => (req, res, next) => next());

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

// Lift `function name(…) { … }` by brace matching (string/regex-naive: the
// lifted functions here hold no unbalanced braces in literals).
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

// ── routes/api.bookingViews.js ─────────────────────────────────────────────
function makeDb() {
  const rows = new Map();
  let nextId = 100;
  return {
    rows,
    query: async (sql, params = []) => {
      const flat = String(sql).replace(/\s+/g, ' ').trim();
      if (/^SELECT user FROM users/i.test(flat)) return [(params[0] || []).map((u) => ({ user: u }))];
      if (/^SELECT id FROM hooks/i.test(flat)) return [[]];
      if (/^SELECT \* FROM booking_views WHERE id/i.test(flat)) {
        const r = rows.get(Number(params[0])); return [r ? [r] : []];
      }
      if (/^INSERT INTO booking_views/i.test(flat)) {
        const cols = flat.slice(flat.indexOf('(') + 1, flat.indexOf(')')).split(',').map((c) => c.trim());
        const row = { id: ++nextId };
        cols.forEach((c, i) => { row[c] = params[i]; });
        rows.set(row.id, row);
        return [{ insertId: row.id, affectedRows: 1 }];
      }
      if (/^UPDATE booking_views SET/i.test(flat)) {
        const id = Number(params[params.length - 1]);
        const cols = flat.slice(flat.indexOf('SET') + 3, flat.indexOf('WHERE')).split(',').map((s) => s.split('=')[0].trim());
        const row = rows.get(id);
        cols.forEach((c, i) => { row[c] = params[i]; });
        return [{ affectedRows: 1 }];
      }
      throw new Error('unscripted query: ' + flat);
    },
  };
}

describe('routes/api.bookingViews.js — redirect_url', () => {
  let server, base, db;
  beforeAll((done) => {
    calendarTypeService._primeCache(SEED);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.db = db; next(); });
    app.use(require('../routes/api.bookingViews'));
    server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
  });
  afterAll((done) => { calendarTypeService.invalidate(); server.closeAllConnections(); server.close(done); });
  beforeEach(() => { db = makeDb(); jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => jest.restoreAllMocks());

  const VIEW = { slug: 'consult', title: 'C', provider_mode: 'fixed_one', provider_ids: [1],
    appt_type: 'Consultation', appt_length: 30, type_key: 'consultation' };
  const send = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };

  test('an https URL is stored (trimmed)', async () => {
    const r = await send('POST', '/api/booking-views', { ...VIEW, redirect_url: '  https://landing.example.com/thank-you.html ' });
    expect(r.status).toBe(200);
    expect(db.rows.get(r.body.id).redirect_url).toBe('https://landing.example.com/thank-you.html');
  });

  test('absent, empty or blank → NULL (no redirect, today\'s behaviour)', async () => {
    for (const redirect_url of [undefined, null, '', '   ']) {
      const r = await send('POST', '/api/booking-views', { ...VIEW, slug: 's' + db.rows.size, redirect_url });
      expect([redirect_url, r.status, db.rows.get(r.body.id).redirect_url]).toEqual([redirect_url, 200, null]);
    }
  });

  test('anything but an absolute https URL is a 400 naming the field', async () => {
    for (const bad of ['http://landing.example.com/t', 'javascript:alert(1)', '/thank-you.html',
      'landing.example.com/t', 'https://', 'data:text/html,x', 'ftp://x.example.com/']) {
      const r = await send('POST', '/api/booking-views', { ...VIEW, redirect_url: bad });
      expect([bad, r.status]).toEqual([bad, 400]);
      expect(r.body.message).toMatch(/redirect_url must be an https:\/\/ URL/);
    }
    expect(db.rows.size).toBe(0);
  });

  test('past 500 characters is refused, never truncated into a broken URL', async () => {
    const ok = 'https://example.com/' + 'a'.repeat(480);
    const r1 = await send('POST', '/api/booking-views', { ...VIEW, redirect_url: ok });
    expect(db.rows.get(r1.body.id).redirect_url).toBe(ok);
    const r2 = await send('POST', '/api/booking-views', { ...VIEW, slug: 'x2', redirect_url: ok + 'b' });
    expect(r2.status).toBe(400);
    expect(r2.body.message).toMatch(/longer than 500/);
  });

  test('PATCH sets and clears it', async () => {
    const { body: { id } } = await send('POST', '/api/booking-views', VIEW);
    await send('PATCH', `/api/booking-views/${id}`, { redirect_url: 'https://a.example.com/x' });
    expect(db.rows.get(id).redirect_url).toBe('https://a.example.com/x');
    await send('PATCH', `/api/booking-views/${id}`, { redirect_url: '' });
    expect(db.rows.get(id).redirect_url).toBeNull();
  });
});

// ── routes/booking.js successBody ──────────────────────────────────────────
describe('routes/booking.js — the one success shape', () => {
  const { successBody } = require('../routes/booking')._test;

  test('carries a stored https redirect', () => {
    expect(successBody({ thankyou_html: '<p>x</p>', redirect_url: 'https://landing.example.com/thank-you.html' }))
      .toEqual({ success: true, thankyou_html: '<p>x</p>', redirect_url: 'https://landing.example.com/thank-you.html' });
  });

  test('a hand-edited non-https value never reaches the widget', () => {
    for (const bad of ['http://x.example.com/', 'javascript:alert(1)', 'not a url', '', null, undefined]) {
      expect([bad, successBody({ redirect_url: bad }).redirect_url]).toEqual([bad, null]);
    }
  });

  test('the default thank-you still applies', () => {
    expect(successBody({}).thankyou_html).toMatch(/booked/i);
  });

  test('the real booking and the bot-facing fake success answer through it alike', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'booking.js'), 'utf8');
    expect(fnSrc(src, 'fakeSuccess')).toContain('res.json(successBody(view))');
    expect(src).toContain('return res.json(successBody(view));');
    // no second thank-you response literal that could drift from it
    expect(src.match(/thankyou_html: view\.thankyou_html \|\| DEFAULT_THANKYOU_HTML/g)).toHaveLength(1);
  });
});

// ── public/book.html afterBooked ───────────────────────────────────────────
describe('public/book.html — afterBooked', () => {
  const SRC = read('book.html');

  function run(url, { framed, topThrows = false, navThrows = false } = {}) {
    const posted = [];
    const timers = [];
    const self = {};
    const top = framed ? {} : self;
    const topLoc = {};
    if (navThrows) Object.defineProperty(topLoc, 'href', { set() { throw new Error('SecurityError'); } });
    top.location = topLoc;
    const win = {
      self,
      parent: { postMessage: (msg, origin) => posted.push([msg, origin]) },
      location: { assign: (u) => { win.assigned = u; } },
    };
    if (topThrows) Object.defineProperty(win, 'top', { get() { throw new Error('blocked'); } });
    else win.top = top;
    if (!framed) self.location = win.location;
    const ctx = { window: win, slug: 'consult', REDIRECT_BEAT_MS: 1500, setTimeout: (fn, ms) => timers.push([fn, ms]) };
    vm.createContext(ctx);
    vm.runInContext(fnSrc(SRC, 'afterBooked'), ctx);
    ctx.afterBooked(url);
    return { posted, timers, win, topLoc };
  }

  test('embedded: tells the host page, then moves the top window', () => {
    const r = run('https://landing.example.com/thank-you.html', { framed: true });
    expect(r.posted).toEqual([[{ type: 'yc-booking', event: 'booked', slug: 'consult',
      redirect_url: 'https://landing.example.com/thank-you.html' }, '*']]);
    expect(r.topLoc.href).toBe('https://landing.example.com/thank-you.html');
    expect(r.timers).toEqual([]);   // no delay: the click's activation must still be live
  });

  test('embedded, browser blocks the top navigation: nothing escapes, the message still went', () => {
    const r = run('https://landing.example.com/t', { framed: true, navThrows: true });
    expect(r.posted).toHaveLength(1);
  });

  test('embedded with no redirect: the host page still hears booked (redirect_url null); no navigation', () => {
    const r = run(null, { framed: true });
    expect(r.posted[0][0]).toEqual({ type: 'yc-booking', event: 'booked', slug: 'consult', redirect_url: null });
    expect(r.topLoc.href).toBeUndefined();
  });

  test('non-https targets are dropped on the client too', () => {
    for (const bad of ['javascript:alert(1)', 'http://x.example.com/', 42, {}]) {
      const r = run(bad, { framed: true });
      expect([bad, r.posted[0][0].redirect_url, r.topLoc.href]).toEqual([bad, null, undefined]);
    }
  });

  test('an unreadable window.top counts as embedded', () => {
    const r = run('https://landing.example.com/t', { framed: true, topThrows: true });
    expect(r.posted).toHaveLength(1);
  });

  test('full page: the thank-you shows for a beat, then the visitor goes', () => {
    const r = run('https://landing.example.com/thank-you.html', { framed: false });
    expect(r.posted).toEqual([]);
    expect(r.timers.map(([, ms]) => ms)).toEqual([1500]);
    expect(r.win.assigned).toBeUndefined();
    r.timers[0][0]();
    expect(r.win.assigned).toBe('https://landing.example.com/thank-you.html');
  });

  test('full page with no redirect: nothing happens (today\'s behaviour)', () => {
    const r = run(null, { framed: false });
    expect([r.posted, r.timers]).toEqual([[], []]);
  });

  test('the page never sends its own URL (and a ?c= token) as a Referer', () => {
    // review 2026-11-19: a same-origin redirect target would otherwise receive
    // the full prefill URL under the default strict-origin-when-cross-origin.
    const head = SRC.slice(0, SRC.indexOf('</head>'));
    expect(head.match(/<meta name="referrer" content="strict-origin">/g)).toHaveLength(1);
    expect(head).not.toMatch(/name="referrer" content="(?!strict-origin")/);
  });

  test('success shows the thank-you BEFORE redirecting', () => {
    const body = fnSrc(SRC, 'handleBookResponse');
    const shown = body.indexOf("show('thankyou')");
    const after = body.indexOf('afterBooked(r.body.redirect_url)');
    expect(shown).toBeGreaterThan(-1);
    expect(after).toBeGreaterThan(shown);
  });
});

// ── public/bookingviewsmanager.html ────────────────────────────────────────
describe('bookingviewsmanager.html — Embed help + the redirect field', () => {
  const SRC = read('bookingviewsmanager.html');
  const ORIGIN = 'https://4lsg.com';
  const ctx = (() => {
    const win = { location: { origin: 'https://app.4lsg.com' }, top: { firmData: { publicUrl: ORIGIN } } };
    const c = { window: win };
    vm.createContext(c);
    vm.runInContext(['publicOrigin', 'publicUrl', 'embedSnippet', 'embedListenerScript', 'embedHelpSnippet',
      'embedLlmBlurb', 'clientValidate'].map((n) => fnSrc(SRC, n)).join('\n'), c);
    return c;
  })();
  const VIEW = { id: 1, slug: 'consult', title: 'Free Consultation' };

  // Run the pasted listener in a stand-in host page and dispatch messages at it.
  function hostPage() {
    const listeners = [];
    const page = { location: { href: 'https://landing.example.com/' },
      addEventListener: (t, fn) => { if (t === 'message') listeners.push(fn); } };
    const code = ctx.embedListenerScript().replace(/^<script>/, '').replace(/<\/script>$/, '');
    const c = { window: page };
    vm.createContext(c);
    vm.runInContext(code, c);
    return { page, fire: (e) => listeners.forEach((fn) => fn(e)), count: () => listeners.length };
  }
  const booked = (over = {}) => ({ origin: ORIGIN,
    data: { type: 'yc-booking', event: 'booked', slug: 'consult', redirect_url: 'https://landing.example.com/thank-you.html', ...over } });

  test('the snippet is the iframe on the landing host plus a real closing script tag', () => {
    const s = ctx.embedHelpSnippet(VIEW);
    expect(s.startsWith('<!-- 4LSG booking: consult -->\n<iframe src="https://4lsg.com/b/consult"')).toBe(true);
    expect(s.trimEnd().endsWith('</script>')).toBe(true);
    expect(s.match(/<script>/g)).toHaveLength(1);
  });

  test('the listener redirects on a booked message from the landing origin', () => {
    const h = hostPage();
    expect(h.count()).toBe(1);
    h.fire(booked());
    expect(h.page.location.href).toBe('https://landing.example.com/thank-you.html');
  });

  test('…and ignores everything else', () => {
    for (const [why, e] of [
      ['other origin', { ...booked(), origin: 'https://evil.example.com' }],
      ['app origin', { ...booked(), origin: 'https://app.4lsg.com' }],
      ['http target', booked({ redirect_url: 'http://landing.example.com/t' })],
      ['javascript target', booked({ redirect_url: 'javascript:alert(1)' })],
      ['no target', booked({ redirect_url: null })],
      ['other type', booked({ type: 'something' })],
      ['other event', booked({ event: 'opened' })],
      ['string data', { origin: ORIGIN, data: 'booked' }],
      ['no data', { origin: ORIGIN, data: null }],
    ]) {
      const h = hostPage();
      h.fire(e);
      expect([why, h.page.location.href]).toEqual([why, 'https://landing.example.com/']);
    }
  });

  test('the AI brief names the iframe, the origin rule, the https rule and the plain link', () => {
    const b = ctx.embedLlmBlurb(VIEW);
    expect(b).toContain('"Free Consultation"');
    expect(b).toContain('<iframe src="https://4lsg.com/b/consult"');
    expect(b).toContain('event.origin is not exactly https://4lsg.com');
    expect(b).toContain('event.data.type === "yc-booking"');
    expect(b).toContain('starting with https://');
    expect(b).toContain('do not add a sandbox attribute');
    expect(b).toContain('use https://4lsg.com/b/consult');
  });

  test('client validation mirrors the server: https only', () => {
    const p = { slug: 'consult', title: 'C', type_key: 'consultation', appt_type: 'C', appt_length: 30,
      granularity_min: 15, horizon_days: 30, page_windows: null, provider_mode: 'fixed_one', provider_ids: [1] };
    expect(ctx.clientValidate({ ...p, redirect_url: null })).toBeNull();
    expect(ctx.clientValidate({ ...p, redirect_url: 'https://landing.example.com/t' })).toBeNull();
    for (const bad of ['http://landing.example.com/t', 'javascript:alert(1)', '/thank-you.html']) {
      expect([bad, ctx.clientValidate({ ...p, redirect_url: bad })]).toEqual([bad, 'Redirect after booking must be an https:// URL.']);
    }
  });

  test('the field is filled from and saved to redirect_url', () => {
    expect(fnSrc(SRC, 'openEditor')).toContain("E('f-redirect').value = v ? (v.redirect_url || '') : '';");
    expect(SRC).toContain("redirect_url:     E('f-redirect').value.trim() || null,");
  });

  test('Embed help sits beside + New View and opens its popup', () => {
    const list = fnSrc(SRC, 'renderList');
    expect(list.indexOf('id="eh-btn"')).toBeGreaterThan(-1);
    expect(list.indexOf('id="eh-btn"')).toBeLessThan(list.indexOf('id="new-btn"'));
    expect(list).toContain("E('eh-btn').addEventListener('click', openEmbedHelp);");
    for (const id of ['eh-backdrop', 'eh-view', 'eh-snippet', 'eh-llm', 'eh-copy-snippet', 'eh-copy-llm', 'eh-close']) {
      expect([id, SRC.includes(`id="${id}"`)]).toEqual([id, true]);
    }
  });
});
