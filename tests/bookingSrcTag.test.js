/**
 * Booking embed attribution — `?src=<tag>` (2026-11-25).
 *
 * One booking view (bk-consult) is embedded on several websites. The embed's
 * iframe src (or a plain link) may carry `?src=<tag>`; public/book.html reads
 * it from its own query string and forwards it as body.src on
 * POST /api/book/:slug; routes/booking.js normalizes it (trim, lower-case,
 * `^[a-z0-9][a-z0-9_-]{0,29}$`) and writes appt_source = "<base>:<tag>", base =
 * the view's source_tag, else its slug, the BASE cut so the whole value fits
 * appts.appt_source varchar(60) (relaxed sql_mode truncates silently). An
 * invalid tag is IGNORED — the booking proceeds untagged; attribution never
 * 400s. Untagged = exactly today's value, view.source_tag || null. The tag
 * touches appt_source alone: not the redirect, the thank-you, the branding,
 * the response.
 *
 * Covered here:
 *   - normalizeSrcTag / composeApptSource (routes/booking.js _test), incl. the
 *     ≤ 60 pin over every slug length × tag length;
 *   - the route end to end on a real listening app (the real middleware and
 *     the real pipeline down to createAppt, which is stubbed, as is the
 *     availability engine), in the harness style of bookingRedirect /
 *     unifiedEventsU5.booking: with src → createAppt gets the composed value;
 *     without → unchanged; an invalid src still books, untagged; the response
 *     and every other createAppt argument are identical either way;
 *   - public/book.html: `src` from the page's query reaches the payload
 *     (submit lifted into a vm), and only when present.
 * The view hook's `source` (the row's value, else the view's tag):
 * tests/bookingSrcTag.hook.test.js. The column's width on the real engine:
 * tests/bookingSrcTag.mysql.test.js.
 *
 * Run:  npx jest tests/bookingSrcTag.test.js
 */
'use strict';

process.env.CREDENTIALS_ENCRYPTION_KEY = process.env.CREDENTIALS_ENCRYPTION_KEY || 'x'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'booking-src-test-secret';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const express = require('express');
const { DateTime } = require('luxon');

jest.mock('../lib/auth.jwtOrApiKey', () => (req, res, next) => next());
jest.mock('../services/availabilityService', () => ({ getSlots: jest.fn(async () => ({})) }));
jest.mock('../services/apptService', () => ({
  createAppt: jest.fn(async () => ({ appt_id: 9001 })),
  insertApptLog: jest.fn(async () => ({})),
}));
jest.mock('../lib/alerting', () => ({ alert: jest.fn(() => Promise.resolve()) }));

const { getSlots } = require('../services/availabilityService');
const apptService = require('../services/apptService');
const { FIRM_TZ } = require('../services/timezoneService');
const booking = require('../routes/booking');
const { normalizeSrcTag, composeApptSource, signTs } = booking._test;

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

// Lift `function name(…) { … }` by brace matching (as bookingRedirect does).
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

// ── normalizeSrcTag ────────────────────────────────────────────────────────
describe('normalizeSrcTag — trim, lower-case, then the charset and length rule', () => {
  test('a valid tag passes as itself', () => {
    for (const t of ['ditchurdebt', 'a', '7', 'a_b-c', 'site-2', 'a'.repeat(30), 'x'.repeat(29) + '_']) {
      expect([t, normalizeSrcTag(t)]).toEqual([t, t]);
    }
  });

  test('case and surrounding whitespace are normalized away', () => {
    expect(normalizeSrcTag('DitchUrDebt')).toBe('ditchurdebt');
    expect(normalizeSrcTag('  ditchurdebt\n')).toBe('ditchurdebt');
    expect(normalizeSrcTag(' A_B ')).toBe('a_b');
  });

  test('a bad charset, a bad first character or too long → null (ignored)', () => {
    for (const bad of ['a'.repeat(31), '-lead', '_x', 'bad tag', 'tag!', 'über', 'a.b', 'a/b', 'a:b', 'a=b', '%20', 'a\u0000']) {
      expect([bad, normalizeSrcTag(bad)]).toEqual([bad, null]);
    }
  });

  test('empty, blank and every non-string → null', () => {
    for (const v of ['', '   ', null, undefined, 5, 0, true, {}, [], ['a'], { toString: () => 'a' }]) {
      expect([v, normalizeSrcTag(v)]).toEqual([v, null]);
    }
  });
});

// ── composeApptSource ──────────────────────────────────────────────────────
describe('composeApptSource — "<base>:<tag>", base = source_tag || slug, never over 60', () => {
  const TAGGED = { slug: 'consult', source_tag: 'test-consult' };
  const BARE = { slug: 'bk-consult', source_tag: null };

  test('untagged → exactly today\'s value: the view\'s source_tag, else null (never the slug, never "")', () => {
    expect(composeApptSource(TAGGED, null)).toBe('test-consult');
    expect(composeApptSource(BARE, null)).toBeNull();
    expect(composeApptSource({ slug: 'x', source_tag: '' }, null)).toBeNull();
    expect(composeApptSource({ slug: 'x', source_tag: undefined }, undefined)).toBeNull();
    expect(composeApptSource(BARE, '')).toBeNull();
  });

  test('tagged → the view\'s source_tag, or its slug when it has none, then ":<tag>"', () => {
    expect(composeApptSource(TAGGED, 'ditchurdebt')).toBe('test-consult:ditchurdebt');
    expect(composeApptSource(BARE, 'ditchurdebt')).toBe('bk-consult:ditchurdebt');
    expect(composeApptSource({ slug: 'x', source_tag: '' }, 'a')).toBe('x:a');
  });

  test('a 100-character slug (SLUG_RE\'s cap) with a 30-character tag: 60 characters, the tag whole, the BASE cut', () => {
    const slug = 's'.repeat(100);
    const tag = 't'.repeat(30);
    const v = composeApptSource({ slug, source_tag: null }, tag);
    expect(v).toHaveLength(60);
    expect(v.endsWith(':' + tag)).toBe(true);
    expect(v.slice(0, 29)).toBe('s'.repeat(29));
    // a long source_tag is cut the same way
    expect(composeApptSource({ slug: 'x', source_tag: 'y'.repeat(60) }, 'ab')).toBe('y'.repeat(57) + ':ab');
  });

  test('every slug length × tag length lands at or under 60 and keeps the whole tag', () => {
    for (let s = 1; s <= 100; s++) {
      for (let t = 1; t <= 30; t++) {
        const tag = 't'.repeat(t);
        const v = composeApptSource({ slug: 'a'.repeat(s), source_tag: null }, tag);
        if (v.length > 60 || !v.endsWith(':' + tag) || v[0] !== 'a') {
          throw new Error(`slug ${s} × tag ${t} → "${v}" (${v.length})`);
        }
      }
    }
    // exactly 60 without a cut: 58 + ':' + 1
    expect(composeApptSource({ slug: 'a'.repeat(58), source_tag: null }, 'z')).toBe('a'.repeat(58) + ':z');
    // one over: the base loses one character, not the tag
    expect(composeApptSource({ slug: 'a'.repeat(59), source_tag: null }, 'z')).toBe('a'.repeat(58) + ':z');
  });
});

// ── POST /api/book/:slug ───────────────────────────────────────────────────
describe('POST /api/book/:slug — body.src reaches createAppt as the composed appt_source', () => {
  let server, base, db;
  const VIEWS = {
    'bk-consult': { id: 7, slug: 'bk-consult', active: 1, source_tag: null, provider_mode: 'fixed_one',
      provider_ids: '[1]', appt_type: 'Consultation', type_key: 'consultation', appt_length: 30,
      platform: 'telephone', granularity_min: 15, horizon_days: 30, min_notice_min: 0, buffer_min: 0,
      page_windows: null, collect_note: 0, confirm_template: null, confirm_sms: 0, confirm_email: 0,
      thankyou_html: '<p>Booked.</p>', redirect_url: 'https://ditchurdebt.example.com/thanks' },
    consult: { id: 1, slug: 'consult', active: 1, source_tag: 'test-consult', provider_mode: 'fixed_one',
      provider_ids: '[1]', appt_type: 'Consultation', type_key: 'consultation', appt_length: 30,
      platform: 'telephone', granularity_min: 15, horizon_days: 30, min_notice_min: 0, buffer_min: 0,
      page_windows: null, collect_note: 0, confirm_template: null, confirm_sms: 0, confirm_email: 0,
      thankyou_html: null, redirect_url: null },
  };

  function makeDb() {
    const unmatched = [];
    const flat = (sql) => String(sql).replace(/\s+/g, ' ').trim();
    const conn = {
      query: async (sql) => {
        const f = flat(sql);
        if (/GET_LOCK/.test(f)) return [[{ lockAcquired: 1 }]];
        if (/RELEASE_LOCK/.test(f)) return [[{}]];
        unmatched.push(f); return [[]];
      },
      release: () => {},
    };
    return {
      unmatched,
      query: async (sql, params = []) => {
        const f = flat(sql);
        if (/^SELECT \* FROM booking_views WHERE slug = \? AND active = 1/i.test(f)) {
          const v = VIEWS[params[0]]; return [v ? [{ ...v }] : []];
        }
        if (/^SELECT contact_id FROM contacts WHERE contact_token = \?/i.test(f)) return [[{ contact_id: 77 }]];
        unmatched.push(f); return [[]];
      },
      getConnection: async () => conn,
    };
  }

  // A slot tomorrow at 10:00 firm time: inside the horizon, past min_notice.
  const START = DateTime.now().setZone(FIRM_TZ).plus({ days: 1 }).toFormat('yyyy-MM-dd') + ' 10:00';
  let ipN = 0;
  async function book(slug, extra = {}) {
    const ts = Date.now() - 5000;                          // ≥ 3 s old, ≤ 2 h
    const body = { start: START, website: '', ts, sig: signTs(ts), c: 'tok_' + 'a'.repeat(20), ...extra };
    const r = await fetch(`${base}/api/book/${slug}`, {
      method: 'POST',
      // a fresh client IP per POST: the route's limiter answers the 6th POST
      // from one IP with a silent fake success, which would hide a miss here
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.9.${Math.floor(++ipN / 250)}.${ipN % 250}` },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  }
  const lastCreate = () => apptService.createAppt.mock.calls[apptService.createAppt.mock.calls.length - 1][1];

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.db = db; next(); });
    app.use(booking);
    server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
  });
  afterAll((done) => { server.closeAllConnections(); server.close(done); });
  beforeEach(() => {
    db = makeDb();
    apptService.createAppt.mockClear();
    getSlots.mockImplementation(async (_db, { providerIds }) => Object.fromEntries(providerIds.map((p) => [p, [START]])));
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  test('with src: createAppt receives "<slug>:<tag>" on a view without a source_tag', async () => {
    const r = await book('bk-consult', { src: 'ditchurdebt' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, thankyou_html: '<p>Booked.</p>', redirect_url: 'https://ditchurdebt.example.com/thanks' });
    expect(apptService.createAppt).toHaveBeenCalledTimes(1);
    expect(lastCreate()).toMatchObject({ appt_source: 'bk-consult:ditchurdebt', appt_view_id: 7, contact_id: 77, source: 'client' });
    expect(db.unmatched).toEqual([]);
  });

  test('with src on a view WITH a source_tag: "<source_tag>:<tag>"', async () => {
    const r = await book('consult', { src: 'ditchurdebt' });
    expect(r.status).toBe(200);
    expect(lastCreate().appt_source).toBe('test-consult:ditchurdebt');
  });

  test('the tag is normalized on the way in', async () => {
    await book('bk-consult', { src: '  DitchUrDebt ' });
    expect(lastCreate().appt_source).toBe('bk-consult:ditchurdebt');
  });

  test('without src: exactly today\'s value — the view\'s source_tag, else null', async () => {
    await book('bk-consult');
    expect(lastCreate().appt_source).toBeNull();
    await book('consult');
    expect(lastCreate().appt_source).toBe('test-consult');
  });

  test('an invalid src still books — untagged, 200, never a 400', async () => {
    for (const bad of ['Bad Tag!', 'a'.repeat(31), '-x', '', 5, true, { a: 1 }, ['ditchurdebt'], null]) {
      apptService.createAppt.mockClear();
      const r = await book('bk-consult', { src: bad });
      expect([bad, r.status, r.body.success]).toEqual([bad, 200, true]);
      expect([bad, apptService.createAppt].map((x, i) => (i ? x.mock.calls.length : x))).toEqual([bad, 1]);
      expect([bad, lastCreate().appt_source]).toEqual([bad, null]);
    }
  });

  test('the tag changes appt_source and NOTHING else: every other createAppt argument and the response are identical', async () => {
    const plain = await book('bk-consult');
    const plainArgs = { ...lastCreate() };
    const tagged = await book('bk-consult', { src: 'ditchurdebt' });
    const taggedArgs = { ...lastCreate() };
    expect(tagged).toEqual(plain);
    expect(plainArgs.appt_source).toBeNull();
    expect(taggedArgs.appt_source).toBe('bk-consult:ditchurdebt');
    delete plainArgs.appt_source; delete taggedArgs.appt_source;
    expect(taggedArgs).toEqual(plainArgs);
  });

  test('src rides along with a prefill token (?c=) and a note alike', async () => {
    await book('bk-consult', { src: 'improud', note: 'ignored: the view does not collect it' });
    expect(lastCreate()).toMatchObject({ appt_source: 'bk-consult:improud', contact_id: 77, note: '' });
  });

  test('the slot check still rules: a taken slot is a 409 with no createAppt, tag or not', async () => {
    getSlots.mockImplementation(async () => ({ 1: [] }));
    const r = await book('bk-consult', { src: 'ditchurdebt' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('slot_taken');
    expect(apptService.createAppt).not.toHaveBeenCalled();
  });
});

// ── public/book.html — the payload ────────────────────────────────────────
describe('public/book.html — src from the page\'s own query string reaches the POST body', () => {
  const SRC = read('book.html');

  test('the page reads ?src= beside ?c=', () => {
    expect(SRC).toContain("var qs = new URLSearchParams(location.search);");
    expect(SRC).toContain("var srcTag = qs.get('src') || '';");
  });

  // Run submit() in a stand-in page: token mode (no identity fields), a slot
  // picked, the provider section hidden; capture what apiPost is handed.
  function runSubmit(srcTag) {
    const posted = [];
    const els = {
      'book-btn': { disabled: false, textContent: 'Book' },
      website: { value: '' },
      'provider-section': { classList: { contains: () => true } },
      'f-note': { value: '' },
    };
    const ctx = {
      selectedSlot: '2026-12-01 10:00', submitting: false, tokenMode: true, useToken: true, token: 'tok_' + 'a'.repeat(20),
      srcTag, slug: 'bk-consult', cfg: { ts: 1700000000000, sig: 'f'.repeat(64), collect_note: false },
      E: (id) => els[id] || { value: '' },
      identityValid: () => true, setErr: () => {}, setInfo: () => {}, finishSubmit: () => {}, handleBookResponse: () => {},
      encodeURIComponent,
      apiPost: (p, data) => { posted.push([p, data]); return { then: () => ({ catch: () => {} }) }; },
    };
    vm.createContext(ctx);
    vm.runInContext(fnSrc(SRC, 'submit'), ctx);
    ctx.submit();
    return posted;
  }

  test('with a tag: payload.src is the raw query value (the server normalizes)', () => {
    const posted = runSubmit('DitchUrDebt');
    expect(posted).toHaveLength(1);
    expect(posted[0][0]).toBe('/api/book/bk-consult');
    expect(posted[0][1]).toMatchObject({ src: 'DitchUrDebt', c: 'tok_' + 'a'.repeat(20), start: '2026-12-01 10:00', ts: 1700000000000 });
  });

  test('without a tag: no src key at all (an old server never sees the field; today\'s payload exactly)', () => {
    const posted = runSubmit('');
    expect(posted).toHaveLength(1);
    expect('src' in posted[0][1]).toBe(false);
    expect(Object.keys(posted[0][1]).sort()).toEqual(['c', 'sig', 'start', 'ts', 'website']);
  });
});
