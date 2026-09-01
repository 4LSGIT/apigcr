// tests/apptTypeKey.patch.test.js
//
/**
 * Unified Events U2 — the two raw-SET appt update surfaces write type_key.
 *
 *   routes/api.appts.js  PATCH /api/appts/:id
 *   lib/internal_functions/appointments.js  update_appointment
 *
 * Both build a SET from an allowlist. Assertions:
 *   - appt_type in the patch, no type_key → type_key resolved and ADDED to the SET
 *   - type_key given → validated against the registry; unknown → 400 (route)
 *     / thrown Error with .status 400 (internal fn; internal functions surface
 *     errors by message — workflow_execution_steps.error_message — so the
 *     status is informational there)
 *   - the two ALLOWED sets are EQUAL (parsed from the two source files, so a
 *     change to one without the other fails here)
 *
 * Registry cache PRIMED from the seed fixture (R1.3); the db stub records the
 * UPDATE it receives.
 *
 * Run:  npx jest tests/apptTypeKey.patch.test.js
 */

'use strict';

jest.mock('../lib/auth.jwtOrApiKey', () => jest.fn((req, res, next) => { req.auth = { userId: 9 }; next(); }));
jest.mock('../services/apptService', () => ({}));   // the PATCH route does not touch the service

const fs      = require('fs');
const path    = require('path');
const express = require('express');
const calendarTypeService = require('../services/calendarTypeService');
const SEED    = require('./fixtures/calendar_item_types.seed.json');
const router  = require('../routes/api.appts');
const fns     = require('../lib/internal_functions/appointments');

function makeDb() {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      if (/^UPDATE appts SET/.test(sql)) return [{ affectedRows: 1 }];
      throw new Error('unexpected query: ' + sql);
    },
  };
}

let DB;
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.db = DB; next(); });
app.use(router);

let server, base;
beforeAll(async () => {
  calendarTypeService._primeCache(SEED);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  calendarTypeService.invalidate();
  await new Promise((resolve) => server.close(resolve));
});
beforeEach(() => {
  DB = makeDb();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { console.log.mockRestore(); console.warn.mockRestore(); console.error.mockRestore(); });

const patch = (id, body) => fetch(`${base}/api/appts/${id}`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const setCols = (sql) => [...sql.matchAll(/`(\w+)` = \?/g)].map((m) => m[1]);

// ─────────────────────────────────────────────────────────────────────────────
describe('PATCH /api/appts/:id', () => {
  test('appt_type alone → type_key resolved and added to the SET', async () => {
    const res = await patch(5, { appt_type: 'Pre-filing Meeting', appt_note: 'hi' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated_fields).toEqual(['appt_type', 'appt_note', 'type_key']);
    const upd = DB.calls[0];
    expect(setCols(upd.sql)).toEqual(['appt_type', 'appt_note', 'type_key']);
    expect(upd.params).toEqual(['Pre-filing Meeting', 'hi', 'pre_filing', 5]);
  });

  test('a valid type_key is accepted (canonicalized) and written', async () => {
    const res = await patch(5, { type_key: 'ISS' });
    expect(res.status).toBe(200);
    expect(DB.calls[0].params).toEqual(['iss', 5]);
  });

  test('an unknown type_key → 400 and NO UPDATE', async () => {
    const res = await patch(5, { type_key: 'bogus' });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe('PATCH /api/appts: unknown type_key "bogus"');
    expect(DB.calls).toEqual([]);
  });

  test('an unknown label → type_key NULL written (raw passthrough)', async () => {
    const res = await patch(5, { appt_type: 'Mediation' });
    expect(res.status).toBe(200);
    expect(DB.calls[0].params).toEqual(['Mediation', null, 5]);
  });

  test('a patch without type fields is untouched', async () => {
    const res = await patch(5, { appt_note: 'x' });
    expect(res.status).toBe(200);
    expect(setCols(DB.calls[0].sql)).toEqual(['appt_note']);
  });

  test('blocked columns are still rejected before any resolution', async () => {
    const res = await patch(5, { appt_id: 1, type_key: 'iss' });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/Blocked columns: appt_id/);
    expect(DB.calls).toEqual([]);
  });

  test('a non-status error still maps to the generic 500', async () => {
    DB.query = async () => { throw new Error('boom'); };
    const res = await patch(5, { appt_note: 'x' });
    expect(res.status).toBe(500);
    expect((await res.json()).message).toBe('Failed to update appointment');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('update_appointment (internal function)', () => {
  test('appt_type alone → type_key resolved and added to the SET', async () => {
    const db = makeDb();
    const r = await fns.update_appointment({ appointment_id: 7, fields: { appt_type: '341 Meeting' } }, db);
    expect(r.output.updated_fields).toEqual(['appt_type', 'type_key']);
    expect(db.calls[0].params).toEqual(['341 Meeting', 'meeting_341', 7]);
  });

  test('unknown type_key → throws with status 400 and NO UPDATE', async () => {
    const db = makeDb();
    await expect(fns.update_appointment({ appointment_id: 7, fields: { type_key: 'bogus' } }, db))
      .rejects.toMatchObject({ status: 400, message: 'update_appointment: unknown type_key "bogus"' });
    expect(db.calls).toEqual([]);
  });

  test('type_key is an allowed column; kind is not a column on appts and is blocked', async () => {
    const db = makeDb();
    await expect(fns.update_appointment({ appointment_id: 7, fields: { kind: 'meeting' } }, db))
      .rejects.toThrow(/blocked columns: kind/);
    await fns.update_appointment({ appointment_id: 7, fields: { type_key: 'ss' } }, db);
    expect(db.calls[0].params).toEqual(['ss', 7]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the two allowlists are identical (comment says they mirror — this keeps it true)', () => {
  function allowedFrom(file) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const m = /const ALLOWED = new Set\(\[([\s\S]*?)\]\);/.exec(src);
    expect(m).not.toBeNull();
    return new Set([...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));
  }
  test('routes/api.appts.js === lib/internal_functions/appointments.js', () => {
    const a = allowedFrom('routes/api.appts.js');
    const b = allowedFrom('lib/internal_functions/appointments.js');
    expect([...a].sort()).toEqual([...b].sort());
    expect(a.has('type_key')).toBe(true);
    expect(a.has('kind')).toBe(false);
    expect(a.size).toBe(14);
  });
});
