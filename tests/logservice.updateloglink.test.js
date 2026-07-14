/**
 * Tests for services/logService.updateLogLink (params-mapping Slice, Part D).
 *
 * updateLogLink is RE-LINK ONLY: it writes log_link_type / log_link_id /
 * log_link and nothing else. These tests pin the three things that matter:
 *
 *   1. NORMALIZATION PARITY with createLogEntry. Both paths share
 *      _normalizePhone / _normalizeEmail and the same log_link mirror rule, so
 *      a phone written by create_log and re-linked by update_log MUST land in
 *      the identical stored form. A drift here produces orphan log rows that
 *      the contact/case log readers silently miss (_buildContactLogWhere joins
 *      on the normalized value), which is the exact bug class Track A.1 Phase A
 *      closed for creates.
 *
 *   2. THE ABSENT PATHS. No unlink (link_id required, non-blank), no
 *      create-on-missing (LOG_NOT_FOUND), no content edits. Asserting these
 *      throw is what keeps the surface from quietly growing.
 *
 *   3. SQL SHAPE. One UPDATE, four bound params, correct order.
 *
 * logService has zero module-level requires (it takes `db` by injection), so
 * this suite mocks db.query and needs no env vars — unlike
 * internal_functions.meta.test.js, which pulls the whole registry.
 */
/*
# jest is a committed devDependency (package.json: "jest": "^30.4.2").
npx jest tests/logService.updateLogLink.test.js
*/

const logService = require('../services/logService');

// ─────────────────────────────────────────────────────────────
// Mock db. Dispatches on the statement verb:
//   SELECT → getLogEntry's `const [[entry]] = await db.query(...)`, so the
//            shape must be [[row]] (or [[]] for "no such row").
//   UPDATE → [{ affectedRows }]
// Every call is captured so the tests can assert the SQL and its bound params.
// ─────────────────────────────────────────────────────────────
function makeDb({ row = { log_id: 1, log_link_type: 'phone', log_link_id: '3135550100' } } = {}) {
  const calls = [];
  const db = {
    calls,
    query: jest.fn(async (sql, params) => {
      calls.push({ sql, params });
      if (/^\s*SELECT/i.test(sql)) return [row ? [row] : []];
      if (/^\s*UPDATE/i.test(sql)) return [{ affectedRows: 1 }];
      return [[]];
    }),
  };
  return db;
}

const updates = (db) => db.calls.filter(c => /^\s*UPDATE/i.test(c.sql));

// Bound-param order in the UPDATE is [link_type, link_id, log_link, log_id].
function boundUpdate(db) {
  const u = updates(db);
  expect(u).toHaveLength(1);
  const [link_type, log_link_id, log_link, log_id] = u[0].params;
  return { sql: u[0].sql, link_type, log_link_id, log_link, log_id };
}

async function expectCode(promise, code) {
  await expect(promise).rejects.toMatchObject({ code });
}


describe('updateLogLink — happy path per link_type', () => {
  test.each([
    ['contact', '412',      '412'],
    ['case',    'a1B2c3D4', 'a1B2c3D4'],   // case_id is 8-char base64url, not numeric
    ['appt',    '9021',     '9021'],
    ['bill',    '77',       '77'],
  ])('%s → stores link_id as-is and MIRRORS it into log_link', async (link_type, input, expected) => {
    const db = makeDb();
    const out = await logService.updateLogLink(db, { log_id: 58197, link_type, link_id: input });

    expect(out).toEqual({ log_id: 58197, link_type, link_id: expected });

    const u = boundUpdate(db);
    expect(u.link_type).toBe(link_type);
    expect(u.log_link_id).toBe(expected);
    expect(u.log_link).toBe(expected);       // entity types mirror
    expect(u.log_id).toBe(58197);
  });

  test.each([
    ['phone', '3135550100'],
    ['email', 'a@b.com'],
  ])('%s → SUPPRESSES the legacy log_link mirror (forced to empty string)', async (link_type, value) => {
    const db = makeDb();
    await logService.updateLogLink(db, { log_id: 1, link_type, link_id: value });

    const u = boundUpdate(db);
    expect(u.log_link_id).toBe(value);
    expect(u.log_link).toBe('');             // NOT the value — matches createLogEntry
  });
});


describe('updateLogLink — phone normalization (parity with createLogEntry)', () => {
  test.each([
    ['formatted',        '(313) 555-0100',   '3135550100'],
    ['dashed',           '313-555-0100',     '3135550100'],
    ['e164',             '+1 313 555 0100',  '3135550100'],
    ['leading 1',        '13135550100',      '3135550100'],
    ['already 10 digits','3135550100',       '3135550100'],
    ['numeric input',     3135550100,        '3135550100'],
  ])('%s: %s → %s', async (_label, input, expected) => {
    const db = makeDb();
    const out = await logService.updateLogLink(db, { log_id: 1, link_type: 'phone', link_id: input });

    expect(out.link_id).toBe(expected);
    expect(boundUpdate(db).log_link_id).toBe(expected);
  });

  test.each([
    ['too short',        '555'],
    ['too long',         '131355501001'],
    ['no digits at all', 'not-a-phone'],
  ])('%s (%s) → INVALID_LOG_LINK_ID, and NO update is issued', async (_label, bad) => {
    const db = makeDb();
    await expectCode(
      logService.updateLogLink(db, { log_id: 1, link_type: 'phone', link_id: bad }),
      'INVALID_LOG_LINK_ID'
    );
    expect(updates(db)).toHaveLength(0);
  });
});


describe('updateLogLink — email normalization (parity with createLogEntry)', () => {
  test.each([
    ['upper + padded', '  Foo@BAR.com ', 'foo@bar.com'],
    ['mixed case',     'A.B@Example.COM', 'a.b@example.com'],
  ])('%s: %j → %s', async (_label, input, expected) => {
    const db = makeDb();
    const out = await logService.updateLogLink(db, { log_id: 1, link_type: 'email', link_id: input });

    expect(out.link_id).toBe(expected);
    expect(boundUpdate(db).log_link_id).toBe(expected);
  });

  test('no @ → INVALID_LOG_LINK_ID, and NO update is issued', async () => {
    const db = makeDb();
    await expectCode(
      logService.updateLogLink(db, { log_id: 1, link_type: 'email', link_id: 'nope' }),
      'INVALID_LOG_LINK_ID'
    );
    expect(updates(db)).toHaveLength(0);
  });
});


describe('updateLogLink — rejections', () => {
  test('missing row → LOG_NOT_FOUND (never creates one)', async () => {
    const db = makeDb({ row: null });
    await expectCode(
      logService.updateLogLink(db, { log_id: 999999, link_type: 'contact', link_id: '412' }),
      'LOG_NOT_FOUND'
    );
    expect(updates(db)).toHaveLength(0);
  });

  test.each([
    ['undefined',   undefined],
    ['null',        null],
    ['empty',       ''],
    ['zero',        0],
    ['negative',    -1],
    ['non-numeric', 'abc'],
  ])('log_id %s → LOG_ID_REQUIRED, and the DB is never touched', async (_label, log_id) => {
    const db = makeDb();
    await expectCode(
      logService.updateLogLink(db, { log_id, link_type: 'contact', link_id: '412' }),
      'LOG_ID_REQUIRED'
    );
    expect(db.query).not.toHaveBeenCalled();   // fails before the existence check
  });

  test.each([
    ['blank',       '   '],
    ['empty',       ''],
    ['null',        null],
    ['undefined',   undefined],
  ])('link_id %s → INVALID_LOG_LINK_ID (there is no unlink path)', async (_label, link_id) => {
    const db = makeDb();
    await expectCode(
      logService.updateLogLink(db, { log_id: 1, link_type: 'contact', link_id }),
      'INVALID_LOG_LINK_ID'
    );
    expect(db.query).not.toHaveBeenCalled();
  });

  test.each([
    ['omitted',    undefined],
    ['nonsense',   'nonsense'],
    ['task',       'task'],    // valid in the DB column, deliberately not re-linkable
    ['event',      'event'],   // ditto
  ])('link_type %s → INVALID_LOG_LINK_TYPE', async (_label, link_type) => {
    const db = makeDb();
    await expectCode(
      logService.updateLogLink(db, { log_id: 1, link_type, link_id: '412' }),
      'INVALID_LOG_LINK_TYPE'
    );
    expect(db.query).not.toHaveBeenCalled();
  });

  test('called with no args at all → LOG_ID_REQUIRED, not a TypeError', async () => {
    const db = makeDb();
    await expectCode(logService.updateLogLink(db), 'LOG_ID_REQUIRED');
  });
});


describe('updateLogLink — SQL shape', () => {
  test('issues exactly one SELECT then one UPDATE, touching only the 3 link columns', async () => {
    const db = makeDb();
    await logService.updateLogLink(db, { log_id: 58197, link_type: 'contact', link_id: '412' });

    expect(db.calls).toHaveLength(2);
    expect(db.calls[0].sql).toMatch(/^\s*SELECT/i);
    expect(db.calls[1].sql).toMatch(/^\s*UPDATE/i);

    const { sql } = boundUpdate(db);
    expect(sql).toMatch(/UPDATE\s+log/i);
    expect(sql).toMatch(/log_link_type\s*=\s*\?/);
    expect(sql).toMatch(/log_link_id\s*=\s*\?/);
    expect(sql).toMatch(/log_link\s*=\s*\?/);
    expect(sql).toMatch(/WHERE\s+log_id\s*=\s*\?/i);

    // RE-LINK ONLY — none of the content columns may appear in the SET clause.
    const setClause = sql.slice(sql.search(/SET/i), sql.search(/WHERE/i));
    for (const col of ['log_type', 'log_data', 'log_extra', 'log_from', 'log_to',
                       'log_subject', 'log_message', 'log_direction', 'log_by', 'log_date']) {
      expect(setClause).not.toContain(col);
    }
  });

  test('coerces a resolved-placeholder string log_id to a number', async () => {
    const db = makeDb();
    const out = await logService.updateLogLink(db, { log_id: '58197', link_type: 'contact', link_id: '412' });

    expect(out.log_id).toBe(58197);
    expect(boundUpdate(db).log_id).toBe(58197);
    expect(db.calls[0].params).toEqual([58197]);   // the existence-check SELECT
  });
});


describe('updateLogLink — exported contract', () => {
  test('RELINKABLE_TYPES is the six entity types (task/event excluded on purpose)', () => {
    expect(logService.RELINKABLE_TYPES)
      .toEqual(['contact', 'case', 'appt', 'bill', 'phone', 'email']);
  });

  test('every RELINKABLE_TYPE actually round-trips', async () => {
    for (const link_type of logService.RELINKABLE_TYPES) {
      const db = makeDb();
      const link_id = link_type === 'phone' ? '3135550100'
                    : link_type === 'email' ? 'a@b.com'
                    : '412';
      const out = await logService.updateLogLink(db, { log_id: 1, link_type, link_id });
      expect(out.link_type).toBe(link_type);
      expect(updates(db)).toHaveLength(1);
    }
  });
});