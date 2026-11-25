/**
 * Booking embed attribution — the view hook's `source` (2026-11-25).
 *
 * services/apptService.fireViewHook fires a booking view's YisraHook with
 * { event, appt_id, contact_id, provider, start, view_slug, source }. `source`
 * used to be the VIEW's source_tag; it is now the ROW's appt_source when the
 * caller has it — a ?src= tagged booking reports "<view-tag>:<tag>" — and the
 * view's source_tag when the row carries none (a successor created before
 * 2026-11-25, a row staff cleared: exactly the value the payload had before
 * tags). No new field. Since 2026-11-25 a reschedule / rebook successor
 * carries the original's appt_source (tests/apptSourceCarry.test.js).
 *
 * Driven through the real createAppt / rescheduleLater over a SQL-matching
 * db stub (the apptService.lineage idiom); executeHook is the only mock that
 * matters — its payload is the assertion.
 *
 * Run:  npx jest tests/bookingSrcTag.hook.test.js
 */
'use strict';

jest.mock('../services/settingsService', () => ({ getSettings: jest.fn(async () => ({})) }));
jest.mock('../services/phoneService', () => ({ sendSms: jest.fn(async () => ({})) }));
jest.mock('../services/emailService', () => ({ sendEmail: jest.fn(async () => ({})) }));
jest.mock('../services/gcalService', () => ({
  createEvent:    jest.fn(async () => ({ id: 'gcal-evt-1' })),
  deleteEvent:    jest.fn(async () => ({})),
  _resolveTarget: jest.fn(async () => ({ calendarId: 'firm@example.com' })),
}));
jest.mock('../services/taskService', () => ({ createTask: jest.fn(async () => ({ task_id: 4242 })) }));
jest.mock('../services/logService', () => ({ createLogEntry: jest.fn(async () => ({ log_id: 1 })) }));
jest.mock('../services/resolverService', () => ({ resolve: jest.fn(async (s) => s) }));
jest.mock('../lib/sequenceEngine', () => ({
  cancelSequences: jest.fn(async () => ({})),
  cancelByApptId:  jest.fn(async () => ({})),
  enrollContact:   jest.fn(async () => ({})),
}));
jest.mock('../services/hookService', () => ({ executeHook: jest.fn(async () => ({})) }));
jest.mock('../lib/domainEvents', () => ({
  emit:         jest.fn(() => Promise.resolve()),
  buildChanges: jest.fn(() => ({})),
  runAsAction:  (_ruleId, fn) => fn(),
  MAX_DEPTH:    4,
}));
jest.mock('../lib/alerting', () => ({ alert: jest.fn(() => Promise.resolve()) }));

const fs = require('fs');
const path = require('path');
const apptService = require('../services/apptService');
const hookService = require('../services/hookService');
const calendarTypeService = require('../services/calendarTypeService');

beforeAll(() => calendarTypeService._primeCache(require('./fixtures/calendar_item_types.seed.json')));
afterAll(() => calendarTypeService.invalidate());

const VIEWS = {
  7: { slug: 'bk-consult', source_tag: null, hook_id: 30 },
  1: { slug: 'consult', source_tag: 'test-consult', hook_id: 30 },
};

function makeDb(seedRows = []) {
  const unmatched = [];
  const rows = new Map(seedRows.map((r) => [Number(r.appt_id), { ...r }]));
  let nextInsertId = 900;
  const handler = async (sql, params = []) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    if (/^INSERT INTO appts/i.test(flat)) {
      const id = ++nextInsertId;
      rows.set(id, {
        appt_id: id, appt_client_id: params[0], appt_case_id: params[1], appt_type: params[2],
        appt_length: params[3], appt_platform: params[4], appt_date: params[5], appt_status: 'Scheduled',
        appt_with: params[7], appt_note: params[8], appt_source: params[9], appt_gcal: '', appt_gcal_user: null,
        appt_view_id: params[12], rescheduled_from_appt_id: params[13],
      });
      return [{ insertId: id, affectedRows: 1 }];
    }
    if (/^SELECT \* FROM appts WHERE appt_id/i.test(flat)) { const r = rows.get(Number(params[0])); return [r ? [r] : []]; }
    if (/^SELECT appt_client_id, appt_case_id, appt_type, appt_date/i.test(flat)) { const r = rows.get(Number(params[0])); return [r ? [r] : []]; }
    if (/^SELECT appt_id, appt_client_id, appt_case_id, appt_type, type_key, appt_gcal/i.test(flat)) { const r = rows.get(Number(params[0])); return [r ? [r] : []]; }
    if (/^UPDATE appts SET appt_status = 'Rescheduled'/i.test(flat)) { const r = rows.get(Number(params[1])); if (r) r.appt_status = 'Rescheduled'; return [{ affectedRows: r ? 1 : 0 }]; }
    if (/^UPDATE appts SET appt_gcal(_user)? = \?/i.test(flat)) return [{ affectedRows: 1 }];
    if (/^SELECT user_gcal_id FROM users WHERE user = \?/i.test(flat)) return [[]];
    if (/^SELECT contact_name, contact_email FROM contacts/i.test(flat)) return [[{ contact_name: 'Test Client', contact_email: 'client@example.test' }]];
    // fireViewHook's two reads
    if (/^SELECT slug, source_tag, hook_id FROM booking_views WHERE id = \?/i.test(flat)) { const v = VIEWS[Number(params[0])]; return [v ? [{ ...v }] : []]; }
    if (/^SELECT slug FROM hooks WHERE id = \? AND active = 1/i.test(flat)) return [[{ slug: 'booking-hook' }]];
    unmatched.push(flat);
    return [[]];
  };
  const conn = { query: handler, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {}, destroy: () => {} };
  return { unmatched, rows, query: handler, getConnection: async () => conn, withTransaction: async (fn) => fn(conn) };
}

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const hookPayloads = () => hookService.executeHook.mock.calls.map(([, slug, payload]) => ({ slug, payload }));

const BASE = { contact_id: 77, appt_length: 30, appt_type: 'Consultation', appt_platform: 'Zoom', appt_date: '2026-09-10 14:00', source: 'client' };

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('createAppt → the view hook\'s `source`', () => {
  test('a tagged booking reports the row\'s composed value, not the view\'s tag', async () => {
    const db = makeDb();
    await apptService.createAppt(db, { ...BASE, appt_view_id: 1, appt_source: 'test-consult:ditchurdebt' });
    await flush();
    expect(hookPayloads()).toEqual([{ slug: 'booking-hook', payload: expect.objectContaining({ event: 'created', view_slug: 'consult', source: 'test-consult:ditchurdebt' }) }]);
  });

  test('an untagged booking on a view with a source_tag: the tag, as before', async () => {
    const db = makeDb();
    await apptService.createAppt(db, { ...BASE, appt_view_id: 1, appt_source: 'test-consult' });
    await flush();
    expect(hookPayloads()[0].payload.source).toBe('test-consult');
  });

  test('a row without a value falls back to the VIEW\'s tag (a pre-2026-11-25 successor carries none): today\'s payload', async () => {
    const db = makeDb();
    await apptService.createAppt(db, { ...BASE, appt_view_id: 1, hook_event: 'rescheduled', hook_rescheduled_from: 501 });
    await flush();
    expect(hookPayloads()).toEqual([{ slug: 'booking-hook', payload: expect.objectContaining({ event: 'rescheduled', rescheduled_from: 501, source: 'test-consult' }) }]);
  });

  test('neither the row nor the view has one → null, never "" or the slug', async () => {
    const db = makeDb();
    await apptService.createAppt(db, { ...BASE, appt_view_id: 7 });
    await flush();
    expect(hookPayloads()[0].payload.source).toBeNull();
    const db2 = makeDb();
    await apptService.createAppt(db2, { ...BASE, appt_view_id: 7, appt_source: 'bk-consult:ditchurdebt' });
    await flush();
    expect(hookPayloads()[1].payload.source).toBe('bk-consult:ditchurdebt');
  });

  test('the payload gains no field: the same seven keys (plus rescheduled_from on a successor)', async () => {
    const db = makeDb();
    await apptService.createAppt(db, { ...BASE, appt_view_id: 7, appt_source: 'bk-consult:ditchurdebt' });
    await flush();
    expect(Object.keys(hookPayloads()[0].payload).sort()).toEqual(['appt_id', 'contact_id', 'event', 'provider', 'source', 'start', 'view_slug']);
  });

  test('no view → no hook, tag or not', async () => {
    const db = makeDb();
    await apptService.createAppt(db, { ...BASE, appt_source: 'calendly' });
    await flush();
    expect(hookService.executeHook).not.toHaveBeenCalled();
  });
});

describe('rescheduleLater → the view hook reads the row\'s appt_source', () => {
  const row = (over) => ({ appt_id: 501, appt_client_id: 77, appt_case_id: '', appt_type: 'Consultation', type_key: 'consultation',
    appt_gcal: '', appt_gcal_user: null, appt_with: 1, appt_view_id: 1, appt_date: '2026-09-01 10:00:00', appt_status: 'Scheduled', ...over });

  test('a tagged row reports its tag on rescheduled_later', async () => {
    const db = makeDb([row({ appt_source: 'test-consult:ditchurdebt' })]);
    await apptService.rescheduleLater(db, { appt_id: 501, source: 'client' });
    await flush();
    expect(hookPayloads()).toEqual([{ slug: 'booking-hook', payload: expect.objectContaining({ event: 'rescheduled_later', source: 'test-consult:ditchurdebt' }) }]);
  });

  test('a NULL row falls back to the view\'s tag', async () => {
    const db = makeDb([row({ appt_source: null })]);
    await apptService.rescheduleLater(db, { appt_id: 501, source: 'client' });
    await flush();
    expect(hookPayloads()[0].payload.source).toBe('test-consult');
  });

  test('its SELECT asks for appt_source (the fallback would otherwise hide a dropped column silently)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'apptService.js'), 'utf8');
    const m = /'SELECT appt_id, appt_client_id, appt_case_id, appt_type, type_key, appt_gcal, appt_gcal_user, appt_with, appt_view_id, ([^']*) FROM appts WHERE appt_id = \?'/.exec(src);
    expect(m).not.toBeNull();
    expect(m[1].split(/,\s*/)).toContain('appt_source');
  });
});

describe('every fireViewHook caller hands over the row\'s appt_source', () => {
  test('three call sites, three appt_source lines (created / canceled / rescheduled_later)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'apptService.js'), 'utf8');
    // the CALLS, not the declaration (`function fireViewHook(db, {…}) {`)
    const calls = src.match(/(?<!function )fireViewHook\(db, \{[\s\S]*?\}\);/g);
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(c).toMatch(/\n\s*appt_source[,:]/);
  });
});
