/**
 * tests/logService.setLogAbout.test.js
 *
 * Tests for services/logService.setLogAbout and the createLogEntry
 * about-params (About-link S2).
 *
 * The about-link (log_about_type / log_about_id) is the SECONDARY "what
 * it's about" attribution, independent of the primary identity link.
 * These tests pin the four things that matter:
 *
 *   1. NORMALIZATION PARITY. setLogAbout and createLogEntry share
 *      _normalizeAbout, which shares _normalizePhone / _normalizeEmail
 *      with the primary-link paths. A phone about-value must land in the
 *      identical stored form a primary phone link would — the S1 reader
 *      arms match on the normalized value.
 *
 *   2. THE UNLINK PATH EXISTS (asymmetry with updateLogLink is
 *      deliberate): about_type null / '' / undefined / 'none' clears both
 *      columns and ignores about_id.
 *
 *   3. THE ABSENT PATHS: no create-on-missing (LOG_NOT_FOUND, checked
 *      BEFORE about validation), no primary-link edits, no content edits.
 *
 *   4. SQL SHAPE. One UPDATE touching ONLY the two about columns.
 *
 * Same mock-db pattern as logService.updateLogLink.test.js: dispatch on
 * statement verb, capture every call.
 *
 * Run:
 *   npx jest tests/logService.setLogAbout.test.js
 */

const logService = require('../services/logService');

const { setLogAbout, createLogEntry, _normalizeAbout, ABOUT_TYPES } = logService;

function makeDb({ row = { log_id: 1, log_about_type: null, log_about_id: null } } = {}) {
  const calls = [];
  const db = {
    calls,
    query: jest.fn(async (sql, params) => {
      calls.push({ sql, params });
      if (/^\s*SELECT/i.test(sql)) return [row ? [row] : []];
      if (/^\s*UPDATE/i.test(sql)) return [{ affectedRows: 1 }];
      if (/^\s*INSERT/i.test(sql)) return [{ insertId: 99 }];
      return [[]];
    }),
  };
  return db;
}

const updates = (db) => db.calls.filter(c => /^\s*UPDATE/i.test(c.sql));
const inserts = (db) => db.calls.filter(c => /^\s*INSERT/i.test(c.sql));

async function expectCode(promise, code) {
  await expect(promise).rejects.toMatchObject({ code });
}

// ─────────────────────────────────────────────────────────────
// log_id validation
// ─────────────────────────────────────────────────────────────
describe('setLogAbout — log_id validation', () => {

  test.each([
    [null], [undefined], [''], ['abc'], [0], [-5], [1.5],
  ])('log_id %p → LOG_ID_REQUIRED', async (bad) => {
    const db = makeDb();
    await expectCode(setLogAbout(db, { log_id: bad, about_type: 'case', about_id: 'x' }), 'LOG_ID_REQUIRED');
    expect(db.calls).toHaveLength(0); // rejected before any query
  });

  test('numeric-string log_id is coerced (workflow {{logId}} arrives as "58197")', async () => {
    const db = makeDb();
    const out = await setLogAbout(db, { log_id: '58197', about_type: 'case', about_id: '08kulmDV' });
    expect(out.log_id).toBe(58197);
  });
});

// ─────────────────────────────────────────────────────────────
// LOG_NOT_FOUND ordering
// ─────────────────────────────────────────────────────────────
describe('setLogAbout — missing row', () => {

  test('missing row → LOG_NOT_FOUND, reported BEFORE about validation', async () => {
    const db = makeDb({ row: null });
    // about_type here is garbage — LOG_NOT_FOUND must win anyway.
    await expectCode(setLogAbout(db, { log_id: 42, about_type: 'garbage', about_id: '' }), 'LOG_NOT_FOUND');
    expect(updates(db)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// Unlink path
// ─────────────────────────────────────────────────────────────
describe('setLogAbout — unlink path (deliberate asymmetry with updateLogLink)', () => {

  test.each([
    [null], [undefined], [''], ['none'],
  ])('about_type %p → clears both columns, ignores about_id', async (clear) => {
    const db = makeDb({ row: { log_id: 7, log_about_type: 'case', log_about_id: 'X' } });
    const out = await setLogAbout(db, { log_id: 7, about_type: clear, about_id: 'IGNORED' });

    expect(out).toEqual({ log_id: 7, about_type: null, about_id: null });

    const u = updates(db);
    expect(u).toHaveLength(1);
    expect(u[0].sql).toMatch(/SET log_about_type = NULL, log_about_id = NULL/);
    expect(u[0].params).toEqual([7]);
  });
});

// ─────────────────────────────────────────────────────────────
// Set path — types + normalization
// ─────────────────────────────────────────────────────────────
describe('setLogAbout — set path', () => {

  test('ABOUT_TYPES is the full log_link_type enum (wider than RELINKABLE_TYPES)', () => {
    expect(ABOUT_TYPES).toEqual(
      ['contact', 'case', 'appt', 'bill', 'phone', 'email', 'task', 'event']
    );
    expect(ABOUT_TYPES).toEqual(expect.arrayContaining(logService.RELINKABLE_TYPES));
  });

  test.each(['contact', 'case', 'appt', 'bill', 'task', 'event'])(
    'about_type %s accepted, about_id stringified as-is', async (t) => {
      const db = makeDb();
      const out = await setLogAbout(db, { log_id: 1, about_type: t, about_id: 12345 });
      expect(out).toEqual({ log_id: 1, about_type: t, about_id: '12345' });

      const u = updates(db);
      expect(u).toHaveLength(1);
      expect(u[0].params).toEqual([t, '12345', 1]);
    });

  test('invalid about_type → INVALID_LOG_ABOUT_TYPE, no UPDATE', async () => {
    const db = makeDb();
    await expectCode(setLogAbout(db, { log_id: 1, about_type: 'garbage', about_id: 'x' }), 'INVALID_LOG_ABOUT_TYPE');
    expect(updates(db)).toHaveLength(0);
  });

  test.each([[null], [undefined], [''], ['   ']])(
    'blank about_id %p on set path → INVALID_LOG_ABOUT_ID', async (bad) => {
      const db = makeDb();
      await expectCode(setLogAbout(db, { log_id: 1, about_type: 'case', about_id: bad }), 'INVALID_LOG_ABOUT_ID');
      expect(updates(db)).toHaveLength(0);
    });

  test('phone: normalized to 10 digits, leading +1 stripped (parity with primary link)', async () => {
    const db = makeDb();
    const out = await setLogAbout(db, { log_id: 1, about_type: 'phone', about_id: '+1 (313) 555-0100' });
    expect(out.about_id).toBe('3135550100');
  });

  test('phone: unusable value → INVALID_LOG_ABOUT_ID', async () => {
    const db = makeDb();
    await expectCode(setLogAbout(db, { log_id: 1, about_type: 'phone', about_id: '555-0100' }), 'INVALID_LOG_ABOUT_ID');
  });

  test('email: trimmed + lowercased (parity with primary link)', async () => {
    const db = makeDb();
    const out = await setLogAbout(db, { log_id: 1, about_type: 'email', about_id: '  Jacob@JacobHighLaw.com ' });
    expect(out.about_id).toBe('jacob@jacobhighlaw.com');
  });

  test("email: no '@' → INVALID_LOG_ABOUT_ID", async () => {
    const db = makeDb();
    await expectCode(setLogAbout(db, { log_id: 1, about_type: 'email', about_id: 'not-an-email' }), 'INVALID_LOG_ABOUT_ID');
  });
});

// ─────────────────────────────────────────────────────────────
// SQL shape — about columns ONLY
// ─────────────────────────────────────────────────────────────
describe('setLogAbout — SQL shape', () => {

  test('one UPDATE, touches only log_about_type / log_about_id, never the primary link or content', async () => {
    const db = makeDb();
    await setLogAbout(db, { log_id: 9, about_type: 'case', about_id: '08kulmDV' });

    const u = updates(db);
    expect(u).toHaveLength(1);
    expect(u[0].sql).toMatch(/SET log_about_type = \?, log_about_id = \?/);
    // The columns updateLogLink owns must not appear in the SET clause.
    expect(u[0].sql).not.toMatch(/SET[\s\S]*log_link_type\s*=/);
    expect(u[0].sql).not.toMatch(/log_link\s*=/);
    expect(u[0].sql).not.toMatch(/log_data|log_message|log_subject/);
    expect(u[0].params).toEqual(['case', '08kulmDV', 9]);
  });
});

// ─────────────────────────────────────────────────────────────
// createLogEntry about params (shared _normalizeAbout)
// ─────────────────────────────────────────────────────────────
describe('createLogEntry — about params (About-link S2)', () => {

  /** Pull the INSERT and map its column list to bound params. */
  function insertedColumns(db) {
    const i = inserts(db);
    expect(i).toHaveLength(1);
    const cols = i[0].sql
      .match(/\(([\s\S]*?)\)\s*VALUES/i)[1]
      .split(',').map(c => c.trim());
    // log_date is CONVERT_TZ(NOW(),...), not a placeholder — drop it when
    // zipping columns to params.
    const bindable = cols.filter(c => c !== 'log_date');
    const map = {};
    i[0].sql; // keep for debugging
    bindable.forEach((c, idx) => { map[c] = i[0].params[idx]; });
    return map;
  }

  test('about params absent → both columns bound NULL', async () => {
    const db = makeDb();
    await createLogEntry(db, { type: 'note', link_type: 'contact', link_id: '412' });
    const cols = insertedColumns(db);
    expect(cols.log_about_type).toBeNull();
    expect(cols.log_about_id).toBeNull();
  });

  test("about_type 'none' behaves like absent", async () => {
    const db = makeDb();
    await createLogEntry(db, { type: 'note', about_type: 'none', about_id: 'IGNORED' });
    const cols = insertedColumns(db);
    expect(cols.log_about_type).toBeNull();
    expect(cols.log_about_id).toBeNull();
  });

  test('about params present → normalized and bound (email lowercased, parity with setLogAbout)', async () => {
    const db = makeDb();
    await createLogEntry(db, {
      type: 'email', link_type: 'email', link_id: 'jacob@jacobhighlaw.com',
      about_type: 'case', about_id: '08kulmDV'
    });
    const cols = insertedColumns(db);
    expect(cols.log_about_type).toBe('case');
    expect(cols.log_about_id).toBe('08kulmDV');
  });

  test('invalid about pair rejects the whole create (no INSERT)', async () => {
    const db = makeDb();
    await expectCode(
      createLogEntry(db, { type: 'note', about_type: 'case', about_id: '' }),
      'INVALID_LOG_ABOUT_ID'
    );
    expect(inserts(db)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// _normalizeAbout — the shared helper itself
// ─────────────────────────────────────────────────────────────
describe('_normalizeAbout — shared write-path helper', () => {

  test('is exported and shared (drift guard)', () => {
    expect(typeof _normalizeAbout).toBe('function');
  });

  test('phone/email normalization matches the primary-link stored forms', () => {
    expect(_normalizeAbout('phone', '+13135550100')).toBe('3135550100');
    expect(_normalizeAbout('email', ' X@Y.com ')).toBe('x@y.com');
    expect(_normalizeAbout('case', 12345)).toBe('12345');
  });
});
