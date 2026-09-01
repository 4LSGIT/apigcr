// tests/unifiedEventsU6b.appts.test.js
//
/**
 * Unified Events U6b — the appt side of A3a + the flagged singleton.
 *
 *   ANCHOR (A3a)     case_id wins · a docket resolves to its case (adopted as
 *                    case_id) or stays a 'case_number' anchor · contact-only
 *                    unchanged · no anchor at all keeps the historical
 *                    'Missing contact_id' · confirm-without-contact is a 400
 *                    BEFORE any write
 *   CLIENT-LESS      exactly the contact-scoped side effects are skipped
 *                    (cancelSequences, the GCal contact lookup, reminder
 *                    enrollment) and NOTHING else; the creation log carries
 *                    Clientless=true; the envelopes anchor honestly
 *   FLAG OFF         byte-for-byte today's behaviour: the '341 Meeting'
 *                    STRING block runs (pointer-path lookup and all), the
 *                    conn query list is pinned as an explicit sequence, and
 *                    the ONLY additions anywhere are the two INSERT binds
 *   FLAG ON          registry singleton: priors BY QUERY across both anchor
 *                    forms (the stale-pointer fixture proves the pointer is
 *                    not consulted), guarded tombstones, lineage stamp,
 *                    meeting_341 §4 projection, calendar.rescheduled per
 *                    predecessor AFTER calendar.scheduled with
 *                    extra.via='singleton'
 *
 * Stub posture mirrors tests/apptService.typeKey.test.js (SQL-routing db,
 * `unmatched` recorded and asserted empty; registry PRIMED from the seed).
 * The flag rides the same firmConfig mock shape as
 * tests/unifiedEventsU6a.supersede.test.js (global.__U6B_FLAG__).
 *
 * Run:  npx jest tests/unifiedEventsU6b.appts.test.js
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
jest.mock('../lib/firmConfig', () => {
  const real = jest.requireActual('../lib/firmConfig');
  return { ...real, cfg: jest.fn((k) => (k === 'unified_singleton_enabled' ? global.__U6B_FLAG__ : null)) };
});

const apptService         = require('../services/apptService');
const calendarTypeService = require('../services/calendarTypeService');
const domainEvents        = require('../lib/domainEvents');
const logService          = require('../services/logService');
const gcalService         = require('../services/gcalService');
const sequenceEngine      = require('../lib/sequenceEngine');
const { cfg }             = require('../lib/firmConfig');
const SEED                = require('./fixtures/calendar_item_types.seed.json');

const CONTACT_ID = 77;

/**
 * SQL-routing stub. `seedRows` are existing appts; `cases` is keyed by
 * case_id AND by both docket forms (the router matches whichever column the
 * query binds). Captures pool/conn calls separately — the anchor + registry
 * reads must stay on the POOL, the singleton work on the CONN.
 */
function makeDb(seedRows = [], { cases = [] } = {}) {
  const poolCalls = [], connCalls = [], unmatched = [];
  const rows = new Map(seedRows.map((r) => [Number(r.appt_id), { ...r }]));
  const caseList = cases.map((c) => ({ ...c }));
  const byCaseId = new Map(caseList.map((c) => [String(c.case_id), c]));
  const byDocket = new Map();
  for (const c of caseList) {
    for (const d of [c.case_number, c.case_number_full]) {
      if (d != null && String(d).trim() !== '') byDocket.set(String(d).trim(), c);
    }
  }
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
        appt_link_type: params[15] ?? null, appt_link_id: params[16] ?? null,
      });
      return [{ insertId: id, affectedRows: 1 }];
    }
    if (/^SELECT \* FROM appts WHERE appt_id/i.test(flat)) {
      const row = rows.get(Number(params[0])); return [row ? [row] : []];
    }
    if (/^SELECT appt_client_id, appt_case_id, appt_type, appt_date/i.test(flat)) {   // insertApptLog
      const row = rows.get(Number(params[0])); return [row ? [row] : []];
    }
    // U6b anchor resolution (docket → case) — the pool-side query.
    if (/^SELECT case_id, case_number, case_number_full FROM cases WHERE case_number = \?/i.test(flat)) {
      const c = byDocket.get(String(params[0]).trim());
      return [c ? [{ case_id: c.case_id, case_number: c.case_number, case_number_full: c.case_number_full }] : []];
    }
    // U6b singleton block — the conn-side case-row read (docket expansion).
    if (/^SELECT case_id, case_number, case_number_full FROM cases WHERE case_id = \?/i.test(flat)) {
      const c = byCaseId.get(String(params[0]));
      return [c ? [{ case_id: c.case_id, case_number: c.case_number, case_number_full: c.case_number_full }] : []];
    }
    // U6b singleton priors — SELECT a.* … type_key + status + link branches.
    if (/^SELECT a\.\* FROM appts a WHERE a\.type_key = \?/i.test(flat)) {
      const [typeKey, excludeId, caseId, ...dockets] = params;
      const out = [...rows.values()].filter((r) =>
        String(r.type_key) === String(typeKey) &&
        r.appt_status === 'Scheduled' &&
        Number(r.appt_id) !== Number(excludeId) &&
        (String(r.appt_case_id) === String(caseId) ||
         (String(r.appt_link_type) === 'case_number' && dockets.map(String).includes(String(r.appt_link_id))))
      ).sort((a, b) => a.appt_id - b.appt_id);
      return [out];
    }
    // Guarded tombstone (singleton) AND the legacy block's unguarded form —
    // both start the same way; honour the guard when it is present.
    if (/^UPDATE appts SET appt_status = 'Rescheduled'/i.test(flat)) {
      const id = Number(params[params.length - 1]);
      const row = rows.get(id);
      const guarded = /appt_status = 'Scheduled'$/i.test(flat);
      if (row && (!guarded || row.appt_status === 'Scheduled')) {
        row.appt_status = 'Rescheduled';
        return [{ affectedRows: 1 }];
      }
      return [{ affectedRows: 0 }];
    }
    if (/^UPDATE appts SET rescheduled_from_appt_id = \?/i.test(flat)) {
      const row = rows.get(Number(params[1]));
      if (row && row.rescheduled_from_appt_id == null) {
        row.rescheduled_from_appt_id = params[0];
        return [{ affectedRows: 1 }];
      }
      return [{ affectedRows: 0 }];
    }
    if (/^UPDATE appts SET appt_status = '(Attended|No Show)'/i.test(flat)) return [{ affectedRows: 1 }];
    if (/^UPDATE appts SET appt_gcal(_user)? = \?/i.test(flat)) return [{ affectedRows: 1 }];
    if (/^SELECT user_gcal_id FROM users/i.test(flat)) return [[]];
    if (/^SELECT contact_name, contact_email FROM contacts/i.test(flat)) return [[{ contact_name: 'C', contact_email: 'c@x' }]];
    // Legacy 341 block: prior via the cases pointer.
    if (/JOIN appts a ON a\.appt_id = c\.`341_appt_id`/i.test(flat)) {
      const c = byCaseId.get(String(params[0]));
      const prior = c && c['341_appt_id'] && c['341_appt_id'] !== params[1] ? rows.get(Number(c['341_appt_id'])) : null;
      return [prior ? [{ appt_id: prior.appt_id, appt_gcal: prior.appt_gcal, appt_gcal_user: prior.appt_gcal_user,
                         appt_with: prior.appt_with, appt_status: prior.appt_status }] : []];
    }
    if (/^UPDATE cases SET case_341_current = \?, `341_appt_id` = \?/i.test(flat)) {
      const c = byCaseId.get(String(params[2]));
      if (c) { c.case_341_current = params[0]; c['341_appt_id'] = params[1]; }
      return [{ affectedRows: c ? 1 : 0 }];
    }
    if (/sequence_enrollments/i.test(flat)) return [[{ activeEnrollments: 0 }]];
    unmatched.push(flat);
    return [[]];
  };

  const conn = { query: handler(connCalls, true), beginTransaction: async () => {}, commit: async () => {},
                 rollback: async () => {}, release: () => {}, destroy: () => {} };
  return {
    poolCalls, connCalls, unmatched, rows, byCaseId,
    query: handler(poolCalls, false),
    getConnection: async () => conn,
    withTransaction: async (fn) => fn(conn),
  };
}

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const apptInsert = (db) => db.connCalls.concat(db.poolCalls).find((c) => /^INSERT INTO appts/i.test(c.sql));
const emits = (name) => domainEvents.emit.mock.calls.filter((c) => c[1] === name).map((c) => c[2]);
const calEmitNames = () => domainEvents.emit.mock.calls.map((c) => c[1]).filter((n) => n.startsWith('calendar.'));
const logCalls = () => logService.createLogEntry.mock.calls.map((c) => c[1]);

const BASE = { contact_id: CONTACT_ID, appt_length: 30, appt_platform: 'Zoom', appt_date: '2026-09-10 14:00' };
const CASE_X = { case_id: 'X1CASEID', case_number: '26-1000', case_number_full: '26-1000-mlo', '341_appt_id': 0 };

beforeAll(() => calendarTypeService._primeCache(SEED));
afterAll(() => calendarTypeService.invalidate());
beforeEach(() => {
  jest.clearAllMocks();
  global.__U6B_FLAG__ = null;                 // flag OFF unless the test says
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { console.log.mockRestore(); console.warn.mockRestore(); console.error.mockRestore(); });

// ─────────────────────────────────────────────────────────────────────────────
describe('A3a anchor rules (flag off — the anchor is NOT flag-gated)', () => {
  test("case_id given → ('case', case_id); no docket resolution query anywhere", async () => {
    const db = makeDb([], { cases: [CASE_X] });
    await apptService.createAppt(db, { ...BASE, appt_type: 'Consultation', case_id: 'X1CASEID' });
    await flush();
    const ins = apptInsert(db);
    expect([ins.params[1], ins.params[15], ins.params[16]]).toEqual(['X1CASEID', 'case', 'X1CASEID']);
    expect(db.poolCalls.some((c) => /FROM cases WHERE case_number/.test(c.sql))).toBe(false);
    expect(db.unmatched).toEqual([]);
  });

  test('a docket that RESOLVES is adopted as the case — one pool query, link becomes (case, id)', async () => {
    const db = makeDb([], { cases: [CASE_X] });
    const r = await apptService.createAppt(db, { ...BASE, appt_type: 'Consultation', docket: '26-1000-mlo' });
    await flush();
    const ins = apptInsert(db);
    expect(ins.params[1]).toBe('X1CASEID');                       // appt_case_id = the resolved case
    expect([ins.params[15], ins.params[16]]).toEqual(['case', 'X1CASEID']);
    const resolves = db.poolCalls.filter((c) => /FROM cases WHERE case_number = \? OR case_number_full = \?/.test(c.sql));
    expect(resolves).toHaveLength(1);
    expect(resolves[0].params).toEqual(['26-1000-mlo', '26-1000-mlo']);
    expect(resolves[0].isConn).toBe(false);                       // pool, before the txn
    expect(r.appt.appt_link_type).toBe('case');
    expect(db.unmatched).toEqual([]);
  });

  test("an UNRESOLVED docket writes a 'case_number' anchor: case_id stays '', client-less allowed", async () => {
    const db = makeDb([], { cases: [] });
    const r = await apptService.createAppt(db, {
      appt_length: 30, appt_platform: 'telephone', appt_date: '2026-09-10 14:00',
      appt_type: '341 Meeting', docket: '26-99999',
    });
    await flush();
    const ins = apptInsert(db);
    expect(ins.params[0]).toBeNull();                             // no client attendee
    expect(ins.params[1]).toBe('');                               // no case
    expect([ins.params[15], ins.params[16]]).toEqual(['case_number', '26-99999']);
    expect(r.superseded).toEqual([]);
    expect(db.unmatched).toEqual([]);
  });

  test('docket + contact: the contact stays the ATTENDEE, the docket stays the ANCHOR (§3.6)', async () => {
    const db = makeDb([], { cases: [] });
    await apptService.createAppt(db, { ...BASE, appt_type: 'Consultation', docket: '26-99999' });
    await flush();
    const ins = apptInsert(db);
    expect(ins.params[0]).toBe(CONTACT_ID);
    expect([ins.params[15], ins.params[16]]).toEqual(['case_number', '26-99999']);
  });

  test("no anchor at all keeps the historical error, verbatim: 'Missing contact_id'", async () => {
    const db = makeDb();
    await expect(apptService.createAppt(db, {
      appt_length: 30, appt_platform: 'Zoom', appt_date: '2026-09-10 14:00', appt_type: 'Consultation',
    })).rejects.toThrow('Missing contact_id');
    expect(apptInsert(db)).toBeUndefined();
  });

  test('confirm requested with no client contact → err.status 400 BEFORE any write', async () => {
    const db = makeDb([], { cases: [CASE_X] });
    const p = apptService.createAppt(db, {
      appt_length: 30, appt_platform: 'Zoom', appt_date: '2026-09-10 14:00',
      appt_type: 'Consultation', case_id: 'X1CASEID',
      confirm_sms: true, confirm_message: 'See you soon',
    });
    await expect(p).rejects.toMatchObject({ status: 400 });
    expect(db.connCalls).toEqual([]);
    expect(db.poolCalls).toEqual([]);                             // before even the registry read
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('client-less side effects (flag off)', () => {
  const create = (db) => apptService.createAppt(db, {
    appt_length: 30, appt_platform: 'telephone', appt_date: '2026-09-10 14:00',
    appt_type: 'Consultation', case_id: 'X1CASEID', actingUserId: 3,
  });

  test('exactly the contact-scoped effects are skipped: cancelSequences, the contact lookup, enrollment', async () => {
    const db = makeDb([], { cases: [CASE_X] });
    await create(db);
    await flush();
    expect(sequenceEngine.cancelSequences).not.toHaveBeenCalled();
    expect(sequenceEngine.enrollContact).not.toHaveBeenCalled();
    expect(db.poolCalls.some((c) => /^SELECT contact_name, contact_email FROM contacts/.test(c.sql))).toBe(false);
    // The provider's calendar is still blocked — that effect is NOT contact-scoped.
    expect(gcalService.createEvent).toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('client-less'));
    expect(db.unmatched).toEqual([]);
  });

  test('the creation log carries Clientless=true; a cliented create does not', async () => {
    const db = makeDb([], { cases: [CASE_X] });
    await create(db);
    await flush();
    const created = logCalls().find((c) => c.data && c.data.Status === 'Created');
    expect(created.data.Clientless).toBe('true');

    jest.clearAllMocks();
    const db2 = makeDb([], { cases: [CASE_X] });
    await apptService.createAppt(db2, { ...BASE, appt_type: 'Consultation', case_id: 'X1CASEID' });
    await flush();
    const created2 = logCalls().find((c) => c.data && c.data.Status === 'Created');
    expect(created2.data.Clientless).toBeUndefined();
  });

  test('appt.created + calendar.scheduled carry contact_id null and the honest anchor', async () => {
    const db = makeDb([], { cases: [] });
    await apptService.createAppt(db, {
      appt_length: 30, appt_platform: 'telephone', appt_date: '2026-09-10 14:00',
      appt_type: '341 Meeting', docket: '26-99999',
    });
    await flush();
    expect(emits('appt.created')[0].contact_id).toBeNull();
    const env = emits('calendar.scheduled')[0];
    expect(env.contact_id).toBeNull();
    expect(env.case_id).toBeNull();
    expect(env.data.link_type).toBe('case_number');
    expect(env.data.link_id).toBe('26-99999');
    expect(env.data.docket).toBe('26-99999');
  });

  test("a docket-anchored appt's LOG rides the court-orphan convention: link_type 'case', link_id = the docket", async () => {
    const db = makeDb([], { cases: [] });
    await apptService.createAppt(db, {
      appt_length: 30, appt_platform: 'telephone', appt_date: '2026-09-10 14:00',
      appt_type: '341 Meeting', docket: '26-99999',
    });
    await flush();
    const created = logCalls().find((c) => c.data && c.data.Status === 'Created');
    expect(created.link_type).toBe('case');
    expect(created.link_id).toBe('26-99999');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('flag OFF — byte-for-byte today (the string block, pinned)', () => {
  test('341 with a Scheduled prior: the exact conn query sequence, pointer path and all', async () => {
    const prior = { appt_id: 500, appt_client_id: CONTACT_ID, appt_case_id: 'X1CASEID', appt_type: '341 Meeting',
                    type_key: 'meeting_341', appt_status: 'Scheduled', appt_gcal: 'g500', appt_gcal_user: null,
                    appt_with: 1, appt_date: '2026-09-01 10:00:00' };
    const db = makeDb([prior], { cases: [{ ...CASE_X, '341_appt_id': 500 }] });
    const r = await apptService.createAppt(db, { ...BASE, appt_type: '341 Meeting', case_id: 'X1CASEID' });
    await flush();

    // The transactional core, as an explicit ordered sequence. The ONLY U6b
    // delta inside it is the two extra INSERT binds — asserted separately.
    const seq = db.connCalls.map((c) => c.sql);
    expect(seq).toHaveLength(5);
    expect(seq[0]).toMatch(/^INSERT INTO appts/);
    expect(seq[1]).toMatch(/^SELECT appt_client_id, appt_case_id, appt_type, appt_date/);     // insertApptLog
    expect(seq[2]).toMatch(/JOIN appts a ON a\.appt_id = c\.`341_appt_id`/);                  // pointer-path lookup
    expect(seq[3]).toBe(`UPDATE appts SET appt_status = 'Rescheduled' WHERE appt_id = ?`);    // UNGUARDED, verbatim
    expect(seq[4]).toMatch(/^UPDATE cases SET case_341_current = \?, `341_appt_id` = \?/);
    // Nothing from the singleton path leaked in.
    expect(seq.some((s) => /SELECT a\.\* FROM appts a/.test(s))).toBe(false);
    expect(seq.some((s) => /SELECT case_id, case_number/.test(s))).toBe(false);
    expect(db.poolCalls.some((c) => /FROM cases/.test(c.sql))).toBe(false);

    // Supersession outcome + the LEGACY reason strings, byte-identical.
    expect(db.rows.get(500).appt_status).toBe('Rescheduled');
    expect(r.superseded).toEqual([500]);
    expect(sequenceEngine.cancelByApptId).toHaveBeenCalledWith(db, 500, '341_superseded');
    const supLog = logCalls().find((c) => c.data && c.data.Reason);
    expect(supLog.data.Reason).toBe('341_superseded');
    // No calendar.rescheduled — the string block has never emitted one.
    expect(calEmitNames()).toEqual(['calendar.scheduled']);
    expect(cfg).toHaveBeenCalledWith('unified_singleton_enabled');
    expect(db.unmatched).toEqual([]);
  });

  test('the successor is NOT lineage-stamped by the string block (pre-U6b behaviour)', async () => {
    const prior = { appt_id: 500, appt_client_id: CONTACT_ID, appt_case_id: 'X1CASEID', appt_type: '341 Meeting',
                    type_key: 'meeting_341', appt_status: 'Scheduled', appt_gcal: '', appt_gcal_user: null,
                    appt_with: 1, appt_date: '2026-09-01 10:00:00' };
    const db = makeDb([prior], { cases: [{ ...CASE_X, '341_appt_id': 500 }] });
    const r = await apptService.createAppt(db, { ...BASE, appt_type: '341 Meeting', case_id: 'X1CASEID' });
    await flush();
    expect(db.rows.get(r.appt_id).rescheduled_from_appt_id).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('flag ON — registry singleton (v0.5 §3.4.2)', () => {
  beforeEach(() => { global.__U6B_FLAG__ = '1'; });

  const PRIORS = [
    // (a) case-linked prior. The cases fixture's pointer names a DIFFERENT
    //     appt (999, which does not exist) — if the pointer were consulted,
    //     this row would be missed. The query must find it anyway.
    { appt_id: 501, appt_client_id: CONTACT_ID, appt_case_id: 'X1CASEID', appt_type: '341 Meeting',
      type_key: 'meeting_341', appt_status: 'Scheduled', appt_gcal: 'g501', appt_gcal_user: null,
      appt_with: 1, appt_date: '2026-09-01 10:00:00', appt_link_type: 'case', appt_link_id: 'X1CASEID',
      rescheduled_from_appt_id: null },
    // (b) docket-linked, client-less prior (the court-created shape).
    { appt_id: 502, appt_client_id: null, appt_case_id: '', appt_type: '341 Meeting',
      type_key: 'meeting_341', appt_status: 'Scheduled', appt_gcal: '', appt_gcal_user: null,
      appt_with: 1, appt_date: '2026-09-02 10:00:00', appt_link_type: 'case_number', appt_link_id: '26-1000-mlo',
      rescheduled_from_appt_id: null },
    // (c) already Rescheduled — invisible to the priors query.
    { appt_id: 503, appt_client_id: CONTACT_ID, appt_case_id: 'X1CASEID', appt_type: '341 Meeting',
      type_key: 'meeting_341', appt_status: 'Rescheduled', appt_gcal: '', appt_gcal_user: null,
      appt_with: 1, appt_date: '2026-08-01 10:00:00', appt_link_type: 'case', appt_link_id: 'X1CASEID',
      rescheduled_from_appt_id: null },
    // (d) same case, different type — no part of this identity.
    { appt_id: 504, appt_client_id: CONTACT_ID, appt_case_id: 'X1CASEID', appt_type: 'Consultation',
      type_key: 'consultation', appt_status: 'Scheduled', appt_gcal: '', appt_gcal_user: null,
      appt_with: 1, appt_date: '2026-09-03 10:00:00', appt_link_type: 'case', appt_link_id: 'X1CASEID',
      rescheduled_from_appt_id: null },
  ];
  const STALE_CASE = { ...CASE_X, '341_appt_id': 999 };

  test('priors BY QUERY across both anchor forms; the stale pointer is never consulted; guarded tombstones; lineage; projection', async () => {
    const db = makeDb(PRIORS, { cases: [STALE_CASE] });
    const r = await apptService.createAppt(db, { ...BASE, appt_type: '341 Meeting', case_id: 'X1CASEID', actingUserId: 3 });
    await flush();

    // Both live priors superseded — the case-linked AND the docket-linked.
    expect(r.superseded).toEqual([501, 502]);
    expect(db.rows.get(501).appt_status).toBe('Rescheduled');
    expect(db.rows.get(502).appt_status).toBe('Rescheduled');
    expect(db.rows.get(503).appt_status).toBe('Rescheduled');   // was already
    expect(db.rows.get(504).appt_status).toBe('Scheduled');     // different type — untouched

    // The pointer path is GONE under the flag.
    expect(db.connCalls.some((c) => /341_appt_id`\s*!=/.test(c.sql) || /JOIN appts a ON/.test(c.sql))).toBe(false);
    // Guarded tombstone form.
    const tombs = db.connCalls.filter((c) => /^UPDATE appts SET appt_status = 'Rescheduled'/.test(c.sql));
    expect(tombs).toHaveLength(2);
    for (const t of tombs) expect(t.sql).toMatch(/AND appt_status = 'Scheduled'$/);

    // Lineage: latest prior wins (502 > 501); guard rides the SQL.
    expect(db.rows.get(r.appt_id).rescheduled_from_appt_id).toBe(502);
    const stamp = db.connCalls.find((c) => /^UPDATE appts SET rescheduled_from_appt_id/.test(c.sql));
    expect(stamp.sql).toMatch(/AND rescheduled_from_appt_id IS NULL$/);
    expect(stamp.params).toEqual([502, r.appt_id]);

    // §4 projection — same statement as ever, now keyed on the registry key.
    const proj = db.connCalls.find((c) => /^UPDATE cases SET case_341_current/.test(c.sql));
    expect(proj.params).toEqual(['2026-09-10 14:00:00', r.appt_id, 'X1CASEID']);   // canonicalized date, same as ever

    // Post-commit reasons are the type-neutral ones.
    expect(sequenceEngine.cancelByApptId.mock.calls.map((c) => [c[1], c[2]]))
      .toEqual([[501, 'singleton_superseded'], [502, 'singleton_superseded']]);
    const supLogs = logCalls().filter((c) => c.data && c.data.Reason);
    expect(supLogs.map((c) => c.data.Reason)).toEqual(['singleton_superseded', 'singleton_superseded']);

    // Emits: scheduled FIRST, then one rescheduled per predecessor, with the
    // inline extra literal the registry scanner pins.
    expect(calEmitNames()).toEqual(['calendar.scheduled', 'calendar.rescheduled', 'calendar.rescheduled']);
    const res = emits('calendar.rescheduled');
    expect(res.map((e) => e.data.source_id)).toEqual([501, 502]);
    for (const e of res) {
      expect(e.extra).toEqual({ via: 'singleton', superseded_by: r.appt_id, reason: 'rescheduled' });
      expect(e.data.state).toBe('superseded');
      expect(e.data.status).toBe('Rescheduled');
    }
    // The docket-linked predecessor's envelope anchors honestly.
    expect(res[1].data.link_type).toBe('case_number');
    expect(res[1].data.docket).toBe('26-1000-mlo');
    expect(db.unmatched).toEqual([]);
  });

  test('a docket-anchored CREATE that resolves supersedes cross-form too (docket in, case-linked prior out)', async () => {
    const db = makeDb([PRIORS[0]], { cases: [STALE_CASE] });
    const r = await apptService.createAppt(db, {
      appt_length: 30, appt_platform: 'telephone', appt_date: '2026-09-10 14:00',
      appt_type: '341 Meeting', docket: '26-1000',
    });
    await flush();
    expect(r.superseded).toEqual([501]);
    // resolvedCaseRow from the anchor is REUSED — no second case read on the conn.
    expect(db.connCalls.filter((c) => /^SELECT case_id, case_number/.test(c.sql))).toHaveLength(0);
    expect(db.poolCalls.filter((c) => /FROM cases WHERE case_number = \?/.test(c.sql))).toHaveLength(1);
  });

  test('a 341 with NO priors still projects (the mirror tracks the live 341, not the supersession)', async () => {
    const db = makeDb([], { cases: [STALE_CASE] });
    const r = await apptService.createAppt(db, { ...BASE, appt_type: '341 Meeting', case_id: 'X1CASEID' });
    await flush();
    expect(r.superseded).toEqual([]);
    expect(db.connCalls.some((c) => /^UPDATE cases SET case_341_current/.test(c.sql))).toBe(true);
    expect(db.rows.get(r.appt_id).rescheduled_from_appt_id).toBeNull();   // no stamp without a predecessor
  });

  test('a CONTACT-ONLY 341 gets no singleton check and no projection (no case → no identity)', async () => {
    const db = makeDb(PRIORS, { cases: [STALE_CASE] });
    const r = await apptService.createAppt(db, { ...BASE, appt_type: '341 Meeting' });   // contact only
    await flush();
    expect(r.superseded).toEqual([]);
    expect(db.connCalls.some((c) => /SELECT a\.\* FROM appts a/.test(c.sql))).toBe(false);
    expect(db.connCalls.some((c) => /UPDATE cases SET case_341_current/.test(c.sql))).toBe(false);
    expect(db.rows.get(501).appt_status).toBe('Scheduled');
  });

  test('a NON-singleton type on a case: no priors query, no projection, no legacy block', async () => {
    const db = makeDb(PRIORS, { cases: [STALE_CASE] });
    await apptService.createAppt(db, { ...BASE, appt_type: 'Consultation', case_id: 'X1CASEID' });
    await flush();
    expect(db.connCalls.some((c) => /SELECT a\.\* FROM appts a/.test(c.sql))).toBe(false);
    expect(db.connCalls.some((c) => /UPDATE cases/.test(c.sql))).toBe(false);
    expect(db.connCalls.some((c) => /JOIN appts a ON/.test(c.sql))).toBe(false);
  });

  test('a caller-named predecessor (hook_rescheduled_from) is never overwritten by the stamp', async () => {
    const db = makeDb(PRIORS, { cases: [STALE_CASE] });
    const r = await apptService.createAppt(db, {
      ...BASE, appt_type: '341 Meeting', case_id: 'X1CASEID', hook_rescheduled_from: 501,
    });
    await flush();
    expect(db.rows.get(r.appt_id).rescheduled_from_appt_id).toBe(501);   // the INSERT's own value
    expect(db.connCalls.some((c) => /^UPDATE appts SET rescheduled_from_appt_id/.test(c.sql))).toBe(false);
  });

  test('>1 priors warns and supersedes all (belt and braces, not normal life)', async () => {
    const db = makeDb(PRIORS, { cases: [STALE_CASE] });
    await apptService.createAppt(db, { ...BASE, appt_type: '341 Meeting', case_id: 'X1CASEID' });
    await flush();
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/singleton: appt \d+ \(meeting_341\) found 2 prior live rows/));
  });

  test('registry blip under the flag: fail-soft — no supersession, no crash, appt still created', async () => {
    calendarTypeService.invalidate();
    const db = makeDb(PRIORS, { cases: [STALE_CASE] });
    // The registry read hits the stub and finds no calendar_item_types route →
    // unmatched (tolerated here) + empty result → type_key null → no singleton.
    const r = await apptService.createAppt(db, { ...BASE, appt_type: '341 Meeting', case_id: 'X1CASEID' });
    await flush();
    expect(r.appt_id).toBeGreaterThan(0);
    expect(r.superseded).toEqual([]);
    expect(db.rows.get(501).appt_status).toBe('Scheduled');
    calendarTypeService._primeCache(SEED);
  });
});
