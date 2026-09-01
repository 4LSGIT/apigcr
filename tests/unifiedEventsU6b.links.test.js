// tests/unifiedEventsU6b.links.test.js
//
/**
 * Unified Events U6b — the anchor pair is DERIVED, everywhere.
 *
 *   applyApptLinkPatch   the derivation rules themselves (§2.3): case wins;
 *                        blank case falls back to the client (patched, then
 *                        current); a client patch follows the link ONLY on a
 *                        contact-linked row; anything else touches nothing.
 *                        Reads the row only when it must.
 *   PATCH surfaces       routes/api.appts.js and update_appointment both run
 *                        the helper after the type patch and both REJECT the
 *                        raw columns through their unchanged allowlists.
 *   READ paths           caseEventService: query 3 grows the docket branch
 *                        (still THREE queries, params before from/to); a
 *                        docket-anchored appt buckets to its case and says
 *                        link_type/docket; case-linked rows keep the frozen
 *                        default shape. The list route's case_id filter
 *                        matches docket-anchored rows too.
 *
 * Run:  npx jest tests/unifiedEventsU6b.links.test.js
 */

'use strict';

jest.mock('../lib/auth.jwtOrApiKey', () => jest.fn((req, res, next) => { req.auth = { userId: 9 }; next(); }));

const express = require('express');
const calendarTypeService = require('../services/calendarTypeService');
const apptService = require('../services/apptService');
const caseEventService = require('../services/caseEventService');
const fns = require('../lib/internal_functions/appointments');
const router = require('../routes/api.appts');
const SEED = require('./fixtures/calendar_item_types.seed.json');

// ─────────────────────────────────────────────────────────────────────────────
// applyApptLinkPatch — the rules, against the real implementation
// ─────────────────────────────────────────────────────────────────────────────
function rowDb(row) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      const flat = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: flat, params });
      if (/^SELECT appt_client_id, appt_case_id, appt_link_type, appt_link_id FROM appts/.test(flat)) {
        return [row ? [{ ...row }] : []];
      }
      throw new Error('unexpected query: ' + flat);
    },
  };
}

describe('applyApptLinkPatch — the derivation rules (§2.3)', () => {
  test("appt_case_id non-blank → ('case', id); NO row read", async () => {
    const db = rowDb(null);
    const out = await apptService.applyApptLinkPatch(db, 5, { appt_case_id: 'NEWCASE1', appt_note: 'x' });
    expect(out).toEqual({ appt_case_id: 'NEWCASE1', appt_note: 'x', appt_link_type: 'case', appt_link_id: 'NEWCASE1' });
    expect(db.calls).toEqual([]);
  });

  test("appt_case_id → '' with a client IN THE SAME PATCH → ('contact', that client); still no row read", async () => {
    const db = rowDb(null);
    const out = await apptService.applyApptLinkPatch(db, 5, { appt_case_id: '', appt_client_id: 42 });
    expect([out.appt_link_type, out.appt_link_id]).toEqual(['contact', '42']);
    expect(db.calls).toEqual([]);
  });

  test("appt_case_id → '' with the client on the ROW → ('contact', row client); one row read", async () => {
    const db = rowDb({ appt_client_id: 77, appt_case_id: 'OLD', appt_link_type: 'case', appt_link_id: 'OLD' });
    const out = await apptService.applyApptLinkPatch(db, 5, { appt_case_id: '' });
    expect([out.appt_link_type, out.appt_link_id]).toEqual(['contact', '77']);
    expect(db.calls).toHaveLength(1);
  });

  test("appt_case_id → '' with no client anywhere → (NULL, NULL) — the unlinked held-slot shape", async () => {
    const db = rowDb({ appt_client_id: null, appt_case_id: 'OLD', appt_link_type: 'case', appt_link_id: 'OLD' });
    const out = await apptService.applyApptLinkPatch(db, 5, { appt_case_id: '' });
    expect([out.appt_link_type, out.appt_link_id]).toEqual([null, null]);
  });

  test('a client patch on a CONTACT-linked row follows the client', async () => {
    const db = rowDb({ appt_client_id: 77, appt_case_id: '', appt_link_type: 'contact', appt_link_id: '77' });
    const out = await apptService.applyApptLinkPatch(db, 5, { appt_client_id: 88 });
    expect([out.appt_link_type, out.appt_link_id]).toEqual(['contact', '88']);
  });

  test('clearing the client on a contact-linked row unlinks it', async () => {
    const db = rowDb({ appt_client_id: 77, appt_case_id: '', appt_link_type: 'contact', appt_link_id: '77' });
    const out = await apptService.applyApptLinkPatch(db, 5, { appt_client_id: null });
    expect([out.appt_link_type, out.appt_link_id]).toEqual([null, null]);
  });

  test('a client patch on a CASE-linked row changes the ATTENDEE, never the anchor (§3.6)', async () => {
    const db = rowDb({ appt_client_id: 77, appt_case_id: 'C1', appt_link_type: 'case', appt_link_id: 'C1' });
    const out = await apptService.applyApptLinkPatch(db, 5, { appt_client_id: 88 });
    expect(out).toEqual({ appt_client_id: 88 });   // no link keys added at all
  });

  test('a client patch on a DOCKET-anchored row leaves the docket anchor alone too', async () => {
    const db = rowDb({ appt_client_id: null, appt_case_id: '', appt_link_type: 'case_number', appt_link_id: '26-9' });
    const out = await apptService.applyApptLinkPatch(db, 5, { appt_client_id: 88 });
    expect(out).toEqual({ appt_client_id: 88 });
  });

  test('a patch touching neither anchor column touches nothing and reads nothing', async () => {
    const db = rowDb(null);
    const out = await apptService.applyApptLinkPatch(db, 5, { appt_note: 'hi', type_key: 'ss' });
    expect(out).toEqual({ appt_note: 'hi', type_key: 'ss' });
    expect(db.calls).toEqual([]);
  });

  test('the input object is never mutated', async () => {
    const db = rowDb(null);
    const fields = { appt_case_id: 'C9' };
    await apptService.applyApptLinkPatch(db, 5, fields);
    expect(fields).toEqual({ appt_case_id: 'C9' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The two PATCH surfaces
// ─────────────────────────────────────────────────────────────────────────────
function surfaceDb({ row = null } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      const flat = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: flat, params });
      if (/^SELECT appt_client_id, appt_case_id, appt_link_type, appt_link_id FROM appts/.test(flat)) {
        return [row ? [{ ...row }] : []];
      }
      if (/^UPDATE appts SET/.test(flat)) return [{ affectedRows: 1 }];
      throw new Error('unexpected query: ' + flat);
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
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { console.log.mockRestore(); console.error.mockRestore(); });

const patch = (id, body) => fetch(`${base}/api/appts/${id}`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

describe('PATCH /api/appts/:id — derives, and rejects the raw pair', () => {
  test('patching appt_case_id rewrites the pair in the SAME UPDATE', async () => {
    DB = surfaceDb();
    const res = await patch(31, { appt_case_id: 'NEWCASE1' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated_fields.sort()).toEqual(['appt_case_id', 'appt_link_id', 'appt_link_type']);
    const upd = DB.calls.find((c) => /^UPDATE appts SET/.test(c.sql));
    expect(upd.sql).toBe('UPDATE appts SET `appt_case_id` = ?, `appt_link_type` = ?, `appt_link_id` = ? WHERE appt_id = ?');
    expect(upd.params).toEqual(['NEWCASE1', 'case', 'NEWCASE1', 31]);
  });

  test("blanking appt_case_id falls back to the row's client", async () => {
    DB = surfaceDb({ row: { appt_client_id: 77, appt_case_id: 'OLD', appt_link_type: 'case', appt_link_id: 'OLD' } });
    const res = await patch(31, { appt_case_id: '' });
    expect(res.status).toBe(200);
    const upd = DB.calls.find((c) => /^UPDATE appts SET/.test(c.sql));
    expect(upd.params).toEqual(['', 'contact', '77', 31]);
  });

  test.each([['appt_link_type', 'case'], ['appt_link_id', 'X1']])(
    'a direct PATCH of %s is a 400 through the UNCHANGED allowlist',
    async (col, val) => {
      DB = surfaceDb();
      const res = await patch(31, { [col]: val });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toMatch(new RegExp(`Blocked columns: ${col}`));
      expect(DB.calls).toEqual([]);
    }
  );
});

describe('update_appointment — same derivation, same rejection', () => {
  test('patching appt_case_id rewrites the pair', async () => {
    const db = surfaceDb();
    const r = await fns.update_appointment({ appointment_id: 31, fields: { appt_case_id: 'NEWCASE1' } }, db);
    expect(r.output.updated_fields.sort()).toEqual(['appt_case_id', 'appt_link_id', 'appt_link_type']);
    const upd = db.calls.find((c) => /^UPDATE appts SET/.test(c.sql));
    expect(upd.params).toEqual(['NEWCASE1', 'case', 'NEWCASE1', 31]);
  });

  test('the raw pair is blocked by the allowlist (parity with the route)', async () => {
    const db = surfaceDb();
    await expect(fns.update_appointment({ appointment_id: 31, fields: { appt_link_type: 'case' } }, db))
      .rejects.toThrow(/blocked columns: appt_link_type/);
    expect(db.calls).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Read paths
// ─────────────────────────────────────────────────────────────────────────────
// Script-driven stub in the caseEventService.test.js shape: each query pops
// the next scripted result set.
function scriptDb(script) {
  const calls = [];
  let i = 0;
  return {
    calls,
    query: async (sql, params = []) => {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      const rows = script[i] !== undefined ? script[i] : [];
      i += 1;
      return [rows];
    },
  };
}

const CASE_A = { case_id: 'TYL6KJN8', case_number: '26-46639', case_number_full: '26-46639-mar' };

describe('caseEventService — the docket branch on query 3 (§2.4)', () => {
  test('still THREE queries; the appt query carries both branches, dockets bound BEFORE from/to', async () => {
    const db = scriptDb([[CASE_A], [], []]);
    await caseEventService.listForCase(db, 'TYL6KJN8', { from: '2026-09-01', to: '2026-09-30' });
    expect(db.calls).toHaveLength(3);
    const ap = db.calls[2];
    expect(ap.sql).toMatch(/a\.appt_case_id IN \(\?\)/);
    expect(ap.sql).toMatch(/a\.appt_link_type = 'case_number' AND a\.appt_link_id IN \(\?,\?\)/);
    expect(ap.sql).toMatch(/a\.appt_link_type, a\.appt_link_id/);          // SELECTed for bucketing
    expect(ap.params).toEqual(['TYL6KJN8', '26-46639', '26-46639-mar', '2026-09-01', '2026-09-30']);
    expect(ap.params.slice(-2)).toEqual(['2026-09-01', '2026-09-30']);     // the U3 pin, undisturbed
  });

  test('a case with no dockets queries appts on the case branch alone', async () => {
    const db = scriptDb([[{ case_id: 'B1', case_number: null, case_number_full: '' }], [], []]);
    await caseEventService.listForCase(db, 'B1');
    expect(db.calls[2].params).toEqual(['B1']);
    expect(db.calls[2].sql).not.toMatch(/case_number/);
  });

  test('a docket-anchored appt buckets to the case and carries link_type + docket', async () => {
    const db = scriptDb([[CASE_A], [], [{
      appt_id: 700, appt_case_id: '', appt_client_id: null, appt_type: '341 Meeting', type_key: 'meeting_341',
      appt_status: 'Scheduled', appt_date: '2026-09-14 10:00:00', appt_end: '2026-09-14 10:30:00',
      appt_length: 30, appt_platform: 'telephone', appt_with: 1,
      appt_link_type: 'case_number', appt_link_id: '26-46639',
    }]]);
    const rows = await caseEventService.listForCase(db, 'TYL6KJN8');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'appt', source_id: 700, case_id: 'TYL6KJN8',
      link_type: 'case_number', docket: '26-46639',
    });
  });

  test('a case-linked appt keeps the FROZEN default shape — no link keys at all', async () => {
    const db = scriptDb([[CASE_A], [], [{
      appt_id: 701, appt_case_id: 'TYL6KJN8', appt_client_id: 77, appt_type: 'Consultation', type_key: 'consultation',
      appt_status: 'Scheduled', appt_date: '2026-09-14 10:00:00', appt_end: null,
      appt_length: 30, appt_platform: 'Zoom', appt_with: 1,
      appt_link_type: 'case', appt_link_id: 'TYL6KJN8',
    }]]);
    const rows = await caseEventService.listForCase(db, 'TYL6KJN8');
    expect(Object.keys(rows[0])).not.toContain('link_type');
    expect(Object.keys(rows[0])).not.toContain('docket');
  });

  test('a docket shared by TWO cases fans the appt out to BOTH (same rule as events)', async () => {
    const db = scriptDb([
      [{ case_id: 'AAA', case_number: '26-9999', case_number_full: null },
       { case_id: 'BBB', case_number: '26-9999', case_number_full: null }],
      [],
      [{ appt_id: 702, appt_case_id: '', appt_client_id: null, appt_type: '341 Meeting', type_key: 'meeting_341',
         appt_status: 'Scheduled', appt_date: '2026-09-14 10:00:00', appt_end: null,
         appt_length: 30, appt_platform: 'telephone', appt_with: 1,
         appt_link_type: 'case_number', appt_link_id: '26-9999' }],
    ]);
    const byCase = await caseEventService.listForCases(db, ['AAA', 'BBB']);
    expect(byCase.get('AAA').map((r) => r.source_id)).toEqual([702]);
    expect(byCase.get('BBB').map((r) => r.source_id)).toEqual([702]);
  });
});

describe('GET /api/appts — the case_id filter matches docket-anchored rows', () => {
  function listDb({ caseRow, rows = [] }) {
    const calls = [];
    return {
      calls,
      query: async (sql, params = []) => {
        const flat = String(sql).replace(/\s+/g, ' ').trim();
        calls.push({ sql: flat, params });
        if (/^SELECT case_number, case_number_full FROM cases WHERE case_id = \?/.test(flat)) {
          return [caseRow ? [caseRow] : []];
        }
        if (/^SELECT COUNT\(\*\) AS counter/.test(flat)) return [[{ counter: rows.length }]];
        return [rows];
      },
    };
  }

  test('with dockets: one resolution read, then the OR filter on BOTH queries with identical params', async () => {
    DB = listDb({ caseRow: { case_number: '26-46639', case_number_full: '26-46639-mar' } });
    const res = await fetch(`${base}/api/appts?case_id=TYL6KJN8`);
    expect(res.status).toBe(200);
    const [resolve, rowsQ, countQ] = DB.calls;
    expect(resolve.sql).toMatch(/^SELECT case_number, case_number_full FROM cases/);
    const filter = /\(appts\.appt_case_id = \? OR \(appts\.appt_link_type = 'case_number' AND appts\.appt_link_id IN \(\?,\?\)\)\)/;
    expect(rowsQ.sql).toMatch(filter);
    expect(countQ.sql).toMatch(filter);
    expect(rowsQ.params.slice(0, 3)).toEqual(['TYL6KJN8', '26-46639', '26-46639-mar']);
    expect(countQ.params).toEqual(['TYL6KJN8', '26-46639', '26-46639-mar']);
  });

  test('no dockets (or no such case): the historical single-branch filter, no OR', async () => {
    DB = listDb({ caseRow: null });
    const res = await fetch(`${base}/api/appts?case_id=TYL6KJN8`);
    expect(res.status).toBe(200);
    const rowsQ = DB.calls[1];
    expect(rowsQ.sql).toMatch(/appts\.appt_case_id = \?/);
    expect(rowsQ.sql).not.toMatch(/appt_link_type/);
    expect(rowsQ.params.slice(0, 1)).toEqual(['TYL6KJN8']);
  });
});
