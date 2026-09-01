// tests/unifiedEventsU5.booking.test.js
//
/**
 * Unified Events U5 — booking views carry a registry key.
 *
 * Two halves, and they fail independently:
 *
 *   ROUTE   routes/api.bookingViews.js accepts `type_key`, validates it by
 *           EXACT KEY against calendar_item_types, requires it on CREATE and
 *           tolerates its absence on PATCH.
 *   BOOKING routes/booking.js hands the view's key to createAppt, which
 *           prefers a valid given key and otherwise falls back to resolving
 *           the label (U2 resolveForCreate). A view whose type_key is still
 *           NULL therefore keeps booking exactly as it did before U5 —
 *           that fallback is what makes the column safe to add before every
 *           row has one.
 *
 * ── WHY getType AND NOT resolveTypeKey ─────────────────────────────────────
 * resolveTypeKey accepts a key, a LABEL, or an ingest alias — correct for a
 * write path handed free text, wrong for a field that is declared to hold a
 * key. If the admin API accepted 'Consultation' here, booking_views.type_key
 * would end up holding the same two vocabularies the column exists to
 * separate. Asserted below by feeding it a label and a live alias and
 * expecting 400 for both.
 *
 * Run:  npx jest tests/unifiedEventsU5.booking.test.js
 */

'use strict';

process.env.CREDENTIALS_ENCRYPTION_KEY =
  process.env.CREDENTIALS_ENCRYPTION_KEY || 'x'.repeat(64);

jest.mock('../lib/auth.jwtOrApiKey', () => (req, res, next) => next());

const express = require('express');
const calendarTypeService = require('../services/calendarTypeService');
const SEED = require('./fixtures/calendar_item_types.seed.json');

// ─────────────────────────────────────────────────────────────────────────────
// A booking_views table in memory, plus the two reference reads validateView
// performs (users, hooks). Routed by SQL so an added query cannot silently
// shift a positional fixture.
// ─────────────────────────────────────────────────────────────────────────────

function makeDb(seedViews = []) {
  const rows = new Map(seedViews.map((v) => [Number(v.id), { ...v }]));
  const unmatched = [];
  let nextId = 100;

  const query = async (sql, params = []) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();

    if (/^SELECT user FROM users/i.test(flat)) {
      // Every requested provider id exists and does appts.
      const ids = Array.isArray(params[0]) ? params[0] : [];
      return [ids.map((u) => ({ user: u }))];
    }
    if (/^SELECT id FROM hooks/i.test(flat)) return [[]];
    if (/^SELECT \* FROM booking_views WHERE id/i.test(flat)) {
      const r = rows.get(Number(params[0]));
      return [r ? [r] : []];
    }
    if (/^SELECT \* FROM booking_views ORDER BY/i.test(flat)) return [[...rows.values()]];
    if (/^INSERT INTO booking_views/i.test(flat)) {
      const cols = flat.slice(flat.indexOf('(') + 1, flat.indexOf(')')).split(',').map((c) => c.trim());
      const row = { id: ++nextId };
      cols.forEach((c, i) => { row[c] = params[i]; });
      rows.set(row.id, row);
      return [{ insertId: row.id, affectedRows: 1 }];
    }
    if (/^UPDATE booking_views SET/i.test(flat)) {
      const id = Number(params[params.length - 1]);
      const cols = flat.slice(flat.indexOf('SET') + 3, flat.indexOf('WHERE'))
        .split(',').map((s) => s.split('=')[0].trim());
      const row = rows.get(id) || {};
      cols.forEach((c, i) => { row[c] = params[i]; });
      rows.set(id, row);
      return [{ affectedRows: 1 }];
    }
    unmatched.push(flat);
    return [[]];
  };

  return { rows, unmatched, query };
}

// ── a real listening app, so express/body-parser behave exactly as in prod ──
let server = null;
let base = null;
let CURRENT_DB = null;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.db = CURRENT_DB; next(); });
  app.use(require('../routes/api.bookingViews'));
  server = app.listen(0, () => {
    base = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => {
  if (server.closeAllConnections) server.closeAllConnections();
  server.close(done);
});

/** Point the mounted app at a fresh in-memory table and return it. */
function useDb(seedViews = []) {
  CURRENT_DB = makeDb(seedViews);
  return CURRENT_DB;
}

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { parsed = null; }
  return { status: res.status, body: parsed };
}

const BASE_VIEW = {
  slug: 'consult', title: 'Free Consultation',
  provider_mode: 'fixed_one', provider_ids: [1],
  appt_type: 'Consultation', appt_length: 30,
};

beforeAll(() => calendarTypeService._primeCache(SEED));
afterAll(() => calendarTypeService.invalidate());
beforeEach(() => { jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { console.error.mockRestore(); });

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/booking-views — type_key required and registry-checked', () => {
  test('a valid key is stored canonically', async () => {
    const db = useDb();
    const r = await call('POST', '/api/booking-views',
      { ...BASE_VIEW, type_key: 'consultation' });
    expect(r.status).toBe(200);
    expect(db.rows.get(r.body.id).type_key).toBe('consultation');
    // appt_type is NOT overwritten from the registry label — the confirmation
    // template interpolates it and staff wrote it.
    expect(db.rows.get(r.body.id).appt_type).toBe('Consultation');
    expect(db.unmatched).toEqual([]);
  });

  test('key casing is normalized to the registry row', async () => {
    const db = useDb();
    const r = await call('POST', '/api/booking-views',
      { ...BASE_VIEW, type_key: '  TAX_CONSULT ' });
    expect(r.status).toBe(200);
    expect(db.rows.get(r.body.id).type_key).toBe('tax_consult');
  });

  test('an unknown key is a 400 naming the value', async () => {
    const db = useDb();
    const r = await call('POST', '/api/booking-views',
      { ...BASE_VIEW, type_key: 'not_a_real_key' });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/not_a_real_key/);
    expect(r.body.message).toMatch(/calendar_item_types/);
  });

  test('a LABEL is rejected — this column holds keys, not the other vocabulary', async () => {
    useDb();
    for (const label of ['Initial Strategy Session', '341 Meeting', 'Pre-Filing Meeting']) {
      const r = await call('POST', '/api/booking-views', { ...BASE_VIEW, type_key: label });
      expect([label, r.status]).toEqual([label, 400]);
    }
  });

  test("…but 'Consultation' IS accepted, because that label ci-EQUALS its own key", async () => {
    // Not a hole in the check — getType matches keys under the same
    // trim+lowercase the general_ci column uses, and `consultation` is the key.
    // Worth pinning so the next reader does not "fix" the label test by
    // deleting the case above.
    const db = useDb();
    const r = await call('POST', '/api/booking-views',
      { ...BASE_VIEW, type_key: 'Consultation' });
    expect(r.status).toBe(200);
    expect(db.rows.get(r.body.id).type_key).toBe('consultation');
  });

  test('an ingest ALIAS is rejected too, for the same reason', async () => {
    // 'Tax Consultation' resolves to tax_consult at WRITE time from free text.
    // It is still not a key, and the admin field asks for a key.
    const db = useDb();
    const r = await call('POST', '/api/booking-views',
      { ...BASE_VIEW, type_key: 'Tax Consultation' });
    expect(r.status).toBe(400);
  });

  test('an INACTIVE registry type is accepted — active gates pickers, not storage', async () => {
    // v0.5 §3.3: "active gates pickers only — an inactive type still resolves."
    // The `test` type is active=0 live and the 'random' view uses it.
    const db = useDb();
    const r = await call('POST', '/api/booking-views',
      { ...BASE_VIEW, slug: 'random', appt_type: 'Potato Hunting', type_key: 'test' });
    expect(r.status).toBe(200);
    expect(db.rows.get(r.body.id).type_key).toBe('test');
  });

  test('omitting type_key on CREATE is a 400', async () => {
    const db = useDb();
    const r = await call('POST', '/api/booking-views', { ...BASE_VIEW });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/type_key is required/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('PATCH /api/booking-views/:id — tolerant of a keyless legacy row', () => {
  const legacy = {
    id: 7, ...BASE_VIEW, provider_ids: [1], type_key: null, platform: 'telephone',
    granularity_min: 15, horizon_days: 30, buffer_min: 0, min_notice_min: 120,
    identity_mode: 'public', page_windows: null, hook_id: null,
  };

  test('an unrelated edit on a keyless row still saves — the row is not bricked', async () => {
    // validateView merges the stored row into the patch, so a create-style
    // "required" check here would make every pre-U5 view uneditable through
    // its own admin screen.
    const db = useDb([legacy]);
    const r = await call('PATCH', '/api/booking-views/7', { title: 'Renamed' });
    expect(r.status).toBe(200);
    expect(db.rows.get(7).title).toBe('Renamed');
    expect(db.rows.get(7).type_key).toBeNull();
  });

  test('a PATCH can set the key, and an unknown one still 400s', async () => {
    const db = useDb([legacy]);
    const ok = await call('PATCH', '/api/booking-views/7', { type_key: 'consultation' });
    expect(ok.status).toBe(200);
    expect(db.rows.get(7).type_key).toBe('consultation');

    const bad = await call('PATCH', '/api/booking-views/7', { type_key: 'nope' });
    expect(bad.status).toBe(400);
  });

  test('a PATCH can CLEAR the key back to null (blank = no key, not an error)', async () => {
    const db = useDb([{ ...legacy, type_key: 'consultation' }]);
    const r = await call('PATCH', '/api/booking-views/7', { type_key: '' });
    expect(r.status).toBe(200);
    expect(db.rows.get(7).type_key).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// routes/booking.js hands the key to createAppt
//
// bookUnderLock is internal, so this asserts the seam it sits on: the exact
// createAppt contract U2 defined, driven with the two shapes a booking_views
// row can now have.
// ─────────────────────────────────────────────────────────────────────────────
describe('createAppt honours a booking view key, and survives without one', () => {
  const apptSrc = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'routes', 'booking.js'), 'utf8');

  test('routes/booking.js passes view.type_key into createAppt', () => {
    // The call site is inside bookUnderLock's named-lock block; a structural
    // assertion is the honest one here rather than standing up the whole
    // availability engine to book a slot.
    const call = /apptService\.createAppt\(db, \{[\s\S]*?\}\);/.exec(apptSrc);
    expect(call).not.toBeNull();
    expect(call[0]).toMatch(/type_key:\s*view\.type_key/);
    expect(call[0]).toMatch(/appt_type:\s*view\.appt_type/);   // the label still rides along
  });

  test('a given valid key wins over the label', async () => {
    const r = await calendarTypeService.resolveForCreate(null, 'meeting_341', 'Consultation');
    expect(r.type_key).toBe('meeting_341');
  });

  test('a NULL key falls through to label resolution — keyless views keep working', async () => {
    const r = await calendarTypeService.resolveForCreate(null, null, 'Consultation');
    expect(r.type_key).toBe('consultation');
  });

  test('a NULL key on an ALIASED label still resolves (the live "random" view)', async () => {
    const r = await calendarTypeService.resolveForCreate(null, null, 'Potato Hunting');
    expect(r.type_key).toBe('test');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// public/bookingviewsmanager.html — the picker
//
// The page boots inside the shell iframe and talks to the parent's apiSend, so
// a full jsdom mount would be mocking more than it exercised. What is worth
// pinning is what a silent typo would break: the inline script must PARSE, the
// two fields must exist by id, and the registry fetch must be scoped to
// kind=meeting (v0.5 §3.3.2 — a booking view writes an appt, and only
// kind='meeting' types live in that table).
// ─────────────────────────────────────────────────────────────────────────────
describe('bookingviewsmanager.html — registry picker', () => {
  const vm = require('vm');
  const html = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'public', 'bookingviewsmanager.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

  test('every inline script parses', () => {
    expect(scripts.length).toBeGreaterThan(0);
    for (const src of scripts) expect(() => new vm.Script(src)).not.toThrow();
  });

  test('the type picker and the display-label input both exist', () => {
    expect(html).toMatch(/<select id="f-type-key">/);
    expect(html).toMatch(/id="f-appt-type"/);
    // The label field is no longer THE type field — its <label> must say so or
    // staff will read the two as duplicates.
    expect(html).toMatch(/<label for="f-appt-type">Display label<\/label>/);
  });

  test('the registry fetch is scoped to active meeting types', () => {
    const js = scripts.join('\n');
    expect(js).toMatch(/\/api\/calendar-types\?kind=meeting&active=1/);
  });

  test('the payload sends type_key, and client validation requires it', () => {
    const js = scripts.join('\n');
    expect(js).toMatch(/type_key:\s*E\('f-type-key'\)/);
    expect(js).toMatch(/if \(!p\.type_key\) return 'Appointment type is required\.'/);
  });

  test('a registry failure degrades to a text input rather than blocking saves', () => {
    const js = scripts.join('\n');
    expect(js).toMatch(/state\.calendarTypes = \[\]/);          // the catch
    expect(js).toMatch(/registry unavailable/);                  // the fallback input
  });

  test('the label follows the type only while it is still the type\'s own label', () => {
    const js = scripts.join('\n');
    expect(js).toMatch(/cur === '' \|\| cur === typeKeyLabel\(state\.prevTypeKey\)/);
  });
});
