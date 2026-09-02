// tests/unifiedEventsU2b.options.test.js
//
/**
 * Unified Events U2b — picker OPTIONS read layer + route + seed parity.
 *
 *   services/calendarTypeService.listOptions / loadOptions / _primeOptions
 *   routes/api.calendarTypes.js  GET /api/calendar-types/options
 *   ref/2026-09-02_unified_events_u2b.sql ⇄ scripts/calendarTypeOptionsSeed.js
 *
 * The seed-parity block is the slice's acceptance test: resolving the seed
 * against surface=new_client / follow_up must reproduce the two <option>
 * lists that were hardcoded in public/scripts.js before U2b (one entry per
 * (type, length), dialog order), PLUS the "seed all" ruling additions.
 *
 * Run:  npx jest tests/unifiedEventsU2b.options.test.js
 */

'use strict';

jest.mock('../lib/auth.jwtOrApiKey', () => jest.fn((req, res, next) => { req.auth = { userId: 9 }; next(); }));

const fs   = require('fs');
const path = require('path');
const express = require('express');
const calendarTypeService = require('../services/calendarTypeService');
const { scriptGuard } = require('./helpers/scriptGuard');
const SEED = require('./fixtures/calendar_item_types.seed.json');
const { SURFACES, OPTIONS_SEED, DIALOG_LISTS_2026_09_02 } = require('../scripts/calendarTypeOptionsSeed');
const router = require('../routes/api.calendarTypes');

// Options fixture: the seed module, given ids in file order (as the migration's
// AUTO_INCREMENT would).
const OPTION_ROWS = OPTIONS_SEED.map((o, i) => ({ id: i + 1, ...o, active: 1 }));

function stubDb(script) {
  const calls = [];
  const guard = scriptGuard('stubDb', script);
  return {
    calls, guard,
    query: async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params: params || [] });
      if (!script.length) guard.overrun(sql);
      return [script.shift()];
    },
  };
}

beforeEach(() => {
  calendarTypeService._primeCache(SEED);
  calendarTypeService._primeOptions(OPTION_ROWS);
});
afterAll(() => calendarTypeService.invalidate());

const keysAndLens = (rows) => rows.map((r) => `${r.type_key}:${r.length}`);

// ─────────────────────────────────────────────────────────────────────────────
// listOptions
// ─────────────────────────────────────────────────────────────────────────────

describe('listOptions', () => {
  test('surface is required and must be in the vocabulary → status-400 error', async () => {
    await expect(calendarTypeService.listOptions({}, {})).rejects.toMatchObject({ status: 400 });
    await expect(calendarTypeService.listOptions({}, { surface: 'staff_event' })).rejects.toMatchObject({ status: 400 });
    expect(SURFACES).toEqual(['new_client', 'follow_up']);
  });

  test('new_client: registry order, one row per (type, length), iss present, meeting/341 absent', async () => {
    const rows = await calendarTypeService.listOptions({}, { surface: 'new_client' });
    expect(keysAndLens(rows)).toEqual([
      'iss:15', 'ss:15', 'ss_follow_up:15', 'ss_follow_up:30', 'consultation:30', 'pre_filing:30',
      'schedules_meeting:45', 'docs_meeting:30', 'matrix_meeting:15', 'pre_lawsuit:30', 'tax_consult:30',
    ]);
    expect(rows[0]).toMatchObject({ option_id: 1, type_key: 'iss', label: 'Initial Strategy Session',
      type_label: 'Initial Strategy Session', length: 15, kind: 'meeting', surfaces: ['new_client'], active: 1 });
    expect(rows.some((r) => r.type_key === 'meeting_341')).toBe(false);
    expect(rows.some((r) => r.type_key === 'meeting')).toBe(false);
  });

  test('follow_up: no iss; schedules 20 sits after schedules 45 (option sort within the type)', async () => {
    const rows = await calendarTypeService.listOptions({}, { surface: 'follow_up' });
    expect(keysAndLens(rows)).toEqual([
      'ss:15', 'ss_follow_up:15', 'ss_follow_up:30', 'consultation:30', 'pre_filing:30',
      'schedules_meeting:45', 'schedules_meeting:20', 'docs_meeting:30', 'matrix_meeting:15',
      'pre_lawsuit:30', 'tax_consult:30', 'meeting:15',
    ]);
    expect(rows.some((r) => r.type_key === 'iss')).toBe(false);
  });

  test('case_type scoping follows the TYPE: Civil Litigation hides BK-scoped types, keeps unscoped + pre_lawsuit', async () => {
    const civ = await calendarTypeService.listOptions({}, { surface: 'follow_up', case_type: 'Civil Litigation' });
    const keys = civ.map((r) => r.type_key);
    expect(keys).toContain('pre_lawsuit');
    expect(keys).toContain('ss');
    expect(keys).not.toContain('pre_filing');
    expect(keys).not.toContain('schedules_meeting');
    const bk = await calendarTypeService.listOptions({}, { surface: 'follow_up', case_type: 'bankruptcy' });  // ci
    expect(bk.map((r) => r.type_key)).not.toContain('pre_lawsuit');
    expect(bk.map((r) => r.type_key)).toContain('pre_filing');
  });

  test('label override shows as picker text; type_label stays canonical', async () => {
    calendarTypeService._primeOptions([{ id: 1, type_key: 'consultation', label: 'Quick consult', length: 10, surfaces: '["new_client"]', sort_order: 0 }]);
    const rows = await calendarTypeService.listOptions({}, { surface: 'new_client' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: 'Quick consult', type_label: 'Consultation', length: 10 });
  });

  test('inactive option, inactive type, orphan option → not offered; active:false includes inactive', async () => {
    calendarTypeService._primeOptions([
      { id: 1, type_key: 'ss',     length: 15, surfaces: ['follow_up'], active: 0 },
      { id: 2, type_key: 'test',   length: 15, surfaces: ['follow_up'], active: 1 },   // type inactive
      { id: 3, type_key: 'ghost',  length: 15, surfaces: ['follow_up'], active: 1 },   // no such type
      { id: 4, type_key: 'ss',     length: 30, surfaces: ['follow_up'], active: 1 },
    ]);
    const live = await calendarTypeService.listOptions({}, { surface: 'follow_up' });
    expect(keysAndLens(live)).toEqual(['ss:30']);
    const all = await calendarTypeService.listOptions({}, { surface: 'follow_up', active: false });
    expect(keysAndLens(all)).toEqual(['ss:15', 'ss:30', 'test:15']);   // orphan still gone; inactive type/option shown
  });

  test('loadOptions: fail-soft — query failure serves [] then the last good rows', async () => {
    calendarTypeService.invalidate();
    calendarTypeService._primeCache(SEED);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = { query: async () => { throw new Error('boom'); } };
    expect(await calendarTypeService.loadOptions(bad)).toEqual([]);
    const good = stubDb([[{ id: 7, type_key: 'ss', label: null, length: 15, surfaces: '["follow_up"]', sort_order: 0, active: 1 }]]);
    const rows = await calendarTypeService.loadOptions(good, { force: true });
    expect(rows).toHaveLength(1);
    expect(good.calls[0].sql).toContain('FROM calendar_type_options');
    expect(await calendarTypeService.loadOptions(bad, { force: true })).toHaveLength(1);   // last good cache
    console.warn.mockRestore();
  });

  test('invalidate() clears the options cache too', async () => {
    calendarTypeService.invalidate();
    const db = stubDb([[]]);   // one options query expected after invalidate…
    calendarTypeService._primeCache(SEED);
    expect(await calendarTypeService.listOptions(db, { surface: 'follow_up' })).toEqual([]);
    expect(db.calls).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Route
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/calendar-types/options', () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.db = {}; next(); });
  app.use(router);
  let server, base;
  beforeAll(async () => {
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => new Promise((resolve) => server.close(resolve)));

  test('happy path envelope + case_type passthrough', async () => {
    const res = await fetch(`${base}/api/calendar-types/options?surface=new_client&case_type=Civil%20Litigation`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('success');
    expect(body.data.map((r) => r.type_key)).toContain('pre_lawsuit');
    expect(body.data.map((r) => r.type_key)).not.toContain('pre_filing');
  });

  test('missing / bad surface → 400 naming the vocabulary', async () => {
    const r1 = await fetch(`${base}/api/calendar-types/options`);
    expect(r1.status).toBe(400);
    expect((await r1.json()).message).toMatch(/new_client, follow_up/);
    const r2 = await fetch(`${base}/api/calendar-types/options?surface=booking`);
    expect(r2.status).toBe(400);
  });

  test('the plain /api/calendar-types route is untouched (no options in its rows)', async () => {
    const body = await (await fetch(`${base}/api/calendar-types?kind=meeting`)).json();
    expect(body.data[0]).not.toHaveProperty('options');
    expect(body.data[0]).not.toHaveProperty('surfaces');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Seed parity: migration SQL ⇄ seed module ⇄ the pre-U2b dialog lists
// ─────────────────────────────────────────────────────────────────────────────

describe('seed parity', () => {
  const SQL = fs.readFileSync(path.join(__dirname, '..', 'ref', '2026-09-02_unified_events_u2b.sql'), 'utf8');

  test('the migration seeds exactly OPTIONS_SEED (type, length, surfaces, sort_order)', () => {
    const re = /\('([a-z0-9_]+)',\s*NULL,\s*(\d+),\s*CAST\('(\[[^\]]*\])' AS JSON\),\s*(\d+)\)/g;
    const found = [];
    let m;
    while ((m = re.exec(SQL))) found.push({ type_key: m[1], length: Number(m[2]), surfaces: JSON.parse(m[3]), sort_order: Number(m[4]) });
    expect(found).toEqual(OPTIONS_SEED.map(({ type_key, length, surfaces, sort_order }) => ({ type_key, length, surfaces, sort_order })));
    expect(found).toHaveLength(13);
    expect(SQL).toMatch(/UNIQUE KEY uq_cto_type_length \(type_key, length\)/);
    expect(SQL).toMatch(/COLLATE utf8mb4_general_ci/);
    expect(SQL).toMatch(/SET default_length = 15\s+WHERE type_key = 'matrix_meeting' AND default_length = 30/);
  });

  test('every seeded type exists in the registry and is a meeting; 341 and test have no option', () => {
    const byKey = new Map(SEED.map((r) => [r.type_key, r]));
    for (const o of OPTIONS_SEED) {
      expect(byKey.has(o.type_key)).toBe(true);
      expect(byKey.get(o.type_key).kind).toBe('meeting');
    }
    expect(OPTIONS_SEED.some((o) => o.type_key === 'meeting_341')).toBe(false);
    expect(OPTIONS_SEED.some((o) => o.type_key === 'test')).toBe(false);
  });

  test('new_client / follow_up reproduce the 2026-09-02 dialog lists (in order) plus the ruled additions', async () => {
    const nc = keysAndLens(await calendarTypeService.listOptions({}, { surface: 'new_client' }));
    const fu = keysAndLens(await calendarTypeService.listOptions({}, { surface: 'follow_up' }));
    // Every entry the dialog had is present, and their relative order is
    // preserved — except schedules:20, which the old list appended last and
    // which now sits beside schedules:45 (deliberate; see the seed module).
    const relOrder = (list, subset) => list.filter((x) => subset.includes(x));
    const fuOld = DIALOG_LISTS_2026_09_02.follow_up.filter((x) => x !== 'schedules_meeting:20');
    expect(relOrder(nc, DIALOG_LISTS_2026_09_02.new_client)).toEqual(DIALOG_LISTS_2026_09_02.new_client);
    expect(relOrder(fu, fuOld)).toEqual(fuOld);
    expect(fu.indexOf('schedules_meeting:20')).toBe(fu.indexOf('schedules_meeting:45') + 1);
    // The additions are exactly the ruled set.
    expect(nc.filter((x) => !DIALOG_LISTS_2026_09_02.new_client.includes(x))).toEqual(['consultation:30', 'pre_lawsuit:30', 'tax_consult:30']);
    expect(fu.filter((x) => !DIALOG_LISTS_2026_09_02.follow_up.includes(x))).toEqual(['consultation:30', 'pre_lawsuit:30', 'tax_consult:30', 'meeting:15']);
  });
});
