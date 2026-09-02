// tests/unifiedEventsU2b.admin.test.js
//
/**
 * Unified Events U2b — services/calendarTypeAdminService.js and
 * routes/api.calendarTypesAdmin.js, against scripted mysql2 stubs
 * (tests/pipelineAdminService.test.js idiom, scriptGuard-checked).
 *
 * Covers: list + refs + options shape; create validation (key regex, kind,
 * arrays, length, enum); resolver-collision 409 across key / label / alias;
 * alias == own label/key 400; ER_DUP_ENTRY → 409; type_key immutable;
 * kind locked by refs AND by options → 409; delete 409 when referenced,
 * cascades options at zero refs; option CRUD (meeting-only 400, surfaces
 * non-empty subset, length 1..1440, dup (type,length) 409, no cross-type
 * move); invalidate() called after every write.
 *
 * Run:  npx jest tests/unifiedEventsU2b.admin.test.js
 */

'use strict';

jest.mock('../lib/auth.jwtOrApiKey', () => jest.fn((req, res, next) => { req.auth = { userId: 9 }; next(); }));

const express = require('express');
const calendarTypeService = require('../services/calendarTypeService');
const svc = require('../services/calendarTypeAdminService');
const router = require('../routes/api.calendarTypesAdmin');
const { scriptGuard } = require('./helpers/scriptGuard');

function stubDb(script) {
  const calls = [];
  const guard = scriptGuard('stubDb', script);
  return {
    calls, guard,
    query: async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params: params || [] });
      if (!script.length) guard.overrun(sql);
      const entry = script.shift();
      if (typeof entry === 'function') return [entry(sql, params)];
      return [entry];
    },
  };
}

const TYPE_ROW = (over = {}) => ({
  type_key: 'ss', label: 'Strategy Session', kind: 'meeting', singleton: 0, blocks_default: 'attendee',
  client_attends: 1, default_length: 15, ingest_aliases: '[]', case_types: null, active: 1, sort_order: 20,
  created_at: '2026-09-01 00:00:00', updated_at: '2026-09-01 00:00:00', ...over,
});
const OPT_ROW = (over = {}) => ({
  id: 5, type_key: 'ss', label: null, length: 15, surfaces: '["new_client","follow_up"]', sort_order: 10, active: 1,
  created_at: null, updated_at: null, ...over,
});
// getRefs UNION result
const REFS = (events = 0, appts = 0, booking_views = 0, ai_match_types = 0) => [
  { src: 'events', n: events }, { src: 'appts', n: appts }, { src: 'booking_views', n: booking_views }, { src: 'ai_match_types', n: ai_match_types },
];
// getTypeAdmin = [type row], [refs union], [options]
const GET_TYPE = (typeOver = {}, refs = REFS(), opts = []) => [[TYPE_ROW(typeOver)], refs, opts];
const OTHERS = [
  { type_key: 'iss', label: 'Initial Strategy Session', ingest_aliases: '["Intial Strategy Session"]' },
  { type_key: 'meeting', label: 'Meeting', ingest_aliases: '["Case Status Review"]' },
];

let invalidateSpy;
beforeEach(() => { invalidateSpy = jest.spyOn(calendarTypeService, 'invalidate'); });
afterEach(() => invalidateSpy.mockRestore());

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

describe('listTypesAdmin', () => {
  test('rows carry refs (4 grouped queries) and options, in registry order', async () => {
    const db = stubDb([
      [TYPE_ROW(), TYPE_ROW({ type_key: 'hearing', label: 'Hearing', kind: 'hearing', sort_order: 220 })],
      [{ k: 'hearing', n: 3 }],   // events
      [{ k: 'ss', n: 276 }],       // appts
      [],                          // booking_views
      [{ k: 'hearing', n: 1 }],    // ai_match_types
      [OPT_ROW(), OPT_ROW({ id: 6, length: 30, sort_order: 20 })],
    ]);
    const rows = await svc.listTypesAdmin(db);
    expect(rows.map((r) => r.type_key)).toEqual(['ss', 'hearing']);
    expect(rows[0].refs).toEqual({ events: 0, appts: 276, booking_views: 0, ai_match_types: 0, total: 276 });
    expect(rows[1].refs).toEqual({ events: 3, appts: 0, booking_views: 0, ai_match_types: 1, total: 4 });
    expect(rows[0].options.map((o) => o.length)).toEqual([15, 30]);
    expect(rows[0].options[0].surfaces).toEqual(['new_client', 'follow_up']);
    expect(rows[1].options).toEqual([]);
    expect(rows[0]).not.toHaveProperty('surfaces');
    expect(db.calls[1].sql).toMatch(/FROM events WHERE type_key IS NOT NULL GROUP BY type_key/);
    expect(db.calls[4].sql).toMatch(/FROM ai_match_types WHERE item_type IS NOT NULL GROUP BY item_type/);
  });

  test('getTypeAdmin 404 on unknown key', async () => {
    await expect(svc.getTypeAdmin(stubDb([[]]), 'nope')).rejects.toMatchObject({ status: 404 });
  });

  test('listUnmapped: events kind=other + appts, ids numeric', async () => {
    const db = stubDb([
      [{ id: 156, label: 'Mediation', date: '2026-08-31', link_type: null, link_id: null }],
      [{ id: 1809, label: null, date: '2024-05-01', case_id: 9, contact_id: 2, status: 'Scheduled' }],
    ]);
    const out = await svc.listUnmapped(db);
    expect(out.events[0]).toMatchObject({ id: 156, label: 'Mediation' });
    expect(out.appts[0]).toMatchObject({ id: 1809, status: 'Scheduled' });
    expect(db.calls[0].sql).toMatch(/type_key IS NULL AND kind = 'other'/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createType
// ─────────────────────────────────────────────────────────────────────────────

describe('createType', () => {
  const body = { type_key: 'mediation', label: 'Mediation', kind: 'conference', ingest_aliases: ['Mediation Session'], case_types: ['Civil Litigation'] };

  test('happy path: validated INSERT (JSON columns stringified), invalidate, returns the row', async () => {
    const db = stubDb([
      OTHERS,                                    // loadOthers
      { insertId: 0 },                           // INSERT
      ...GET_TYPE({ type_key: 'mediation', label: 'Mediation', kind: 'conference', ingest_aliases: '["Mediation Session"]', case_types: '["Civil Litigation"]' }),
    ]);
    const row = await svc.createType(db, body);
    expect(row.type_key).toBe('mediation');
    expect(row.refs.total).toBe(0);
    const ins = db.calls[1];
    expect(ins.sql).toMatch(/INSERT INTO calendar_item_types/);
    expect(ins.sql).not.toMatch(/surfaces/);
    expect(ins.params).toEqual(['mediation', 'Mediation', 'conference', 0, 'attendee', 0, null, '["Mediation Session"]', '["Civil Litigation"]', 1, 0]);
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  test.each([
    [{ ...body, type_key: 'Mediation' },          /type_key must match/],
    [{ ...body, type_key: '1med' },               /type_key must match/],
    [{ ...body, type_key: 'a' },                  /type_key must match/],
    [{ ...body, label: '' },                      /label is required/],
    [{ ...body, label: 'x'.repeat(81) },          /80 characters/],
    [{ ...body, kind: 'appointment' },            /kind must be one of/],
    [{ ...body, blocks_default: 'everyone' },     /blocks_default must be one of/],
    [{ ...body, default_length: 1441 },           /between 0 and 1440/],
    [{ ...body, default_length: 'abc' },          /between 0 and 1440/],
    [{ ...body, ingest_aliases: 'Mediation' },    /must be an array of strings/],
    [{ ...body, case_types: [''] },               /blank entries/],
    [{ ...body, singleton: 'yes' },               /singleton must be 0 or 1/],
    [{ ...body, sort_order: 1.5 },                /sort_order must be an integer/],
  ])('400 validation: %j', async (bad, re) => {
    await expect(svc.createType(stubDb([]), bad)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(re) });
  });

  test('400 when an alias duplicates the row\u2019s own label or key (D5)', async () => {
    await expect(svc.createType(stubDb([OTHERS]), { ...body, ingest_aliases: ['mediation '] }))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/own label|own type_key/) });
  });

  test.each([
    ['label vs another label', { ...body, label: 'initial strategy session' },          /label .* already claimed as the label of 'iss'/],
    ['alias vs another alias', { ...body, ingest_aliases: ['case status review'] },     /alias .* already claimed as the alias of 'meeting'/],
    ['label vs another alias', { ...body, label: 'Intial Strategy Session' },           /already claimed as the alias of 'iss'/],
    ['key vs another label',   { ...body, type_key: 'meeting' },                        /key .* already claimed/],
  ])('409 resolver collision: %s', async (_n, bad, re) => {
    // 'key vs another label' collides with OTHERS[1].type_key='meeting' before hitting the DB unique — loadOthers
    // excludes the row's own key, so we hand it a copy that still contains 'meeting' under a different key.
    const others = bad.type_key === 'meeting'
      ? [{ type_key: 'mtg', label: 'Meeting', ingest_aliases: '[]' }]
      : OTHERS;
    await expect(svc.createType(stubDb([others]), bad)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(re) });
  });

  test('ER_DUP_ENTRY on insert → 409', async () => {
    const db = stubDb([OTHERS, () => { const e = new Error('dup'); e.code = 'ER_DUP_ENTRY'; throw e; }]);
    await expect(svc.createType(db, body)).rejects.toMatchObject({ status: 409, message: /already exists/ });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// updateType
// ─────────────────────────────────────────────────────────────────────────────

describe('updateType', () => {
  test('partial update: only given fields in SET, label collision re-checked, invalidate', async () => {
    const db = stubDb([
      ...GET_TYPE({}, REFS(0, 276), [OPT_ROW()]),
      OTHERS,                       // loadOthers (label in patch)
      { affectedRows: 1 },          // UPDATE
      ...GET_TYPE({ label: 'Strategy Call', default_length: 20 }, REFS(0, 276), [OPT_ROW()]),
    ]);
    const row = await svc.updateType(db, 'ss', { label: 'Strategy Call', default_length: 20, surfaces: ['new_client'] });
    expect(row.label).toBe('Strategy Call');
    const upd = db.calls[4];
    expect(upd.sql).toBe('UPDATE calendar_item_types SET label = ?, default_length = ? WHERE type_key = ?');
    expect(upd.params).toEqual(['Strategy Call', 20, 'ss']);
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  test('type_key in the body that differs → 409 (immutable)', async () => {
    await expect(svc.updateType(stubDb([]), 'ss', { type_key: 'ss2', label: 'x' })).rejects.toMatchObject({ status: 409, message: /immutable/ });
  });

  test('kind change → 409 when referenced (message names the counts)', async () => {
    const db = stubDb(GET_TYPE({}, REFS(0, 276)));
    await expect(svc.updateType(db, 'ss', { kind: 'conference' })).rejects.toMatchObject({ status: 409, message: /kind is locked: 276 row/ });
  });

  test('kind change → 409 when options exist even at zero refs', async () => {
    const db = stubDb(GET_TYPE({}, REFS(), [OPT_ROW()]));
    await expect(svc.updateType(db, 'ss', { kind: 'conference' })).rejects.toMatchObject({ status: 409, message: /picker option/ });
  });

  test('kind change allowed at zero refs and zero options', async () => {
    const db = stubDb([...GET_TYPE(), { affectedRows: 1 }, ...GET_TYPE({ kind: 'conference' })]);
    const row = await svc.updateType(db, 'ss', { kind: 'conference' });
    expect(row.kind).toBe('conference');
    expect(db.calls[3].params).toEqual(['conference', 'ss']);
  });

  test('empty patch → 400; unknown key → 404', async () => {
    await expect(svc.updateType(stubDb(GET_TYPE()), 'ss', { surfaces: ['x'] })).rejects.toMatchObject({ status: 400, message: /No updatable fields/ });
    await expect(svc.updateType(stubDb([[]]), 'nope', { label: 'x' })).rejects.toMatchObject({ status: 404 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deleteType
// ─────────────────────────────────────────────────────────────────────────────

describe('deleteType', () => {
  test('409 when referenced; nothing deleted; no invalidate', async () => {
    await expect(svc.deleteType(stubDb(GET_TYPE({}, REFS(1))), 'ss')).rejects.toMatchObject({ status: 409, message: /Deactivate it instead/ });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  test('zero refs: deletes options then the type, invalidates', async () => {
    const db = stubDb([...GET_TYPE({}, REFS(), [OPT_ROW(), OPT_ROW({ id: 6 })]), { affectedRows: 2 }, { affectedRows: 1 }]);
    const out = await svc.deleteType(db, 'ss');
    expect(out).toEqual({ type_key: 'ss', deleted: true, options_deleted: 2 });
    expect(db.calls[3].sql).toBe('DELETE FROM calendar_type_options WHERE type_key = ?');
    expect(db.calls[4].sql).toBe('DELETE FROM calendar_item_types WHERE type_key = ?');
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────────────

describe('options', () => {
  test('createOption: meeting type, validated INSERT, invalidate, returns row', async () => {
    const db = stubDb([
      [{ type_key: 'ss', kind: 'meeting' }],
      { insertId: 9 },
      [OPT_ROW({ id: 9, length: 30, surfaces: '["follow_up"]', label: 'Long SS' })],
    ]);
    const o = await svc.createOption(db, 'ss', { length: '30', surfaces: ['follow_up', 'FOLLOW_UP'], label: ' Long SS ' });
    expect(o).toMatchObject({ id: 9, type_key: 'ss', length: 30, surfaces: ['follow_up'], label: 'Long SS' });
    expect(db.calls[1].params).toEqual(['ss', 'Long SS', 30, '["follow_up"]', 0, 1]);
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  test('createOption: 404 unknown type; 400 non-meeting type', async () => {
    await expect(svc.createOption(stubDb([[]]), 'nope', { length: 15, surfaces: ['follow_up'] })).rejects.toMatchObject({ status: 404 });
    await expect(svc.createOption(stubDb([[{ type_key: 'hearing', kind: 'hearing' }]]), 'hearing', { length: 15, surfaces: ['follow_up'] }))
      .rejects.toMatchObject({ status: 400, message: /meeting types only/ });
  });

  test.each([
    [{ length: 0, surfaces: ['follow_up'] },        /length must be an integer between 1 and 1440/],
    [{ length: 15, surfaces: [] },                  /at least one of/],
    [{ length: 15 },                                /at least one of/],
    [{ length: 15, surfaces: ['staff_event'] },     /unknown "staff_event"/],
    [{ length: 15, surfaces: ['follow_up'], label: 'x'.repeat(81) }, /80 characters/],
  ])('createOption 400: %j', async (bad, re) => {
    await expect(svc.createOption(stubDb([[{ type_key: 'ss', kind: 'meeting' }]]), 'ss', bad))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(re) });
  });

  test('createOption: duplicate (type, length) → 409', async () => {
    const db = stubDb([[{ type_key: 'ss', kind: 'meeting' }], () => { const e = new Error('dup'); e.code = 'ER_DUP_ENTRY'; throw e; }]);
    await expect(svc.createOption(db, 'ss', { length: 15, surfaces: ['follow_up'] })).rejects.toMatchObject({ status: 409, message: /already has a 15-minute option/ });
  });

  test('updateOption: partial SET, surfaces stringified, invalidate; type_key move → 409', async () => {
    const db = stubDb([[OPT_ROW()], { affectedRows: 1 }, [OPT_ROW({ surfaces: '["follow_up"]', active: 0 })]]);
    const o = await svc.updateOption(db, '5', { surfaces: ['follow_up'], active: 0 });
    expect(o).toMatchObject({ surfaces: ['follow_up'], active: 0 });
    expect(db.calls[1].sql).toBe('UPDATE calendar_type_options SET surfaces = ?, active = ? WHERE id = ?');
    expect(db.calls[1].params).toEqual(['["follow_up"]', 0, 5]);
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    await expect(svc.updateOption(stubDb([[OPT_ROW()]]), 5, { type_key: 'iss' })).rejects.toMatchObject({ status: 409, message: /cannot move between types/ });
    await expect(svc.updateOption(stubDb([]), 'abc', { active: 1 })).rejects.toMatchObject({ status: 400 });
  });

  test('deleteOption: DELETE by id, invalidate', async () => {
    const db = stubDb([[OPT_ROW()], { affectedRows: 1 }]);
    expect(await svc.deleteOption(db, 5)).toEqual({ id: 5, type_key: 'ss', deleted: true });
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Route mapping
// ─────────────────────────────────────────────────────────────────────────────

describe('routes/api.calendarTypesAdmin', () => {
  let server, base, dbHolder = { db: null };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.db = dbHolder.db; next(); });
  app.use(router);
  beforeAll(async () => {
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => new Promise((resolve) => server.close(resolve)));
  const call = (path, method = 'GET', body) => fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body),
  });

  test('GET list → { status, types[] }', async () => {
    dbHolder.db = stubDb([[TYPE_ROW()], [], [], [], [], []]);
    const body = await (await call('/api/calendar-types-admin')).json();
    expect(body.status).toBe('success');
    expect(body.types[0]).toMatchObject({ type_key: 'ss', refs: { total: 0 }, options: [] });
  });

  test('static sub-paths are not shadowed by :type_key', async () => {
    dbHolder.db = stubDb([[], []]);
    const um = await (await call('/api/calendar-types-admin/unmapped')).json();
    expect(um).toMatchObject({ status: 'success', events: [], appts: [], total: 0 });
    dbHolder.db = stubDb([[{ case_type: 'Bankruptcy', n: 996 }]]);
    const ct = await (await call('/api/calendar-types-admin/case-types')).json();
    expect(ct.case_types).toEqual([{ case_type: 'Bankruptcy', cases: 996 }]);
  });

  test('service statuses map through: 400 / 404 / 409 / 201; 500 is generic', async () => {
    dbHolder.db = stubDb([]);
    expect((await call('/api/calendar-types-admin', 'POST', { type_key: 'BAD' })).status).toBe(400);
    dbHolder.db = stubDb([[]]);
    expect((await call('/api/calendar-types-admin/nope')).status).toBe(404);
    dbHolder.db = stubDb(GET_TYPE({}, REFS(1)));
    expect((await call('/api/calendar-types-admin/ss', 'DELETE')).status).toBe(409);
    dbHolder.db = stubDb([[{ type_key: 'ss', kind: 'meeting' }], { insertId: 9 }, [OPT_ROW({ id: 9 })]]);
    const created = await call('/api/calendar-types-admin/ss/options', 'POST', { length: 15, surfaces: ['follow_up'] });
    expect(created.status).toBe(201);
    expect((await created.json()).option.id).toBe(9);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    dbHolder.db = { query: async () => { throw new Error('db down'); } };
    const r = await call('/api/calendar-types-admin');
    expect(r.status).toBe(500);
    expect((await r.json()).message).toBe('Calendar type admin request failed');
    console.error.mockRestore();
  });
});
