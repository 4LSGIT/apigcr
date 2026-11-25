/**
 * Redirect after booking (Fred, 2026-11-19).
 *
 * On success the widget ALWAYS shows thankyou_html first — fail-safe — then:
 *   - embedded: only posts { type:'yc-booking', event:'booked', slug,
 *     redirect_url } to its host; the host's embed code (Booking Manager →
 *     Embed help) goes to its own THANK_YOU, else the view's https
 *     redirect_url. The script trusts only its own iframe and names no domain.
 *   - full page: after a beat, the view's own redirect_url — never a page
 *     named in the link (?ty= would make a 4lsg.com link an open redirect,
 *     and a came-from rule still passes through t.co; Fred, 2026-11-19).
 * Embed help also hands out the plain link and a brief for an AI assistant.
 *
 * Auto-resize (2026-11-25): framed, the widget also posts { type:'yc-booking',
 * event:'resize', slug, height, step } — the CONTENT's height (the wrapper's
 * bottom in document coordinates, never scrollHeight, which inside an iframe
 * is at least the frame's own height) and the step (1 | 2 | 3 | 'done') — on
 * boot, on every step change and on content size changes (ResizeObserver,
 * one animation frame, under 2 px skipped). The embed script sets the
 * iframe's height (clamped 300–4000, non-finite / ≤ 0 ignored) and, when the
 * step changes (not on the first message) while the frame's top is above the
 * viewport, scrolls it back into view. Same two guards as `booked`. Covered
 * below: the widget's functions in a vm, the host script in a stand-in page
 * (the same checks ditchurdebt.com's script.js v1.1 passes).
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

  // search = the booking page's own query string; referrer = where the visitor came from
  function run(url, { framed, topThrows = false, search = '', referrer = '' } = {}) {
    const posted = [];
    const timers = [];
    const self = {};
    const top = framed ? {} : self;
    const topLoc = {};
    top.location = topLoc;
    const win = {
      self,
      parent: { postMessage: (msg, origin) => posted.push([msg, origin]) },
      location: { assign: (u) => { win.assigned = u; } },
    };
    if (topThrows) Object.defineProperty(win, 'top', { get() { throw new Error('blocked'); } });
    else win.top = top;
    if (!framed) self.location = win.location;
    const ctx = { window: win, document: { referrer }, slug: 'consult', REDIRECT_BEAT_MS: 1500,
      qs: new URLSearchParams(search), URL, setTimeout: (fn, ms) => timers.push([fn, ms]) };
    vm.createContext(ctx);
    vm.runInContext(['afterBooked', 'httpsUrl'].map((n) => fnSrc(SRC, n)).join('\n'), ctx);
    ctx.afterBooked(url);
    return { posted, timers, win, topLoc, go: () => { timers.forEach(([fn]) => fn()); return win.assigned; } };
  }
  const TY = '?ty=' + encodeURIComponent('https://landing.example.com/thank-you.html');

  describe('embedded: the host page decides', () => {
    test('tells the host booked, with the view default; never moves the host page', () => {
      const r = run('https://firm.example.com/default', { framed: true, search: TY, referrer: 'https://landing.example.com/' });
      expect(r.posted).toEqual([[{ type: 'yc-booking', event: 'booked', slug: 'consult',
        redirect_url: 'https://firm.example.com/default' }, '*']]);
      expect(r.topLoc.href).toBeUndefined();
      expect(r.timers).toEqual([]);
    });

    test('no view default → redirect_url null; non-https defaults are dropped', () => {
      for (const v of [null, 'javascript:alert(1)', 'http://x.example.com/', 42]) {
        expect([v, run(v, { framed: true }).posted[0][0].redirect_url]).toEqual([v, null]);
      }
    });

    test('an unreadable window.top counts as embedded', () => {
      const r = run('https://firm.example.com/d', { framed: true, topThrows: true });
      expect(r.posted).toHaveLength(1);
      expect(r.timers).toEqual([]);
    });
  });

  describe('full page: the view\'s own redirect, never a page named in the link', () => {
    test('the view redirect, after the beat', () => {
      const r = run('https://firm.example.com/default', { framed: false });
      expect(r.posted).toEqual([]);
      expect(r.timers.map(([, ms]) => ms)).toEqual([1500]);
      expect(r.win.assigned).toBeUndefined();
      expect(r.go()).toBe('https://firm.example.com/default');
    });

    test('a ?ty= in the link is ignored — even from the same site (open redirect; t.co passes any referrer rule)', () => {
      for (const referrer of ['', 'https://landing.example.com/', 'https://t.co/']) {
        expect([referrer, run('https://firm.example.com/default', { framed: false, search: TY, referrer }).go()])
          .toEqual([referrer, 'https://firm.example.com/default']);
        expect([referrer, run(null, { framed: false, search: TY, referrer }).timers]).toEqual([referrer, []]);
      }
    });

    test('no view redirect, or a non-https one → stay on the thank-you', () => {
      for (const v of [null, '', 'http://firm.example.com/d', 'javascript:alert(1)']) {
        expect([v, run(v, { framed: false }).timers]).toEqual([v, []]);
      }
    });
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

  test('qs is the page\'s own query string', () => {
    expect(SRC).toContain('var qs = new URLSearchParams(location.search);');
  });
});

// ── public/book.html — resize ──────────────────────────────────────────────
describe('public/book.html — the resize message', () => {
  const SRC = read('book.html');

  // The widget's resize functions in a stand-in page: `.wrap` sits at
  // wrapBottom in the viewport, the page scrolled by scrollY; the thank-you
  // hidden unless said; requestAnimationFrame callbacks collected for the test
  // to run.
  function page({ framed = true, wrapBottom = 679.2, scrollY = 0, thankyou = false, step = 1 } = {}) {
    const posted = [];
    const frames = [];
    const win = { parent: { postMessage: (m, o) => posted.push([m, o]) }, scrollY, addEventListener: () => {} };
    // top level: parent IS the window — and it can receive a message, so a
    // post the guard should have stopped is recorded, not swallowed
    if (!framed) { win.parent = win; win.postMessage = (m, o) => posted.push([m, o]); }
    const wrap = { getBoundingClientRect: () => ({ bottom: wrapBottom }) };
    const ctx = {
      window: win, slug: 'consult', step, framed: undefined, lastPostedHeight: -1, resizeRaf: null, resizeForce: false,
      document: { querySelector: (s) => (s === '.wrap' ? wrap : null) },
      E: (id) => (id === 'thankyou' ? { classList: { contains: (c) => c === 'hidden' && !ctx.thankyouShown } } : null),
      thankyouShown: thankyou,
      requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
      Math,
    };
    vm.createContext(ctx);
    vm.runInContext(['contentHeight', 'currentStep', 'postResize', 'scheduleResize'].map((n) => fnSrc(SRC, n)).join('\n'), ctx);
    // the module-level detection, lifted verbatim
    const detect = SRC.match(/var framed = false;\n\s*try \{ framed = window\.parent !== window; \} catch \(e\) \{ framed = true; \}/);
    expect(detect).not.toBeNull();
    vm.runInContext(detect[0], ctx);
    const tick = () => { const fns = frames.splice(0); fns.forEach((fn) => fn()); return fns.length; };
    return { ctx, posted, frames, tick, wrap, win };
  }

  test('posts the content height (the wrapper\'s bottom + scrollY, rounded up) and the step, to any origin', () => {
    const p = page({ wrapBottom: 679.2, scrollY: 0 });
    p.ctx.postResize(true);
    expect(p.posted).toEqual([[{ type: 'yc-booking', event: 'resize', slug: 'consult', height: 680, step: 1 }, '*']]);
    const q = page({ wrapBottom: 400.5, scrollY: 300, step: 2 });
    q.ctx.postResize(true);
    expect(q.posted[0][0]).toMatchObject({ height: 701, step: 2 });
  });

  test('the height is the CONTENT\'s, never documentElement.scrollHeight', () => {
    expect(fnSrc(SRC, 'contentHeight')).not.toMatch(/scrollHeight|offsetHeight|innerHeight/);
    expect(fnSrc(SRC, 'contentHeight')).toContain("document.querySelector('.wrap')");
  });

  test("step is 'done' once the thank-you is on screen", () => {
    const p = page({ thankyou: true, step: 3 });
    p.ctx.postResize(true);
    expect(p.posted[0][0].step).toBe('done');
  });

  test('not framed: never posts, never schedules a frame', () => {
    const p = page({ framed: false });
    expect(p.ctx.framed).toBe(false);
    p.ctx.postResize(true);
    p.ctx.scheduleResize(true);
    expect(p.posted).toEqual([]);
    expect(p.frames).toEqual([]);
  });

  test('a change under 2 px is skipped; a forced post (a step change) goes through at the same height', () => {
    const p = page({ wrapBottom: 680 });
    p.ctx.postResize(false);
    expect(p.posted).toHaveLength(1);
    p.wrap.getBoundingClientRect = () => ({ bottom: 681 });
    p.ctx.postResize(false);
    expect(p.posted).toHaveLength(1);           // 1 px: skipped
    p.wrap.getBoundingClientRect = () => ({ bottom: 682 });
    p.ctx.postResize(false);
    expect(p.posted).toHaveLength(2);           // 2 px: posted
    p.ctx.step = 2;
    p.ctx.postResize(true);
    expect(p.posted).toHaveLength(3);           // forced: same height, new step
    expect(p.posted[2][0]).toMatchObject({ height: 682, step: 2 });
  });

  test('a zero or missing wrapper height posts nothing', () => {
    const p = page({ wrapBottom: 0 });
    p.ctx.postResize(true);
    expect(p.posted).toEqual([]);
    const q = page();
    q.ctx.document.querySelector = () => null;
    q.ctx.postResize(true);
    expect(q.posted).toEqual([]);
  });

  test('scheduleResize coalesces on one animation frame and keeps a force once asked', () => {
    const p = page({ wrapBottom: 680 });
    p.ctx.postResize(false);                    // height 680 already posted
    p.ctx.scheduleResize(false);
    p.ctx.scheduleResize(true);
    p.ctx.scheduleResize(false);
    expect(p.frames).toHaveLength(1);           // one frame for three requests
    expect(p.tick()).toBe(1);
    expect(p.posted).toHaveLength(2);           // the force survived the later unforced request
    p.ctx.scheduleResize(false);
    p.tick();
    expect(p.posted).toHaveLength(2);           // unforced at the same height: skipped
    expect(p.ctx.resizeRaf).toBeNull();
  });

  test('wired at every point the content changes: boot and each step, the thank-you, the unavailable state, a ResizeObserver on the wrapper', () => {
    expect(fnSrc(SRC, 'goStep')).toMatch(/scheduleResize\(true\);\n\s*\}$/);
    expect(fnSrc(SRC, 'showUnavailable')).toContain('scheduleResize(true);');
    const hb = fnSrc(SRC, 'handleBookResponse');
    expect(hb.indexOf('scheduleResize(true);')).toBeGreaterThan(hb.indexOf("show('thankyou')"));
    expect(hb.indexOf('scheduleResize(true);')).toBeLessThan(hb.indexOf('afterBooked(r.body.redirect_url)'));
    const wire = fnSrc(SRC, 'wireResize');
    expect(wire).toContain("new ResizeObserver(function () { scheduleResize(false); }).observe(wrap)");
    expect(wire).toMatch(/^function wireResize\(\) \{\n\s*if \(!framed\) return;/);
    expect(fnSrc(SRC, 'renderShell')).toMatch(/wireResize\(\);[\s\S]*goStep\(1\);/);
    // no forever-running timer anywhere in the widget's resize path
    for (const n of ['contentHeight', 'currentStep', 'postResize', 'scheduleResize', 'wireResize']) {
      expect([n, /setInterval|setTimeout/.test(fnSrc(SRC, n))]).toEqual([n, false]);
    }
  });

  test('the booked message and afterBooked are untouched', () => {
    expect(fnSrc(SRC, 'afterBooked')).toContain("window.parent.postMessage({ type: 'yc-booking', event: 'booked', slug: slug, redirect_url: viewTarget }, '*');");
  });
});

// ── public/bookingviewsmanager.html ────────────────────────────────────────
describe('bookingviewsmanager.html — Embed help + the redirect field', () => {
  const SRC = read('bookingviewsmanager.html');
  const ctx = (() => {
    const win = { location: { origin: 'https://app.4lsg.com' }, top: { firmData: { publicUrl: 'https://4lsg.com' } } };
    const c = { window: win };
    vm.createContext(c);
    vm.runInContext(['publicOrigin', 'publicUrl', 'embedFrameId', 'embedHelpFrame', 'embedListenerScript',
      'embedHelpSnippet', 'embedHelpLink', 'embedLlmBlurb', 'clientValidate'].map((n) => fnSrc(SRC, n)).join('\n'), c);
    return c;
  })();
  const VIEW = { id: 1, slug: 'consult', title: 'Free Consultation' };

  // Run the pasted script in a stand-in host page (on any domain) holding the
  // booking iframe, optionally with THANK_YOU filled in the way a person would.
  function hostPage(thankYou = '') {
    const listeners = [];
    const frameWin = {};
    const page = {
      location: { href: 'https://vanity.example.net/' },
      addEventListener: (t, fn) => { if (t === 'message') listeners.push(fn); },
    };
    const frameSrc = ctx.embedHelpFrame(VIEW).match(/src="([^"]+)"/)[1];
    // the iframe as the host script sees it: its style, where it sits, and
    // scrollIntoView recorded (top = its top edge relative to the viewport)
    const frame = { contentWindow: frameWin, src: frameSrc, style: { height: '700px' }, top: 100, scrolled: [],
      getBoundingClientRect() { return { top: this.top }; }, scrollIntoView(o) { this.scrolled.push(o); } };
    const doc = { getElementById: (id) => (id === 'yc-booking-consult' ? frame : null) };
    let code = ctx.embedListenerScript(VIEW).replace(/^<script>/, '').replace(/<\/script>$/, '');
    if (thankYou) {
      const blank = "var THANK_YOU = '';";
      if (code.split(blank).length !== 2) throw new Error('THANK_YOU line not found exactly once');
      code = code.replace(blank, `var THANK_YOU = '${thankYou}';`);
    }
    const c = { window: page, document: doc, location: page.location, URL };
    vm.createContext(c);
    vm.runInContext(code, c);
    const booked = (over = {}) => ({ source: frameWin, origin: new URL(frameSrc).origin,
      data: { type: 'yc-booking', event: 'booked', slug: 'consult', redirect_url: null, ...over } });
    const resize = (height, step, over = {}) => ({ source: frameWin, origin: new URL(frameSrc).origin,
      data: { type: 'yc-booking', event: 'resize', slug: 'consult', height, step, ...over } });
    return { page, frameWin, frame, booked, resize, fire: (e) => listeners.forEach((fn) => fn(e)), count: () => listeners.length };
  }

  test('the snippet: an iframe with its id on the landing host, one script, a real closing tag', () => {
    const s = ctx.embedHelpSnippet(VIEW);
    expect(s.startsWith('<!-- 4LSG booking: consult -->\n<iframe id="yc-booking-consult" src="https://4lsg.com/b/consult"')).toBe(true);
    expect(s.trimEnd().endsWith('</script>')).toBe(true);
    expect(s.match(/<script>/g)).toHaveLength(1);
  });

  test('the script names no domain: it trusts its own iframe, on the address the iframe holds', () => {
    const script = ctx.embedListenerScript(VIEW);
    expect(script).not.toMatch(/4lsg/i);
    expect(script).toContain('e.source !== f.contentWindow');
    expect(script).toContain('e.origin !== new URL(f.src, location.href).origin');
  });

  test('THANK_YOU filled in → the host\'s own page (relative allowed), whatever the view default', () => {
    const h = hostPage('/thank-you.html');
    expect(h.count()).toBe(1);
    h.fire(h.booked({ redirect_url: 'https://firm.example.com/default' }));
    expect(h.page.location.href).toBe('/thank-you.html');
  });

  test('THANK_YOU empty → the view default when https; else stay', () => {
    const h = hostPage();
    h.fire(h.booked({ redirect_url: 'https://firm.example.com/default' }));
    expect(h.page.location.href).toBe('https://firm.example.com/default');
    for (const bad of [null, 'http://firm.example.com/d', 'javascript:alert(1)']) {
      const h2 = hostPage();
      h2.fire(h2.booked({ redirect_url: bad }));
      expect([bad, h2.page.location.href]).toEqual([bad, 'https://vanity.example.net/']);
    }
  });

  test('ignores every message not from its own booking box, or not a booked event', () => {
    for (const [why, mk] of [
      ['another window', (h) => ({ ...h.booked(), source: {} })],
      ['its box, navigated to a third-party page', (h) => ({ ...h.booked(), origin: 'https://third-party.example.com' })],
      ['no source', (h) => ({ ...h.booked(), source: null })],
      ['other type', (h) => h.booked({ type: 'something' })],
      ['other event', (h) => h.booked({ event: 'opened' })],
      ['string data', (h) => ({ source: h.frameWin, data: 'booked' })],
      ['no data', (h) => ({ source: h.frameWin, data: null })],
    ]) {
      const h = hostPage('/thank-you.html');
      h.fire(mk(h));
      expect([why, h.page.location.href]).toEqual([why, 'https://vanity.example.net/']);
    }
  });

  describe('resize: the box follows the form (ditchurdebt.com script.js v1.1 passes the same checks)', () => {
    test('sets the iframe height to the rounded, clamped value', () => {
      const h = hostPage();
      for (const [sent, want] of [[880, '880px'], [1119.6, '1120px'], [412.4, '412px'], [100, '300px'], [299, '300px'], [300, '300px'], [4000, '4000px'], [9000, '4000px'], ['680', '680px']]) {
        h.fire(h.resize(sent, 1));
        expect([sent, h.frame.style.height]).toEqual([sent, want]);
      }
      expect(h.page.location.href).toBe('https://vanity.example.net/');   // never navigates
    });

    test('ignores a non-finite or non-positive height, leaving the box as it was', () => {
      // (a boolean true is Number() 1 → the 300 px floor, as ditchurdebt's host reads it too; not guarded)
      for (const bad of [0, -1, NaN, Infinity, -Infinity, 'tall', '', null, undefined, {}, [], false]) {
        const h = hostPage();
        h.fire(h.resize(bad, 1));
        expect([bad, h.frame.style.height]).toEqual([bad, '700px']);
      }
    });

    test('the same two guards as booked: another window, a navigated box, another type → nothing', () => {
      for (const [why, mk] of [
        ['another window', (h) => ({ ...h.resize(900, 1), source: {} })],
        ['its box, navigated to a third-party page', (h) => ({ ...h.resize(900, 1), origin: 'https://third-party.example.com' })],
        ['other type', (h) => h.resize(900, 1, { type: 'yc-other' })],
        ['other event', (h) => h.resize(900, 1, { event: 'grow' })],
        ['no data', (h) => ({ source: h.frameWin, origin: 'https://4lsg.com', data: null })],
      ]) {
        const h = hostPage();
        h.fire(mk(h));
        expect([why, h.frame.style.height, h.frame.scrolled]).toEqual([why, '700px', []]);
      }
    });

    test('a step change scrolls the box back into view only when its top is above the viewport, and never on the first message', () => {
      const h = hostPage();
      h.frame.top = -500;                       // scrolled past, but the first message never scrolls
      h.fire(h.resize(1200, 2));
      expect(h.frame.scrolled).toEqual([]);
      h.fire(h.resize(1210, 2));               // same step: a mere height change
      expect(h.frame.scrolled).toEqual([]);
      h.fire(h.resize(700, 3));                // step change, top above the viewport → scroll
      expect(h.frame.scrolled).toEqual([{ block: 'start' }]);
      h.frame.top = 40;                         // visible: a step change does not jump the page
      h.fire(h.resize(500, 'done'));
      expect(h.frame.scrolled).toEqual([{ block: 'start' }]);
      h.frame.top = -10;                        // same step again → no scroll
      h.fire(h.resize(520, 'done'));
      expect(h.frame.scrolled).toEqual([{ block: 'start' }]);
      expect(h.frame.style.height).toBe('520px');
    });

    test('a resize without a step still sizes the box and never scrolls', () => {
      const h = hostPage();
      h.frame.top = -500;
      h.fire(h.resize(900, undefined));
      h.fire(h.resize(950, undefined));
      expect(h.frame.style.height).toBe('950px');
      expect(h.frame.scrolled).toEqual([]);
    });

    test('resize does not disturb booked: a tagged sequence ends on the thank-you page', () => {
      const h = hostPage('/thank-you.html');
      h.fire(h.resize(880, 1));
      h.fire(h.resize(1300, 2));
      h.fire(h.booked());
      expect(h.page.location.href).toBe('/thank-you.html');
    });

    test('the snippet keeps the 700px start, and the AI brief describes resize and ?src= without naming a domain', () => {
      expect(ctx.embedHelpFrame(VIEW)).toContain('height:700px');
      const script = ctx.embedListenerScript(VIEW);
      expect(script).toContain("d.event === 'resize'");
      expect(script).toContain('Math.min(Math.max(h, 300), 4000)');
      expect(script).toContain("scrollIntoView({ block: 'start' })");
      expect(script).not.toMatch(/4lsg/i);
      const b = ctx.embedLlmBlurb(VIEW);
      expect(b).toContain('event.data.event === "resize"');
      expect(b).toContain('clamped between 300 and 4000');
      expect(b).toContain('?src=<tag>');
      expect(b).toContain('does not change where the visitor goes');
    });
  });

  test('two embeds on one page keep their own THANK_YOU (the script is wrapped)', () => {
    expect(ctx.embedListenerScript(VIEW)).toMatch(/^<script>\n\(function \(\) \{[\s\S]*\}\)\(\);\n<\/script>$/);
  });

  test('the standalone link is the plain booking link (no page named in it)', () => {
    expect(ctx.embedHelpLink(VIEW)).toBe('https://4lsg.com/b/consult');
  });

  test('the AI brief covers both ways', () => {
    const b = ctx.embedLlmBlurb(VIEW);
    expect(b).toContain('"Free Consultation"');
    expect(b).toContain('<iframe id="yc-booking-consult" src="https://4lsg.com/b/consult"');
    expect(b).toContain('event.source is not the contentWindow of the iframe with id "yc-booking-consult"');
    expect(b).toContain('event.data.type === "yc-booking"');
    expect(b).toContain('do not add a sandbox attribute');
    expect(b).toContain('https://4lsg.com/b/consult — after booking');
    expect(b).toContain('a link cannot choose a different one');
    expect(b).not.toContain('ty=');
    expect(b).toContain('event.origin is not the origin of that iframe\'s src');
    expect(b).toContain('at most once per page');
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
    for (const id of ['eh-backdrop', 'eh-view', 'eh-snippet', 'eh-link', 'eh-llm', 'eh-copy-snippet', 'eh-copy-link', 'eh-copy-llm', 'eh-close']) {
      expect([id, SRC.includes(`id="${id}"`)]).toEqual([id, true]);
    }
  });
});
