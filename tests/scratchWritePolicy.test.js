// tests/scratchWritePolicy.test.js
//
/**
 * rw_scratch is not an automation-writable table (settings-access
 * investigation, Fred 2026-10-28).
 *
 * rw_scratch is the store AI sessions boot from and read as trusted (manager
 * arc state, the doc-debt queue). Any staff JWT can run an internal_function
 * step through POST /workflows/test-step, so while update_db / insert_db listed
 * rw_scratch in WRITE_POLICY any staff member could rewrite another arc's state.
 * Its writers are the keyed /api/scratch routes and the SU scratch browser only.
 *
 * WHAT IS LOCKED: update_db and insert_db, reached through the function
 * registry the engine dispatches from, refuse rw_scratch in both descriptor
 * forms BEFORE any SQL runs (the db stub throws on any query), and the
 * refusal's list of writable tables does not name it.
 *
 * Run: npx jest tests/scratchWritePolicy.test.js
 */
'use strict';

const fns = require('../lib/internal_functions');

function noSqlDb() {
  const calls = [];
  const fail = (sql) => { calls.push(sql); throw new Error('no SQL may run: ' + sql); };
  return {
    calls,
    query: async (sql) => fail(sql),
    getConnection: async () => ({ query: async (sql) => fail(sql), beginTransaction: async () => {}, release: () => {} }),
  };
}

const REFUSED = /table "rw_scratch" is not writable\. Writable tables: /;

describe('rw_scratch is not writable by automation', () => {
  test('update_db, flat form (ingest rules / hook targets), is refused before any SQL', async () => {
    const db = noSqlDb();
    await expect(fns.update_db({
      table: 'rw_scratch', set_column: 'v', set_value: 'forged',
      where_column: 'k', where_value: 'some_arc_state',
    }, db)).rejects.toThrow(REFUSED);
    expect(db.calls).toEqual([]);
  });

  test('update_db, object form, is refused before any SQL', async () => {
    const db = noSqlDb();
    await expect(fns.update_db({
      table: 'rw_scratch', set: { v: 'forged' }, where: { ns: 'fred', k: 'some_arc_state' },
    }, db)).rejects.toThrow(REFUSED);
    expect(db.calls).toEqual([]);
  });

  test('insert_db is refused before any SQL', async () => {
    const db = noSqlDb();
    await expect(fns.insert_db({
      table: 'rw_scratch', values: { ns: 'fred', k: 'planted', v: 'forged' },
    }, db)).rejects.toThrow(/insert_db: table "rw_scratch" is not writable\. Writable tables: /);
    expect(db.calls).toEqual([]);
  });

  test('the refusal does not offer rw_scratch as a writable table', async () => {
    let msg = '';
    try {
      await fns.update_db({ table: 'rw_scratch', set: { v: 'x' }, where: { k: 'x' } }, noSqlDb());
    } catch (e) { msg = e.message; }
    const list = msg.split('Writable tables: ')[1] || '';
    expect(list).not.toBe('');
    expect(list.split(', ')).not.toContain('rw_scratch');
    expect(list.split(', ')).toContain('app_settings');
  });
});
