// tests/apptService.lineage.test.js
//
/**
 * E0a — RESCHEDULE LINEAGE  (unified events design §3.4)
 *
 * Pins one promise: a successor appointment row records WHICH appointment it
 * replaced, in the column `appts.rescheduled_from_appt_id`.
 *
 * WHY IT IS ASSERTED AT THE INSERT AND NOT AFTERWARDS
 *   Before E0a the predecessor id existed only in two transient places — the
 *   fire-and-forget view-hook payload and the appt.created trigger envelope's
 *   `extra`. Neither survives on the row. The fix persists it as a column
 *   PASSTHROUGH inside createAppt's existing INSERT, rather than as a
 *   post-insert UPDATE, because BOTH successor-creation sites already funnel
 *   through createAppt with hook_rescheduled_from set:
 *
 *     services/apptService.rescheduleAppt   → hook_event 'rescheduled'
 *     routes/manage.js  (client rebook)     → hook_event 'rebooked'
 *
 *   A post-insert UPDATE in rescheduleAppt would have covered the first site
 *   only. So the tests below assert on the INSERT's bind array, and assert
 *   POSITIVELY that no separate `UPDATE appts SET rescheduled_from_appt_id`
 *   statement exists anywhere — if someone later "simplifies" the passthrough
 *   into an UPDATE, the rebook path silently loses its lineage and this file
 *   is what says so.
 *
 *   The rebook case is exercised by calling createAppt with exactly the
 *   argument shape routes/manage.js passes (hook_event 'rebooked',
 *   source 'client'). That is a deliberate stand-in, not the route itself:
 *   this is a service unit test. If manage.js ever stops passing
 *   hook_rescheduled_from, THIS FILE WILL STILL PASS — the guard for that is
 *   the live gate in ref/2026-08-27_unified_events_e0a.sql.
 *
 * ── STUB POSTURE ────────────────────────────────────────────────────────────
 *   No DB, no network. `db` is a SQL-matching router (the makeDb idiom from
 *   tests/esignProvider.zoho.test.js) — deliberately NOT the ordered-script
 *   `.shift()` idiom, so there is no fixture-drift surface and no scriptGuard
 *   registration needed (see tests/helpers/scriptGuard.js for why that idiom
 *   is dangerous). Anything the router does not recognise is recorded in
 *   `db.unmatched` and every test asserts that list is empty — createAppt's
 *   post-commit work is fire-and-forget with .catch(), so a THROWING stub
 *   would be swallowed and prove nothing. Recording is the loud option.
 *
 * Run:
 *   npx jest tests/apptService.lineage.test.js
 */

'use strict';

jest.mock('../services/settingsService', () => ({
  // Empty settings ⇒ office_alerts_to unset ⇒ notifyStaffOfClientAction
  // returns before touching the DB. Keeps the 'client'-source rebook test
  // focused on the write under test.
  getSettings: jest.fn(async () => ({})),
}));

jest.mock('../services/phoneService', () => ({ sendSms: jest.fn(async () => ({})) }));
jest.mock('../services/emailService', () => ({ sendEmail: jest.fn(async () => ({})) }));

jest.mock('../services/gcalService', () => ({
  createEvent:     jest.fn(async () => ({ id: 'gcal-evt-1' })),
  deleteEvent:     jest.fn(async () => ({})),
  _resolveTarget:  jest.fn(async () => ({ calendarId: 'firm@example.com' })),
}));

jest.mock('../services/taskService', () => ({
  createTask: jest.fn(async () => ({ task_id: 4242 })),
}));

jest.mock('../services/logService', () => ({
  createLogEntry: jest.fn(async () => ({ log_id: 1 })),
}));

jest.mock('../services/resolverService', () => ({ resolve: jest.fn(async (s) => s) }));

// Lazy-required inside apptService (circular-dependency guards) — mocked by
// resolved path all the same.
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

const apptService = require('../services/apptService');

// ─────────────────────────────────────────────────────────────────────────────
// Stubs
// ─────────────────────────────────────────────────────────────────────────────

const CONTACT_ID = 77;

/** A pre-existing appt row the successor will be created from. */
function existingAppt(overrides = {}) {
  return {
    appt_id:        501,
    appt_client_id: CONTACT_ID,
    appt_case_id:   '',
    appt_type:      'Consultation',
    appt_length:    30,
    appt_platform:  'Zoom',
    appt_date:      '2026-09-01 10:00:00',
    appt_status:    'Scheduled',
    appt_with:      1,
    appt_note:      '',
    appt_gcal:      '',
    appt_gcal_user: null,
    appt_view_id:   null,
    rescheduled_from_appt_id: null,
    ...overrides,
  };
}

/**
 * SQL-matching router over an in-memory `appts` map. Records pool-level and
 * transaction-level calls separately — the split is load-bearing for the
 * "lineage lands inside the transaction" assertion.
 */
function makeDb(seedRows = []) {
  const poolCalls = [];
  const connCalls = [];
  const unmatched = [];
  const rows = new Map(seedRows.map((r) => [Number(r.appt_id), { ...r }]));
  let nextInsertId = 900;

  const handler = (log) => async (sql, params = []) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    log.push({ sql: flat, params });

    if (/^INSERT INTO appts/i.test(flat)) {
      const id = ++nextInsertId;
      rows.set(id, {
        appt_id:        id,
        appt_client_id: params[0],
        appt_case_id:   params[1],
        appt_type:      params[2],
        appt_length:    params[3],
        appt_platform:  params[4],
        appt_date:      params[5],
        appt_status:    'Scheduled',
        appt_with:      params[7],
        appt_note:      params[8],
        appt_gcal:      '',
        appt_gcal_user: null,
        appt_view_id:   params[12],
        rescheduled_from_appt_id: params[13],
      });
      return [{ insertId: id, affectedRows: 1 }];
    }

    if (/^SELECT \* FROM appts WHERE appt_id/i.test(flat)) {
      const row = rows.get(Number(params[0]));
      return [row ? [row] : []];
    }

    // insertApptLog's fetch
    if (/^SELECT appt_client_id, appt_case_id, appt_type, appt_date FROM appts/i.test(flat)) {
      const row = rows.get(Number(params[0]));
      return [row ? [row] : []];
    }

    // rescheduleLater's fetch
    if (/^SELECT appt_id, appt_client_id, appt_case_id, appt_type, appt_gcal/i.test(flat)) {
      const row = rows.get(Number(params[0]));
      return [row ? [row] : []];
    }

    if (/^UPDATE appts SET appt_status = 'Rescheduled'/i.test(flat)) {
      const row = rows.get(Number(params[1]));
      if (row) row.appt_status = 'Rescheduled';
      return [{ affectedRows: row ? 1 : 0 }];
    }

    if (/^UPDATE appts SET appt_gcal(_user)? = \?/i.test(flat)) {
      return [{ affectedRows: 1 }];
    }

    // resolveProviderCalendarId — no provider calendar ⇒ clean skip of the
    // second (bare) GCal write.
    if (/^SELECT user_gcal_id FROM users WHERE user = \?/i.test(flat)) {
      return [[]];
    }

    if (/^SELECT contact_name, contact_email FROM contacts/i.test(flat)) {
      return [[{ contact_name: 'Test Client', contact_email: 'client@example.test' }]];
    }

    unmatched.push(flat);
    return [[]];
  };

  const conn = {
    query:            handler(connCalls),
    beginTransaction: async () => {},
    commit:           async () => {},
    rollback:         async () => {},
    release:          () => {},
    destroy:          () => {},
  };

  return {
    poolCalls,
    connCalls,
    unmatched,
    rows,
    query: handler(poolCalls),
    getConnection: async () => conn,
    withTransaction: async (fn) => fn(conn),
  };
}

/** Let createAppt's post-commit fire-and-forget IIFEs settle. */
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};

/** The one INSERT INTO appts the call under test issued (or undefined). */
function apptInsert(db) {
  const hits = db.connCalls.concat(db.poolCalls)
    .filter((c) => /^INSERT INTO appts/i.test(c.sql));
  expect(hits.length).toBeLessThanOrEqual(1);
  return hits[0];
}

/**
 * Ordinal of a column among the INSERT's `?` placeholders — i.e. the index
 * into the bind array that column's value must occupy. Derived from the SQL
 * text, NOT hard-coded, so it stays correct when a future slice adds a column
 * ahead of this one. Returns -1 when the column is absent.
 */
function bindIndexOf(insertSql, column) {
  const cols   = /\(([^)]*)\)\s*VALUES/i.exec(insertSql)[1]
    .split(',').map((s) => s.trim().replace(/`/g, ''));
  const values = /VALUES\s*\(([\s\S]*)\)\s*$/i.exec(insertSql)[1]
    .split(',').map((s) => s.trim());
  expect(values).toHaveLength(cols.length);   // structural sanity

  const col = cols.indexOf(column);
  if (col === -1) return -1;
  // The column must be bound, not a literal like 'Scheduled' or NOW().
  expect(values[col]).toBe('?');
  return values.slice(0, col).filter((v) => v === '?').length;
}

const BASE_CREATE = {
  contact_id:    CONTACT_ID,
  appt_length:   30,
  appt_type:     'Consultation',
  appt_platform: 'Zoom',
  appt_date:     '2026-09-10 14:00',
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  console.log.mockRestore();
  console.warn.mockRestore();
  console.error.mockRestore();
});

// ─────────────────────────────────────────────────────────────────────────────
// The INSERT's shape — the drift guard for the passthrough itself
// ─────────────────────────────────────────────────────────────────────────────

describe('createAppt INSERT — structure', () => {
  test('rescheduled_from_appt_id is a BOUND column, and every column has exactly one value', async () => {
    const db = makeDb();
    await apptService.createAppt(db, { ...BASE_CREATE });
    await flush();

    const ins = apptInsert(db);
    expect(ins).toBeDefined();
    // bindIndexOf asserts cols.length === values.length and that this column
    // maps to a `?` rather than a literal.
    expect(bindIndexOf(ins.sql, 'rescheduled_from_appt_id')).toBeGreaterThanOrEqual(0);
  });

  test('placeholder count equals bind count (a column added without its bind fails here)', async () => {
    const db = makeDb();
    await apptService.createAppt(db, { ...BASE_CREATE });
    await flush();

    const ins = apptInsert(db);
    const placeholders = (/VALUES\s*\(([\s\S]*)\)\s*$/i.exec(ins.sql)[1].match(/\?/g) || []).length;
    expect(ins.params).toHaveLength(placeholders);
  });

  test('no stub query went unrouted', async () => {
    const db = makeDb();
    await apptService.createAppt(db, { ...BASE_CREATE });
    await flush();
    expect(db.unmatched).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The four paths
// ─────────────────────────────────────────────────────────────────────────────

describe('E0a lineage — reschedule (rescheduleAppt → createAppt successor)', () => {
  test('the successor row persists the predecessor appt_id', async () => {
    const db = makeDb([existingAppt()]);

    const res = await apptService.rescheduleAppt(db, {
      appt_id: 501,
      newDate: '2026-09-10 14:00',
    });
    await flush();

    const ins = apptInsert(db);
    expect(ins.params[bindIndexOf(ins.sql, 'rescheduled_from_appt_id')]).toBe(501);

    // …and it is readable off the row the caller gets back.
    expect(db.rows.get(res.new_appt_id).rescheduled_from_appt_id).toBe(501);
    expect(res.old_appt_id).toBe(501);
    expect(db.unmatched).toEqual([]);
  });

  test('the predecessor is left Rescheduled and its own lineage is untouched', async () => {
    const db = makeDb([existingAppt()]);
    await apptService.rescheduleAppt(db, { appt_id: 501, newDate: '2026-09-10 14:00' });
    await flush();

    const old = db.rows.get(501);
    expect(old.appt_status).toBe('Rescheduled');
    expect(old.rescheduled_from_appt_id).toBeNull();   // lineage points forward only
  });

  test('lineage is written INSIDE the transaction, not by a follow-up UPDATE', async () => {
    // If someone later replaces the passthrough with a post-insert UPDATE, the
    // rebook path in routes/manage.js silently loses its lineage. This is the
    // assertion that stops it.
    const db = makeDb([existingAppt()]);
    await apptService.rescheduleAppt(db, { appt_id: 501, newDate: '2026-09-10 14:00' });
    await flush();

    expect(db.connCalls.some((c) => /^INSERT INTO appts/i.test(c.sql))).toBe(true);
    expect(db.poolCalls.some((c) => /^INSERT INTO appts/i.test(c.sql))).toBe(false);

    const all = db.connCalls.concat(db.poolCalls);
    expect(all.filter((c) => /rescheduled_from_appt_id/i.test(c.sql) && /^UPDATE/i.test(c.sql)))
      .toEqual([]);
  });
});

describe('E0a lineage — rebook (routes/manage.js argument shape)', () => {
  test('the successor row persists the canceled predecessor appt_id', async () => {
    const db = makeDb([existingAppt({ appt_status: 'Canceled' })]);

    const r = await apptService.createAppt(db, {
      ...BASE_CREATE,
      case_id:               '',
      appt_with:             1,
      note:                  '[Rebooked by client via manage link]',
      appt_view_id:          null,
      hook_event:            'rebooked',
      hook_rescheduled_from: 501,
      actingUserId:          0,
      source:                'client',
    });
    await flush();

    const ins = apptInsert(db);
    expect(ins.params[bindIndexOf(ins.sql, 'rescheduled_from_appt_id')]).toBe(501);
    expect(db.rows.get(r.appt_id).rescheduled_from_appt_id).toBe(501);
    expect(db.unmatched).toEqual([]);
  });

  test('the rebook does NOT flip the predecessor out of Canceled', async () => {
    // manage.js relies on this: the old row already fired its `canceled` hook
    // event, and rewriting its status would falsify that history.
    const db = makeDb([existingAppt({ appt_status: 'Canceled' })]);
    await apptService.createAppt(db, {
      ...BASE_CREATE, hook_event: 'rebooked', hook_rescheduled_from: 501, source: 'client',
    });
    await flush();

    expect(db.rows.get(501).appt_status).toBe('Canceled');
  });
});

describe('E0a lineage — the paths that must stay NULL', () => {
  test('a plain create binds NULL, not 0 and not undefined', async () => {
    const db = makeDb();
    const r = await apptService.createAppt(db, { ...BASE_CREATE });
    await flush();

    const ins = apptInsert(db);
    expect(ins.params[bindIndexOf(ins.sql, 'rescheduled_from_appt_id')]).toBeNull();
    expect(db.rows.get(r.appt_id).rescheduled_from_appt_id).toBeNull();
  });

  test('rescheduleLater creates no successor at all, so nothing is written', async () => {
    const db = makeDb([existingAppt()]);
    const res = await apptService.rescheduleLater(db, { appt_id: 501 });
    await flush();

    expect(apptInsert(db)).toBeUndefined();
    expect(db.rows.get(501).appt_status).toBe('Rescheduled');
    expect(db.rows.get(501).rescheduled_from_appt_id).toBeNull();
    expect(res.appt_id).toBe(501);
    expect(db.unmatched).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Coercion — mirrors the appt_view_id idiom exactly
// ─────────────────────────────────────────────────────────────────────────────

describe('E0a lineage — hook_rescheduled_from coercion', () => {
  const cases = [
    ['a positive number',              501,          501],
    ['a numeric string (JSON caller)', '501',        501],
    ['the default',                    undefined,    null],
    ['explicit null',                  null,         null],
    ['zero',                           0,            null],
    ['string zero',                    '0',          null],
    ['a negative id',                  -3,           null],
    ['a non-numeric string',           'nope',       null],
    ['a fractional id',                12.5,         null],
  ];

  test.each(cases)('%s → %p stores %p', async (_label, input, expected) => {
    const db = makeDb();
    const args = { ...BASE_CREATE };
    if (input !== undefined) args.hook_rescheduled_from = input;

    await apptService.createAppt(db, args);
    await flush();

    const ins = apptInsert(db);
    expect(ins.params[bindIndexOf(ins.sql, 'rescheduled_from_appt_id')]).toBe(expected);
    expect(db.unmatched).toEqual([]);
  });
});
