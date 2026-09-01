// tests/calendarEvents.appt.test.js
//
/**
 * Unified Events U4 — the appt side of `calendar.*` (v0.5 §3.5, amendment A5).
 *
 * apptService now emits a source-neutral calendar.* twin BESIDE each of its
 * existing appt.* events. Two promises, and the first is the one that makes
 * this a zero-behaviour-change slice:
 *
 *   1. THE appt.* EMITS ARE UNTOUCHED. Same names, same order relative to the
 *      write, same `data`, same `extra`. Every rule bound to appt.attended in
 *      production keeps matching exactly what it matched yesterday. The tests
 *      below assert the old payloads by value, not just by existence — an
 *      "improvement" to one of them would be a live rule regression, and this
 *      file is what says so before it ships.
 *
 *   2. THE TWIN CARRIES THE UNIFIED SHAPE. type_key / kind / starts_at /
 *      state / resolution, identical in structure to what eventService emits
 *      for a hearing, so a U5 rule can filter `data.kind` without knowing
 *      which table the row lives in.
 *
 * ── WHY appt_manage_token IS ASSERTED, NOT ASSUMED ──────────────────────────
 *
 * createAppt's emit site re-reads with `SELECT *`, so its row carries
 * appt_manage_token — a bearer credential for /m/<token>. domainEvents' suffix
 * denylist strips it from `data`, but that is a backstop applied at envelope
 * BUILD time, and this suite mocks domainEvents. The real guard is that
 * _calendarEnvelope PROJECTS rather than spreads. That is the thing worth
 * pinning: the token is absent from the payload before anything redacts it.
 *
 * ── STUB POSTURE ────────────────────────────────────────────────────────────
 *   Mirrors tests/apptService.typeKey.test.js: a SQL-routing `db` (never the
 *   ordered-script idiom), registry cache primed from the seed fixture,
 *   domainEvents mocked so the emitted payloads are inspectable by value.
 *
 * Run:  npx jest tests/calendarEvents.appt.test.js
 */

'use strict';

jest.mock('../services/settingsService', () => ({ getSettings: jest.fn(async () => ({})) }));
jest.mock('../services/phoneService',    () => ({ sendSms: jest.fn(async () => ({})) }));
jest.mock('../services/emailService',    () => ({ sendEmail: jest.fn(async () => ({})) }));
jest.mock('../services/gcalService', () => ({
  createEvent:    jest.fn(async () => ({ id: 'gcal-evt-1' })),
  deleteEvent:    jest.fn(async () => ({})),
  _resolveTarget: jest.fn(async () => ({ calendarId: 'firm@example.com' })),
}));
jest.mock('../services/taskService',     () => ({ createTask: jest.fn(async () => ({ task_id: 1 })) }));
jest.mock('../services/logService',      () => ({ createLogEntry: jest.fn(async () => ({ log_id: 1 })) }));
jest.mock('../services/resolverService', () => ({ resolve: jest.fn(async (s) => s) }));
jest.mock('../lib/sequenceEngine', () => ({
  cancelSequences: jest.fn(async () => ({})),
  cancelByApptId:  jest.fn(async () => ({})),
  enrollContact:   jest.fn(async () => ({})),
}));
jest.mock('../services/hookService', () => ({ executeHook: jest.fn(async () => ({})) }));
jest.mock('../services/pipelineService', () => ({ advanceStage: jest.fn(async () => ({})) }));
jest.mock('../lib/domainEvents', () => ({
  emit:         jest.fn(() => Promise.resolve()),
  buildChanges: jest.fn(() => ({})),
  runAsAction:  (_ruleId, fn) => fn(),
  MAX_DEPTH:    4,
}));
jest.mock('../lib/alerting', () => ({ alert: jest.fn(() => Promise.resolve()) }));

const apptService         = require('../services/apptService');
const calendarTypeService = require('../services/calendarTypeService');
const domainEvents        = require('../lib/domainEvents');
const SEED                = require('./fixtures/calendar_item_types.seed.json');

const CONTACT_ID = 77;

function existingAppt(overrides = {}) {
  return {
    appt_id: 501, appt_client_id: CONTACT_ID, appt_case_id: '', appt_type: 'Consultation',
    type_key: 'consultation', appt_length: 30, appt_platform: 'Zoom',
    appt_date: '2026-09-01 10:00:00', appt_status: 'Scheduled', appt_with: 1, appt_note: '',
    appt_gcal: '', appt_gcal_user: null, appt_view_id: null, rescheduled_from_appt_id: null,
    // The credential the projection must not carry through.
    appt_manage_token: 'deadbeefdeadbeefdeadbeefdeadbeef',
    ...overrides,
  };
}

function makeDb(seedRows = []) {
  const poolCalls = [], connCalls = [], unmatched = [];
  const rows = new Map(seedRows.map((r) => [Number(r.appt_id), { ...r }]));
  let nextInsertId = 900;

  const handler = (log, isConn) => async (sql, params = []) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    log.push({ sql: flat, params, isConn });

    if (/^INSERT INTO appts/i.test(flat)) {
      const id = ++nextInsertId;
      rows.set(id, {
        appt_id: id, appt_client_id: params[0], appt_case_id: params[1], appt_type: params[2],
        appt_length: params[3], appt_platform: params[4], appt_date: params[5], appt_status: 'Scheduled',
        appt_with: params[7], appt_note: params[8], appt_gcal: '', appt_gcal_user: null,
        appt_manage_token: params[11], appt_view_id: params[12],
        rescheduled_from_appt_id: params[13], type_key: params[14],
      });
      return [{ insertId: id, affectedRows: 1 }];
    }
    // fetchApptWithContact (cancelAppt) — appts.* + joined contact columns.
    if (/^SELECT appts\.\*, contacts\.contact_phone/i.test(flat)) {
      const row = rows.get(Number(params[0]));
      return [row ? [{ ...row, contact_phone: '5555550100', client_email: 'c@x', contact_name: 'C',
                       contact_id: row.appt_client_id }] : []];
    }
    if (/^SELECT \* FROM appts WHERE appt_id/i.test(flat)) {
      const row = rows.get(Number(params[0])); return [row ? [row] : []];
    }
    if (/^SELECT appt_client_id, appt_case_id, appt_type, appt_date FROM appts/i.test(flat)) {
      const row = rows.get(Number(params[0])); return [row ? [row] : []];
    }
    if (/^SELECT appt_id, appt_client_id, appt_case_id, appt_type, type_key/i.test(flat)) {  // rescheduleLater
      const row = rows.get(Number(params[0])); return [row ? [row] : []];
    }
    if (/^SELECT a\.appt_id, a\.appt_client_id/i.test(flat)) {                                // markAttended / markNoShow
      const row = rows.get(Number(params[0]));
      return [row ? [{
        appt_id: row.appt_id, appt_client_id: row.appt_client_id, appt_case_id: row.appt_case_id,
        appt_date: row.appt_date, appt_type: row.appt_type, type_key: row.type_key,
        appt_with: row.appt_with, appt_status: row.appt_status,
        appt_length: row.appt_length, rescheduled_from_appt_id: row.rescheduled_from_appt_id,
        contact_phone: '5555550100', case_type: null, case_subtype: null,
      }] : []];
    }
    if (/^UPDATE appts SET appt_status = 'Rescheduled'/i.test(flat)) {
      const row = rows.get(Number(params[params.length - 1])); if (row) row.appt_status = 'Rescheduled';
      return [{ affectedRows: row ? 1 : 0 }];
    }
    if (/^UPDATE appts SET appt_status = '(Attended|No Show|Canceled)'/i.test(flat)) {
      const row = rows.get(Number(params[params.length - 1]));
      if (row) row.appt_status = /Attended/.test(flat) ? 'Attended' : (/No Show/.test(flat) ? 'No Show' : 'Canceled');
      return [{ affectedRows: 1 }];
    }
    if (/^UPDATE appts SET appt_gcal(_user)? = \?/i.test(flat)) return [{ affectedRows: 1 }];
    if (/^SELECT user_gcal_id FROM users/i.test(flat)) return [[]];
    if (/^SELECT contact_name, contact_email FROM contacts/i.test(flat)) return [[{ contact_name: 'C', contact_email: 'c@x' }]];
    if (/JOIN appts a ON a\.appt_id = c\.`341_appt_id`/i.test(flat)) return [[]];
    if (/^UPDATE cases SET case_341_current = \?/i.test(flat)) return [{ affectedRows: 1 }];
    if (/sequence_enrollments/i.test(flat)) return [[{ activeEnrollments: 0 }]];
    unmatched.push(flat);
    return [[]];
  };

  const conn = { query: handler(connCalls, true), beginTransaction: async () => {}, commit: async () => {},
                 rollback: async () => {}, release: () => {}, destroy: () => {} };
  return {
    poolCalls, connCalls, unmatched, rows,
    query: handler(poolCalls, false),
    getConnection: async () => conn,
    withTransaction: async (fn) => fn(conn),
  };
}

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

/** Every emit of `name`, in call order, as [eventType, payload] pairs. */
const emitsOf = (name) => domainEvents.emit.mock.calls.filter((c) => c[1] === name).map((c) => c[2]);
const emitNames = () => domainEvents.emit.mock.calls.map((c) => c[1]);
const onlyEmit = (name) => {
  const hits = emitsOf(name);
  expect(hits).toHaveLength(1);
  return hits[0];
};

const BASE = { contact_id: CONTACT_ID, appt_length: 30, appt_platform: 'Zoom', appt_date: '2026-09-10 14:00' };

beforeAll(() => calendarTypeService._primeCache(SEED));
afterAll(() => calendarTypeService.invalidate());
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { console.log.mockRestore(); console.warn.mockRestore(); console.error.mockRestore(); });

// ─────────────────────────────────────────────────────────────────────────────
describe('createAppt → appt.created + calendar.scheduled', () => {
  test('both fire, in that order, from the same post-commit position', async () => {
    const db = makeDb();
    await apptService.createAppt(db, { ...BASE, appt_type: 'Strategy Session' });
    await flush();
    const names = emitNames();
    expect(names).toContain('appt.created');
    expect(names).toContain('calendar.scheduled');
    expect(names.indexOf('appt.created')).toBeLessThan(names.indexOf('calendar.scheduled'));
    expect(db.unmatched).toEqual([]);
  });

  test('the legacy appt.created payload is byte-for-byte what it was (alias, not replacement)', async () => {
    const db = makeDb();
    const r = await apptService.createAppt(db, {
      ...BASE, appt_type: 'Strategy Session', source: 'booking', actingUserId: 5,
      hook_event: 'rescheduled', hook_rescheduled_from: 501,
    });
    await flush();
    const legacy = onlyEmit('appt.created');
    expect(legacy.contact_id).toBe(CONTACT_ID);
    expect(legacy.case_id).toBeNull();
    expect(legacy.source).toBe('booking');
    expect(legacy.actor).toEqual({ user_id: 5 });
    expect(legacy.data).toBe(db.rows.get(r.appt_id));         // still the raw row object
    expect(legacy.extra).toEqual({ hook_event: 'rescheduled', rescheduled_from: 501 });
  });

  test('the twin carries the unified shape, and NOT the manage token', async () => {
    const db = makeDb();
    const r = await apptService.createAppt(db, {
      ...BASE, appt_type: 'Strategy Session', appt_with: 2, source: 'booking', actingUserId: 5,
    });
    await flush();
    const env = onlyEmit('calendar.scheduled');
    expect(env.contact_id).toBe(CONTACT_ID);
    expect(env.case_id).toBeNull();
    expect(env.source).toBe('booking');
    expect(env.actor).toEqual({ user_id: 5 });
    expect(env.data).toMatchObject({
      source:       'appt',
      source_id:    r.appt_id,
      type_key:     'ss',
      kind:         'meeting',
      label:        'Strategy Session',
      appt_type:    'Strategy Session',
      starts_at:    '2026-09-10 14:00',
      all_day:      false,
      length_min:   30,
      with_user_id: 2,
      status:       'Scheduled',
      state:        'live',
      resolution:   null,
      link_type:    'contact',
      link_id:      String(CONTACT_ID),
      docket:       null,
      rescheduled_from_appt_id: null,
      superseded_by_event_id:   null,
    });
    // The projection, not the denylist, is what keeps this out.
    expect(Object.keys(env.data)).not.toContain('appt_manage_token');
    expect(JSON.stringify(env)).not.toContain('deadbeef');
    expect(env.extra).toEqual({
      legacy_event: 'appt.created', hook_event: 'created', rescheduled_from: null,
    });
  });

  test('a cased appt anchors to the case, not the contact; contact_id is still promoted', async () => {
    const db = makeDb();
    await apptService.createAppt(db, { ...BASE, case_id: 'CASE0001', appt_type: 'Pre-filing Meeting' });
    await flush();
    const env = onlyEmit('calendar.scheduled');
    expect(env.case_id).toBe('CASE0001');
    expect(env.contact_id).toBe(CONTACT_ID);
    expect(env.data.link_type).toBe('case');
    expect(env.data.link_id).toBe('CASE0001');
  });

  test('an unmapped label emits type_key null and still says kind meeting (by table)', async () => {
    const db = makeDb();
    await apptService.createAppt(db, { ...BASE, appt_type: 'Mediation Prep' });
    await flush();
    const env = onlyEmit('calendar.scheduled');
    expect(env.data.type_key).toBeNull();
    expect(env.data.kind).toBe('meeting');
    expect(env.data.label).toBe('Mediation Prep');
  });

  test('the reschedule/rebook successor carries its predecessor id on the row AND in extra', async () => {
    const db = makeDb([existingAppt()]);
    await apptService.createAppt(db, {
      ...BASE, appt_type: 'Consultation', hook_event: 'rebooked', hook_rescheduled_from: 501, source: 'client',
    });
    await flush();
    const env = onlyEmit('calendar.scheduled');
    expect(env.data.rescheduled_from_appt_id).toBe(501);
    expect(env.extra).toEqual({
      legacy_event: 'appt.created', hook_event: 'rebooked', rescheduled_from: 501,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('markAttended / markNoShow → calendar.resolved', () => {
  test('attended: legacy payload unchanged; twin says resolved/attended', async () => {
    const db = makeDb([existingAppt({ appt_id: 701, appt_case_id: 'CASE0001', appt_type: '341 Meeting',
                                      type_key: 'meeting_341', appt_length: 45 })]);
    await apptService.markAttended(db, { appt_id: 701, actingUserId: 3, source: 'manual' });
    await flush();

    const legacy = onlyEmit('appt.attended');
    expect(legacy.data.appt_status).toBe('Attended');
    expect(legacy.extra).toEqual({ prior_status: 'Scheduled' });

    const env = onlyEmit('calendar.resolved');
    expect(env.source).toBe('manual');
    expect(env.actor).toEqual({ user_id: 3 });
    expect(env.case_id).toBe('CASE0001');
    expect(env.data).toMatchObject({
      source: 'appt', source_id: 701, type_key: 'meeting_341', kind: 'meeting',
      status: 'Attended', state: 'resolved', resolution: 'attended',
      link_type: 'case', link_id: 'CASE0001',
      // U4 widened the SELECT for exactly these two.
      length_min: 45, rescheduled_from_appt_id: null,
    });
    expect(env.extra).toEqual({ legacy_event: 'appt.attended' });
  });

  test('no_show: same event name, different resolution', async () => {
    const db = makeDb([existingAppt({ appt_id: 702, appt_type: 'Initial Strategy Session', type_key: 'iss' })]);
    await apptService.markNoShow(db, { appt_id: 702 });
    await flush();

    expect(onlyEmit('appt.no_show').extra).toEqual({ prior_status: 'Scheduled', enrolled: false });

    const env = onlyEmit('calendar.resolved');
    expect(env.data.status).toBe('No Show');
    expect(env.data.state).toBe('resolved');
    expect(env.data.resolution).toBe('no_show');
    expect(env.extra).toEqual({ legacy_event: 'appt.no_show' });
  });

  test('length_min is the real column value, not null-by-absence', async () => {
    const db = makeDb([existingAppt({ appt_id: 703, appt_length: 15 })]);
    await apptService.markNoShow(db, { appt_id: 703 });
    await flush();
    expect(onlyEmit('calendar.resolved').data.length_min).toBe(15);
    expect(db.unmatched).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('cancelAppt → calendar.cancelled', () => {
  test('legacy payload unchanged; twin says cancelled/cancelled and carries prior_status', async () => {
    const db = makeDb([existingAppt({ appt_id: 801, appt_status: 'Scheduled' })]);
    await apptService.cancelAppt(db, { appt_id: 801, actingUserId: 9, source: 'client' });
    await flush();

    expect(onlyEmit('appt.cancelled').extra).toEqual({ prior_status: 'Scheduled' });

    const env = onlyEmit('calendar.cancelled');
    expect(env.source).toBe('client');
    expect(env.actor).toEqual({ user_id: 9 });
    expect(env.data).toMatchObject({
      source: 'appt', source_id: 801, status: 'Canceled',
      state: 'cancelled', resolution: 'cancelled', kind: 'meeting',
    });
    expect(env.extra).toEqual({ legacy_event: 'appt.cancelled', prior_status: 'Scheduled' });
    // fetchApptWithContact joins contact columns — the projection drops them
    // and the manage token with them.
    expect(Object.keys(env.data)).not.toContain('contact_phone');
    expect(Object.keys(env.data)).not.toContain('appt_manage_token');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('rescheduleAppt → calendar.rescheduled on the PREDECESSOR', () => {
  test('the predecessor twin is superseded and points at the successor', async () => {
    const db = makeDb([existingAppt({ appt_id: 501, appt_date: '2026-09-01 10:00:00' })]);
    const res = await apptService.rescheduleAppt(db, {
      appt_id: 501, newDate: '2026-09-10 14:00', actingUserId: 4, source: 'manual',
    });
    await flush();

    expect(onlyEmit('appt.rescheduled').extra)
      .toEqual({ new_appt_id: res.new_appt_id, new_appt_date: '2026-09-10 14:00' });

    const env = onlyEmit('calendar.rescheduled');
    expect(env.data).toMatchObject({
      source_id:  501,
      status:     'Rescheduled',
      state:      'superseded',      // a tombstone, whatever the status column says
      resolution: null,
      starts_at:  '2026-09-01 10:00',
    });
    expect(env.extra).toEqual({
      legacy_event:    'appt.rescheduled',
      new_source_id:   res.new_appt_id,
      // createAppt canonicalizes to seconds; wallClockStr trims back to minutes.
      new_starts_at:   '2026-09-10 14:00',
      prior_starts_at: '2026-09-01 10:00',
    });
  });

  test('the successor fires its own calendar.scheduled — one move, two twins', async () => {
    const db = makeDb([existingAppt({ appt_id: 501 })]);
    const res = await apptService.rescheduleAppt(db, { appt_id: 501, newDate: '2026-09-10 14:00' });
    await flush();
    const sched = onlyEmit('calendar.scheduled');
    expect(sched.data.source_id).toBe(res.new_appt_id);
    expect(sched.data.rescheduled_from_appt_id).toBe(501);
    expect(sched.extra.hook_event).toBe('rescheduled');
    // Successor first (it is created before the predecessor's log/emit), then
    // the predecessor's rescheduled. Order is asserted so a future refactor
    // that inverts it has to say so out loud.
    const names = emitNames().filter((n) => n.startsWith('calendar.'));
    expect(names).toEqual(['calendar.scheduled', 'calendar.rescheduled']);
    expect(db.unmatched).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('rescheduleLater emits NO calendar.* — deliberately', () => {
  test('appt.reschedule_later fires alone', async () => {
    const db = makeDb([existingAppt({ appt_id: 901 })]);
    await apptService.rescheduleLater(db, { appt_id: 901 });
    await flush();
    expect(emitsOf('appt.reschedule_later')).toHaveLength(1);
    expect(emitNames().filter((n) => n.startsWith('calendar.'))).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('_calendarEnvelope edge cases', () => {
  const env = (row) => apptService._calendarEnvelope(row);

  test('a client-less, case-less appt anchors to nothing rather than to a lie', () => {
    const d = env({ appt_id: 1, appt_client_id: null, appt_case_id: '', appt_type: 'X',
                    appt_status: 'Scheduled', appt_date: '2026-01-02 09:30:00' }).data;
    expect([d.link_type, d.link_id]).toEqual([null, null]);
  });

  test("the 6 blank-appt_status rows read live, never laundered into a resolution", () => {
    const d = env({ appt_id: 2, appt_client_id: 3, appt_case_id: '', appt_type: 'X',
                    appt_status: '', appt_date: '2026-01-02 09:30:00' }).data;
    expect(d.status).toBe('');
    expect([d.state, d.resolution]).toEqual(['live', null]);
  });

  test('appt_with 0 stays 0 and null stays null (they are opposite facts)', () => {
    const base = { appt_id: 3, appt_client_id: 3, appt_case_id: '', appt_type: 'X',
                   appt_status: 'Scheduled', appt_date: '2026-01-02 09:30:00' };
    expect(env({ ...base, appt_with: 0 }).data.with_user_id).toBe(0);
    expect(env({ ...base, appt_with: null }).data.with_user_id).toBeNull();
  });

  test('a fake-UTC Date from mysql2 renders as firm-local wall time', () => {
    const d = env({ appt_id: 4, appt_client_id: 3, appt_case_id: '', appt_type: 'X',
                    appt_status: 'Scheduled', appt_date: new Date('2026-03-04T13:45:00.000Z') }).data;
    expect(d.starts_at).toBe('2026-03-04 13:45');
  });
});
