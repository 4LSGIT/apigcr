// tests/apptService.typeKey.test.js
//
/**
 * Unified Events U2 — apptService writes appts.type_key.
 *
 *   createAppt      known label · alias (booking_views 'Tax Consultation') ·
 *                   unknown → NULL · given valid key wins · INSERT shape
 *                   (type_key is the LAST bind; 0..13 unchanged) · the
 *                   registry read happens on the POOL before the transaction
 *                   (Fred, U2 R1.1) · fail-soft
 *   rescheduleAppt  the successor inherits the predecessor's type_key, even
 *                   when the predecessor's key does not equal what its label
 *                   resolves to (a PATCHed key survives the move — R2)
 *   341 block       still keys on the STRING '341 Meeting' (untouched until
 *                   U6): the prior 341 is superseded and the case pointer moves
 *   envelopes       appt.attended / appt.no_show data carries type_key (R4)
 *
 * Stub posture mirrors tests/apptService.lineage.test.js (SQL-routing db,
 * `unmatched` recorded and asserted empty). Registry cache PRIMED from the
 * seed fixture — no registry query reaches the stub (R1.3).
 *
 * Run:  npx jest tests/apptService.typeKey.test.js
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
    ...overrides,
  };
}

function makeDb(seedRows = [], { cases = {} } = {}) {
  const poolCalls = [], connCalls = [], unmatched = [];
  const rows = new Map(seedRows.map((r) => [Number(r.appt_id), { ...r }]));
  const caseRows = { ...cases };
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
        appt_view_id: params[12], rescheduled_from_appt_id: params[13], type_key: params[14],
      });
      return [{ insertId: id, affectedRows: 1 }];
    }
    if (/^SELECT \* FROM appts WHERE appt_id/i.test(flat)) {
      const row = rows.get(Number(params[0])); return [row ? [row] : []];
    }
    if (/^SELECT appt_client_id, appt_case_id, appt_type, appt_date FROM appts/i.test(flat)) {   // insertApptLog
      const row = rows.get(Number(params[0])); return [row ? [row] : []];
    }
    if (/^SELECT a\.appt_id, a\.appt_client_id/i.test(flat)) {                                    // markAttended / markNoShow
      const row = rows.get(Number(params[0]));
      return [row ? [{
        appt_id: row.appt_id, appt_client_id: row.appt_client_id, appt_case_id: row.appt_case_id,
        appt_date: row.appt_date, appt_type: row.appt_type, type_key: row.type_key,
        appt_with: row.appt_with, appt_status: row.appt_status, contact_phone: '5555550100',
        case_type: null, case_subtype: null,
      }] : []];
    }
    if (/^UPDATE appts SET appt_status = 'Rescheduled'/i.test(flat)) {
      // rescheduleAppt binds [note, id]; the 341 block binds [id] — id is always last
      const row = rows.get(Number(params[params.length - 1])); if (row) row.appt_status = 'Rescheduled';
      return [{ affectedRows: row ? 1 : 0 }];
    }
    if (/^UPDATE appts SET appt_status = '(Attended|No Show)'/i.test(flat)) {
      const row = rows.get(Number(params[params.length - 1])); if (row) row.appt_status = /Attended/.test(flat) ? 'Attended' : 'No Show';
      return [{ affectedRows: 1 }];
    }
    if (/^UPDATE appts SET appt_gcal(_user)? = \?/i.test(flat)) return [{ affectedRows: 1 }];
    if (/^SELECT user_gcal_id FROM users/i.test(flat)) return [[]];
    if (/^SELECT contact_name, contact_email FROM contacts/i.test(flat)) return [[{ contact_name: 'C', contact_email: 'c@x' }]];
    // 341 block: prior 341 via cases.341_appt_id
    if (/JOIN appts a ON a\.appt_id = c\.`341_appt_id`/i.test(flat)) {
      const c = caseRows[params[0]];
      const prior = c && c['341_appt_id'] && c['341_appt_id'] !== params[1] ? rows.get(Number(c['341_appt_id'])) : null;
      return [prior ? [{ appt_id: prior.appt_id, appt_gcal: prior.appt_gcal, appt_gcal_user: prior.appt_gcal_user,
                         appt_with: prior.appt_with, appt_status: prior.appt_status }] : []];
    }
    if (/^UPDATE cases SET case_341_current = \?, `341_appt_id` = \?/i.test(flat)) {
      caseRows[params[2]] = { ...(caseRows[params[2]] || {}), case_341_current: params[0], '341_appt_id': params[1] };
      return [{ affectedRows: 1 }];
    }
    if (/sequence_enrollments/i.test(flat)) return [[{ activeEnrollments: 0 }]];
    unmatched.push(flat);
    return [[]];
  };

  const conn = { query: handler(connCalls, true), beginTransaction: async () => {}, commit: async () => {},
                 rollback: async () => {}, release: () => {}, destroy: () => {} };
  return {
    poolCalls, connCalls, unmatched, rows, caseRows,
    query: handler(poolCalls, false),
    getConnection: async () => conn,
    withTransaction: async (fn) => fn(conn),
  };
}

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const apptInsert = (db) => db.connCalls.concat(db.poolCalls).find((c) => /^INSERT INTO appts/i.test(c.sql));

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
describe('createAppt — type_key', () => {
  test('known label → key; appt_type written verbatim (no canonicalization)', async () => {
    const db = makeDb();
    const r = await apptService.createAppt(db, { ...BASE, appt_type: 'Pre-filing Meeting' });
    await flush();
    expect(db.rows.get(r.appt_id).type_key).toBe('pre_filing');
    expect(db.rows.get(r.appt_id).appt_type).toBe('Pre-filing Meeting');
    expect(r.appt.type_key).toBe('pre_filing');            // re-read row carries it (→ appt.created envelope)
    expect(db.unmatched).toEqual([]);
  });

  test("booking-view labels resolve via alias: 'Tax Consultation' → tax_consult, 'Potato Hunting' → test", async () => {
    const db = makeDb();
    const a = await apptService.createAppt(db, { ...BASE, appt_type: 'Tax Consultation' });
    const b = await apptService.createAppt(db, { ...BASE, appt_type: 'Potato Hunting' });
    await flush();
    expect(db.rows.get(a.appt_id).type_key).toBe('tax_consult');
    expect(db.rows.get(b.appt_id).type_key).toBe('test');
  });

  test('unknown label → type_key NULL (raw passthrough, never a guessed key)', async () => {
    const db = makeDb();
    const r = await apptService.createAppt(db, { ...BASE, appt_type: 'Mediation Prep' });
    await flush();
    expect(db.rows.get(r.appt_id).type_key).toBeNull();
    expect(db.rows.get(r.appt_id).appt_type).toBe('Mediation Prep');
  });

  test('a given VALID type_key wins over the label; an unknown given key falls back to the label', async () => {
    const db = makeDb();
    const a = await apptService.createAppt(db, { ...BASE, appt_type: 'Initial Strategy Session', type_key: 'ss' });
    const b = await apptService.createAppt(db, { ...BASE, appt_type: 'Initial Strategy Session', type_key: 'bogus' });
    await flush();
    expect(db.rows.get(a.appt_id).type_key).toBe('ss');
    expect(db.rows.get(b.appt_id).type_key).toBe('iss');
  });

  test('INSERT shape: type_key is the LAST bound column; binds 0..13 are unchanged', async () => {
    const db = makeDb();
    await apptService.createAppt(db, { ...BASE, appt_type: '341 Meeting', appt_with: 2, note: 'n', appt_source: 'src',
                                        appt_ref_id: 'ref', appt_view_id: 3, hook_rescheduled_from: 9 });
    await flush();
    const ins = apptInsert(db);
    const cols = /\(([^)]*)\)\s*VALUES/i.exec(ins.sql)[1].split(',').map((s) => s.trim());
    expect(cols.slice(-2)).toEqual(['type_key', 'appt_create_date']);
    const placeholders = (/VALUES\s*\(([\s\S]*)\)\s*$/i.exec(ins.sql)[1].match(/\?/g) || []).length;
    expect(ins.params).toHaveLength(placeholders);
    expect(ins.params).toHaveLength(15);
    expect(ins.params[0]).toBe(CONTACT_ID);
    expect(ins.params[2]).toBe('341 Meeting');
    expect(ins.params[7]).toBe(2);
    expect(ins.params[8]).toBe('n');
    expect(ins.params[12]).toBe(3);
    expect(ins.params[13]).toBe(9);
    expect(ins.params[14]).toBe('meeting_341');
  });

  test('the registry is read on the POOL before the transaction, never on the conn (R1.1)', async () => {
    calendarTypeService.invalidate();                      // force a real registry read
    const db = makeDb();
    const origPool = db.query;
    let registryReads = 0;
    db.query = async (sql, params) => {
      if (/FROM calendar_item_types/.test(sql)) {
        registryReads += 1;
        return [SEED.map((r) => ({ ...r, ingest_aliases: JSON.stringify(r.ingest_aliases), case_types: r.case_types && JSON.stringify(r.case_types) }))];
      }
      return origPool(sql, params);
    };
    const r = await apptService.createAppt(db, { ...BASE, appt_type: 'Strategy Session' });
    await flush();
    expect(registryReads).toBe(1);
    expect(db.connCalls.some((c) => /calendar_item_types/.test(c.sql))).toBe(false);
    expect(db.rows.get(r.appt_id).type_key).toBe('ss');
    calendarTypeService._primeCache(SEED);
  });

  test('fail-soft: a registry read failure yields NULL, the booking still succeeds', async () => {
    calendarTypeService.invalidate();
    const db = makeDb();
    const origPool = db.query;
    db.query = async (sql, params) => {
      if (/FROM calendar_item_types/.test(sql)) throw new Error('ER_NO_SUCH_TABLE');
      return origPool(sql, params);
    };
    const r = await apptService.createAppt(db, { ...BASE, appt_type: 'Strategy Session' });
    await flush();
    expect(db.rows.get(r.appt_id).type_key).toBeNull();
    expect(db.rows.get(r.appt_id).appt_status).toBe('Scheduled');
    calendarTypeService._primeCache(SEED);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('rescheduleAppt — successor inherits the predecessor key (R2)', () => {
  test('successor.type_key === predecessor.type_key when the predecessor carries a valid key', async () => {
    const db = makeDb([existingAppt()]);
    const res = await apptService.rescheduleAppt(db, { appt_id: 501, newDate: '2026-09-10 14:00' });
    await flush();
    expect(db.rows.get(res.new_appt_id).type_key).toBe(db.rows.get(501).type_key);
    expect(db.rows.get(res.new_appt_id).type_key).toBe('consultation');
    expect(db.unmatched).toEqual([]);
  });

  test('a PATCHed key that differs from the label survives the move', async () => {
    // label says iss, key says ss (staff corrected the key without touching the label)
    const db = makeDb([existingAppt({ appt_type: 'Initial Strategy Session', type_key: 'ss' })]);
    const res = await apptService.rescheduleAppt(db, { appt_id: 501, newDate: '2026-09-10 14:00' });
    await flush();
    expect(db.rows.get(res.new_appt_id).type_key).toBe('ss');
    expect(db.rows.get(res.new_appt_id).appt_type).toBe('Initial Strategy Session');
  });

  test('a pre-U2 predecessor (type_key NULL) still yields a keyed successor via the label', async () => {
    const db = makeDb([existingAppt({ appt_type: 'Strategy Session Follow Up', type_key: null })]);
    const res = await apptService.rescheduleAppt(db, { appt_id: 501, newDate: '2026-09-10 14:00' });
    await flush();
    expect(db.rows.get(res.new_appt_id).type_key).toBe('ss_follow_up');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('341 block — unchanged this slice (string-keyed until U6)', () => {
  test("a '341 Meeting' on a case supersedes the prior Scheduled 341 and moves the case pointer", async () => {
    const db = makeDb(
      [existingAppt({ appt_id: 601, appt_case_id: 'CASE0001', appt_type: '341 Meeting', type_key: 'meeting_341' })],
      { cases: { CASE0001: { '341_appt_id': 601 } } }
    );
    const r = await apptService.createAppt(db, { ...BASE, case_id: 'CASE0001', appt_type: '341 Meeting' });
    await flush();
    expect(db.rows.get(601).appt_status).toBe('Rescheduled');
    expect(db.caseRows.CASE0001['341_appt_id']).toBe(r.appt_id);
    expect(db.rows.get(r.appt_id).type_key).toBe('meeting_341');
    expect(db.unmatched).toEqual([]);
  });

  test("the key alone does NOT trigger supersession — only the string does (that flip is U6's, flag-guarded)", async () => {
    const db = makeDb(
      [existingAppt({ appt_id: 601, appt_case_id: 'CASE0001', appt_type: '341 Meeting', type_key: 'meeting_341' })],
      { cases: { CASE0001: { '341_appt_id': 601 } } }
    );
    await apptService.createAppt(db, { ...BASE, case_id: 'CASE0001', appt_type: '341', type_key: 'meeting_341' });
    await flush();
    expect(db.rows.get(601).appt_status).toBe('Scheduled');            // untouched
    expect(db.caseRows.CASE0001['341_appt_id']).toBe(601);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('envelopes dual-carry type_key (R4)', () => {
  test('appt.created data carries type_key (SELECT * re-read)', async () => {
    const db = makeDb();
    await apptService.createAppt(db, { ...BASE, appt_type: 'Strategy Session' });
    await flush();
    const call = domainEvents.emit.mock.calls.find((c) => c[1] === 'appt.created');
    expect(call[2].data.type_key).toBe('ss');
    expect(call[2].data.appt_type).toBe('Strategy Session');
  });

  test('appt.attended and appt.no_show data carry type_key alongside appt_type', async () => {
    const db = makeDb([existingAppt({ appt_id: 701, appt_type: '341 Meeting', type_key: 'meeting_341' }),
                       existingAppt({ appt_id: 702, appt_type: 'Initial Strategy Session', type_key: 'iss' })]);
    await apptService.markAttended(db, { appt_id: 701 });
    await apptService.markNoShow(db, { appt_id: 702 });
    await flush();
    const att = domainEvents.emit.mock.calls.find((c) => c[1] === 'appt.attended')[2].data;
    const ns  = domainEvents.emit.mock.calls.find((c) => c[1] === 'appt.no_show')[2].data;
    expect([att.appt_type, att.type_key]).toEqual(['341 Meeting', 'meeting_341']);
    expect([ns.appt_type, ns.type_key]).toEqual(['Initial Strategy Session', 'iss']);
  });
});
