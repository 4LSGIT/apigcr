/**
 * The booking channel moves with the booking (Fred, 2026-11-25).
 *
 * A reschedule / rebook successor used to carry appt_view_id but NOT
 * appt_source (live: calendly appt 4012 → successor 4014, NULL). Now:
 *   services/apptService.rescheduleAppt   → createAppt({ appt_source: oldAppt.appt_source })
 *   routes/manage.js  POST /api/m/:token/reschedule, Canceled branch (rebook)
 *                                         → createAppt({ appt_source: appt.appt_source })
 *   and loadApptByToken's SELECT names a.appt_source (the rebook copy reads
 *   the loaded row, so a column missing from the SELECT is a silent NULL).
 *
 * Part 1 drives the REAL rescheduleAppt over the lineage-style db stub and
 * reads the successor's INSERT bind and the view hook's `source`.
 * Part 2 mounts the REAL manage router on a listening app, apptService
 * mocked at the service boundary; the db stub PROJECTS the loaded row to the
 * columns the SELECT actually names, so a dropped `a.appt_source` is a NULL
 * on the rebook call, not a stub row that happens to carry it.
 *
 * Run:  npx jest tests/apptSourceCarry.test.js
 */
'use strict';

process.env.CREDENTIALS_ENCRYPTION_KEY = process.env.CREDENTIALS_ENCRYPTION_KEY || 'x'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'appt-source-carry-test-secret';

const fs = require('fs');
const path = require('path');

// ─── Part 1: the real rescheduleAppt ────────────────────────────────────────
describe('rescheduleAppt → the successor carries the original\'s appt_source', () => {
  let apptService, hookService, calendarTypeService;
  beforeAll(() => {
    jest.resetModules();
    jest.doMock('../services/settingsService', () => ({ getSettings: jest.fn(async () => ({})) }));
    jest.doMock('../services/phoneService', () => ({ sendSms: jest.fn(async () => ({})) }));
    jest.doMock('../services/emailService', () => ({ sendEmail: jest.fn(async () => ({})) }));
    jest.doMock('../services/gcalService', () => ({
      createEvent: jest.fn(async () => ({ id: 'gcal-evt-1' })), deleteEvent: jest.fn(async () => ({})),
      _resolveTarget: jest.fn(async () => ({ calendarId: 'firm@example.com' })),
    }));
    jest.doMock('../services/taskService', () => ({ createTask: jest.fn(async () => ({ task_id: 1 })) }));
    jest.doMock('../services/logService', () => ({ createLogEntry: jest.fn(async () => ({ log_id: 1 })) }));
    jest.doMock('../services/resolverService', () => ({ resolve: jest.fn(async (s) => s) }));
    jest.doMock('../lib/sequenceEngine', () => ({
      cancelSequences: jest.fn(async () => ({})), cancelByApptId: jest.fn(async () => ({})), enrollContact: jest.fn(async () => ({})),
    }));
    jest.doMock('../services/hookService', () => ({ executeHook: jest.fn(async () => ({})) }));
    jest.doMock('../lib/domainEvents', () => ({
      emit: jest.fn(() => Promise.resolve()), buildChanges: jest.fn(() => ({})), runAsAction: (_r, fn) => fn(), MAX_DEPTH: 4,
    }));
    jest.doMock('../lib/alerting', () => ({ alert: jest.fn(() => Promise.resolve()) }));
    apptService = require('../services/apptService');
    hookService = require('../services/hookService');
    calendarTypeService = require('../services/calendarTypeService');
    calendarTypeService._primeCache(require('./fixtures/calendar_item_types.seed.json'));
  });
  afterAll(() => calendarTypeService.invalidate());
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  const VIEWS = { 7: { slug: 'bk-consult', source_tag: null, hook_id: 30 } };
  function makeDb(seed) {
    const rows = new Map(seed.map((r) => [Number(r.appt_id), { ...r }]));
    const inserts = [];
    let next = 900;
    const handler = async (sql, params = []) => {
      const flat = String(sql).replace(/\s+/g, ' ').trim();
      if (/^INSERT INTO appts/i.test(flat)) {
        const id = ++next;
        inserts.push({ sql: flat, params });
        rows.set(id, { appt_id: id, appt_client_id: params[0], appt_status: 'Scheduled', appt_source: params[9], appt_view_id: params[12], rescheduled_from_appt_id: params[13] });
        return [{ insertId: id, affectedRows: 1 }];
      }
      if (/^SELECT \* FROM appts WHERE appt_id/i.test(flat)) { const r = rows.get(Number(params[0])); return [r ? [r] : []]; }
      if (/^SELECT appt_client_id, appt_case_id, appt_type, appt_date/i.test(flat)) { const r = rows.get(Number(params[0])); return [r ? [r] : []]; }
      if (/^UPDATE appts SET appt_status = 'Rescheduled'/i.test(flat)) { const r = rows.get(Number(params[1])); if (r) r.appt_status = 'Rescheduled'; return [{ affectedRows: 1 }]; }
      if (/^UPDATE appts SET appt_gcal(_user)? = \?/i.test(flat)) return [{ affectedRows: 1 }];
      if (/^SELECT user_gcal_id FROM users/i.test(flat)) return [[]];
      if (/^SELECT contact_name, contact_email FROM contacts/i.test(flat)) return [[{ contact_name: 'C', contact_email: 'c@example.test' }]];
      if (/^SELECT slug, source_tag, hook_id FROM booking_views WHERE id = \?/i.test(flat)) { const v = VIEWS[Number(params[0])]; return [v ? [{ ...v }] : []]; }
      if (/^SELECT slug FROM hooks WHERE id = \? AND active = 1/i.test(flat)) return [[{ slug: 'booking-hook' }]];
      return [[]];
    };
    const conn = { query: handler, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {}, destroy: () => {} };
    return { rows, inserts, query: handler, getConnection: async () => conn, withTransaction: async (fn) => fn(conn) };
  }
  // Column position ≠ bind position: appt_status is a literal 'Scheduled' and
  // appt_create_date NOW() — count the `?` placeholders before the column.
  const bindIndexOf = (sql, col) => {
    const cols = /\(([^)]*)\) VALUES/i.exec(sql)[1].split(',').map((c) => c.trim());
    const vals = /VALUES \(([^)]*)\)/i.exec(sql)[1].split(',').map((c) => c.trim());
    const i = cols.indexOf(col); if (i < 0) throw new Error(col + ' not a column');
    if (vals[i] !== '?') throw new Error(col + ' is not bound');
    return vals.slice(0, i).filter((v) => v === '?').length;
  };
  const old = (over) => ({ appt_id: 501, appt_client_id: 77, appt_case_id: '', appt_type: 'Consultation', type_key: 'consultation', appt_length: 30,
    appt_platform: 'Zoom', appt_date: '2026-09-01 10:00:00', appt_status: 'Scheduled', appt_with: 1, appt_note: '', appt_gcal: '', appt_gcal_user: null,
    appt_view_id: 7, appt_link_type: null, appt_link_id: null, rescheduled_from_appt_id: null, ...over });
  const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

  test.each([['bk-consult:ditchurdebt'], ['calendly'], ['test-consult']])('a %s row → the successor INSERT binds the same value', async (v) => {
    const db = makeDb([old({ appt_source: v })]);
    const r = await apptService.rescheduleAppt(db, { appt_id: 501, newDate: '2026-09-10 14:00' });
    expect(db.inserts).toHaveLength(1);
    const ins = db.inserts[0];
    expect(ins.params[bindIndexOf(ins.sql, 'appt_source')]).toBe(v);
    expect(ins.params[bindIndexOf(ins.sql, 'rescheduled_from_appt_id')]).toBe(501);
    expect(db.rows.get(r.new_appt_id).appt_source).toBe(v);
  });

  test('a NULL row stays NULL — never "" or the view\'s slug', async () => {
    const db = makeDb([old({ appt_source: null })]);
    await apptService.rescheduleAppt(db, { appt_id: 501, newDate: '2026-09-10 14:00' });
    const ins = db.inserts[0];
    expect(ins.params[bindIndexOf(ins.sql, 'appt_source')]).toBeNull();
  });

  test('the successor\'s view hook reports the carried value, not the view\'s tag', async () => {
    const db = makeDb([old({ appt_source: 'bk-consult:ditchurdebt' })]);
    await apptService.rescheduleAppt(db, { appt_id: 501, newDate: '2026-09-10 14:00' });
    await flush();
    const payloads = hookService.executeHook.mock.calls.map((c) => c[2]);
    expect(payloads).toEqual([expect.objectContaining({ event: 'rescheduled', rescheduled_from: 501, source: 'bk-consult:ditchurdebt' })]);
  });

  test('the original row is untouched beyond its status (appt_source not cleared, not rewritten)', async () => {
    const db = makeDb([old({ appt_source: 'calendly' })]);
    await apptService.rescheduleAppt(db, { appt_id: 501, newDate: '2026-09-10 14:00' });
    expect(db.rows.get(501)).toMatchObject({ appt_status: 'Rescheduled', appt_source: 'calendly' });
  });
});

// ─── Part 2: the manage route's rebook copy ─────────────────────────────────
describe('POST /api/m/:token/reschedule on a Canceled appt (rebook) → createAppt carries appt_source', () => {
  let server, base, apptService, lastSelect;
  const TOKEN = 'a'.repeat(32);
  const tomorrow10 = () => {
    const { DateTime } = require('luxon');
    return DateTime.now().setZone('America/Detroit').plus({ days: 1 }).set({ hour: 10, minute: 0 }).toFormat('yyyy-MM-dd HH:mm');
  };
  let apptRow;
  // Project the stored row to the columns the SELECT names as `a.<col>` — the
  // way a real SELECT behaves. A column dropped from the SQL is absent here.
  function project(sql, row) {
    const cols = [...String(sql).matchAll(/\ba\.([a-z_]+)/g)].map((m) => m[1]);
    const out = {};
    for (const c of cols) if (c in row) out[c] = row[c];
    out.appt_start = row.appt_date;
    out.contact_fname = 'C'; out.user_real_name = 'Stuart'; out.user_name = 'ss';
    return out;
  }
  function makeDb() {
    const handler = async (sql, params = []) => {
      const flat = String(sql).replace(/\s+/g, ' ').trim();
      if (/FROM appts a .*WHERE a\.appt_manage_token = \?/i.test(flat)) { lastSelect = flat; return [params[0] === TOKEN ? [project(flat, apptRow)] : []]; }
      if (/^SELECT GET_LOCK/i.test(flat)) return [[{ lockAcquired: 1 }]];
      if (/^SELECT RELEASE_LOCK/i.test(flat)) return [[{ r: 1 }]];
      if (/^SELECT appt_status FROM appts WHERE appt_id/i.test(flat)) return [[{ appt_status: apptRow.appt_status }]];
      if (/^SELECT appt_manage_token FROM appts/i.test(flat)) return [[{ appt_manage_token: 'b'.repeat(32) }]];
      throw new Error('unrouted SQL: ' + flat.slice(0, 80));
    };
    const conn = { query: handler, release: () => {} };
    return { query: handler, getConnection: async () => conn };
  }

  beforeAll(async () => {
    jest.resetModules();
    jest.doMock('../services/availabilityService', () => ({ getSlots: jest.fn(async (_c, { providerIds }) => ({ [providerIds[0]]: [tomorrow10()] })) }));
    jest.doMock('../services/apptService', () => ({
      createAppt: jest.fn(async () => ({ appt_id: 777 })),
      rescheduleAppt: jest.fn(async () => ({ new_appt_id: 778 })),
      insertApptLog: jest.fn(async () => ({})),
      cancelAppt: jest.fn(async () => ({})),
    }));
    jest.doMock('../services/settingsService', () => ({ getSettings: jest.fn(async () => ({
      manage_allow_cancel: '1', manage_allow_reschedule: '1', manage_allow_rebook: '1', manage_cutoff_min: '0', manage_horizon_days: '30',
    })) }));
    jest.doMock('../services/phoneService', () => ({ sendSms: jest.fn(async () => ({})) }));
    jest.doMock('../services/resolverService', () => ({ resolve: jest.fn(async (s) => s) }));
    jest.doMock('../lib/alerting', () => ({ alert: jest.fn(() => Promise.resolve()) }));
    apptService = require('../services/apptService');
    const express = require('express');
    const app = express();
    app.use(express.json());
    const db = makeDb();
    app.use((req, _res, next) => { req.db = db; next(); });
    app.use(require('../routes/manage'));
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));
  let ipN = 0;
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    apptRow = { appt_id: 501, appt_client_id: 77, appt_case_id: '', appt_status: 'Canceled', appt_type: 'Consultation', appt_platform: 'Zoom',
      appt_length: 30, appt_with: 1, appt_view_id: 7, appt_source: 'bk-consult:ditchurdebt', appt_date: '2026-09-01 10:00' };
  });
  afterEach(() => jest.restoreAllMocks());
  const post = (body) => fetch(`${base}/api/m/${TOKEN}/reschedule`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.9.${Math.floor(++ipN / 250)}.${ipN % 250}` }, body: JSON.stringify(body),
  });

  test('the rebook copy hands createAppt the loaded row\'s appt_source beside appt_view_id', async () => {
    const res = await post({ start: tomorrow10() });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, mode: 'rebooked' });
    expect(apptService.createAppt).toHaveBeenCalledTimes(1);
    expect(apptService.createAppt.mock.calls[0][1]).toMatchObject({
      appt_view_id: 7, appt_source: 'bk-consult:ditchurdebt', hook_event: 'rebooked', hook_rescheduled_from: 501, source: 'client',
    });
    expect(apptService.rescheduleAppt).not.toHaveBeenCalled();
  });

  test('a NULL channel rebooks as NULL (the key is present, the value null — never undefined, "" or the view id)', async () => {
    apptRow.appt_source = null;
    const res = await post({ start: tomorrow10() });
    expect(res.status).toBe(200);
    const arg = apptService.createAppt.mock.calls[0][1];
    expect('appt_source' in arg).toBe(true);
    expect(arg.appt_source).toBeNull();
  });

  test('loadApptByToken\'s SELECT names a.appt_source (the copy reads the loaded row)', async () => {
    await post({ start: tomorrow10() });
    expect(lastSelect).toMatch(/\ba\.appt_source\b/);
  });

  test('the Scheduled branch still goes through rescheduleAppt (which reads the row itself)', async () => {
    apptRow.appt_status = 'Scheduled';
    apptRow.appt_date = tomorrow10().replace(/10:00$/, '15:00');
    const res = await post({ start: tomorrow10() });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, mode: 'rescheduled' });
    expect(apptService.rescheduleAppt).toHaveBeenCalledTimes(1);
    expect(apptService.rescheduleAppt.mock.calls[0][1]).toMatchObject({ appt_id: 501, source: 'client' });
    expect(apptService.createAppt).not.toHaveBeenCalled();
  });
});

// ─── Source pins: the two sites, in words a grep can find ───────────────────
describe('the two successor sites name appt_source', () => {
  test('rescheduleAppt\'s createAppt call carries oldAppt.appt_source', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'apptService.js'), 'utf8');
    const m = /appt_view_id:\s+oldAppt\.appt_view_id,[\s\S]*?hook_event:\s+'rescheduled'/.exec(src);
    expect(m).not.toBeNull();
    expect(m[0]).toMatch(/appt_source:\s+oldAppt\.appt_source,/);
  });
  test('manage.js\'s rebook copy carries appt.appt_source', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'manage.js'), 'utf8');
    const m = /appt_view_id:\s+appt\.appt_view_id,[\s\S]*?hook_event:\s+'rebooked'/.exec(src);
    expect(m).not.toBeNull();
    expect(m[0]).toMatch(/appt_source:\s+appt\.appt_source,/);
  });
});
