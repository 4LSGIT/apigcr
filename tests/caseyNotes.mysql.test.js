// Casey v2 S4a — the notes store on a REAL MySQL 8.4 (own *_test DB; gated on
// YC_TEST_MYSQL_URL, skipped otherwise):
//
//   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3379/yc_casey_notes_test \
//     npx jest tests/caseyNotes.mysql.test.js --runInBand
//
// Proves scripts/caseyV2S4aMigrate.js (CHECK → --apply creates and seeds →
// re-run in place → a drift is NO-GO; the seed written once) and
// services/casey/notes.js against the real table: the version numbering under
// the row lock, the UNIQUE key, the unchanged 409, restore, the current doc,
// and a forced overlap of two saves (InnoDB deadlocks the waiter; the service
// re-runs it once; both land with consecutive numbers).
// Own DB: this twin drops and rebuilds casey_notes — never share its DB with
// another twin.
'use strict';

const mysql = require('mysql2/promise');
const { withTransaction } = require('../lib/withTransaction');
const migrate = require('../scripts/caseyV2S4aMigrate');
const notes = require('../services/casey/notes');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const suite = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const AUTH = { userId: 6, username: 'IT' };

suite('casey notes — real engine', () => {
  let pool, conn;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const lines = [];
  const say = (l) => lines.push(l);

  beforeAll(async () => {
    const url = new URL(URL_);
    if (!/_test$/.test(url.pathname) || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Own local *_test DB required');
    pool = mysql.createPool({ uri: URL_, connectionLimit: 4, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false });
    pool.withTransaction = (fn, opts) => withTransaction(pool, fn, opts);
    pool.on('connection', (c) => { c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`); c.query('SET SESSION lock_wait_timeout = 10'); });
    conn = await mysql.createConnection({ uri: URL_, timezone: 'Z' });
    await q('DROP TABLE IF EXISTS casey_notes');
  });
  afterAll(async () => { await conn.end(); await pool.end(); });
  beforeEach(() => { lines.length = 0; notes.clearCache(); });

  test('migration: CHECK absent → GO; --apply creates and seeds global v1; re-run in place; the seed is written once; a drift is NO-GO', async () => {
    const check = await migrate.run(conn, { apply: false, say });
    expect(check.ok).toBe(true);
    expect(check.line).toMatch(/Next: node scripts\/caseyV2S4aMigrate.js --apply/);
    expect(lines.some((l) => /casey_notes: absent/.test(l))).toBe(true);

    const applied = await migrate.run(conn, { apply: true, say });
    expect(applied).toMatchObject({ ok: true, applied: true });
    expect(applied.line).toMatch(/^APPLIED — casey_notes verified\. GO\./);
    expect(lines.some((l) => /✓ created casey_notes/.test(l)) && lines.some((l) => /✓ seeded global version 1/.test(l))).toBe(true);
    const rows = await q('SELECT scope, version, body, edit_note, author_id, author_name FROM casey_notes');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scope: 'global', version: 1, body: migrate.seedBody(), edit_note: migrate.SEED_NOTE, author_id: null, author_name: 'seed' });
    expect(rows[0].body).not.toMatch(/\r/);

    lines.length = 0;
    const again = await migrate.run(conn, { apply: false, say });
    expect(again.line).toMatch(/^CHECK OK — casey_notes is in place and global has a version\. GO/);
    const reapply = await migrate.run(conn, { apply: true, say });
    expect(reapply).toMatchObject({ ok: true, applied: false });
    expect(reapply.line).toMatch(/^ALREADY IN PLACE/);
    expect((await q('SELECT COUNT(*) AS n FROM casey_notes'))[0].n).toBe('1');   // the seed is never repeated

    // The shape is verified column by column: a drifted comment or type is NO-GO, nothing changed.
    await q("ALTER TABLE casey_notes MODIFY COLUMN edit_note varchar(300) NOT NULL COMMENT 'drifted'");
    lines.length = 0;
    const drift = await migrate.run(conn, { apply: true, say });
    expect(drift.ok).toBe(false);
    expect(lines.some((l) => /casey_notes\.edit_note comment differs/.test(l))).toBe(true);
    await q('DROP TABLE casey_notes');
    expect((await migrate.run(conn, { apply: true, say })).ok).toBe(true);
  });

  test('a seed-empty table: the seed is written on --apply even when the table exists', async () => {
    await q('DELETE FROM casey_notes');
    const r = await migrate.run(conn, { apply: false, say });
    expect(r.ok).toBe(true);
    expect(lines.some((l) => /global: no version — to do: seed/.test(l))).toBe(true);
    expect((await migrate.run(conn, { apply: true, say }))).toMatchObject({ ok: true, applied: true });
    expect((await q('SELECT version FROM casey_notes WHERE scope = ?', ['global'])).map((x) => x.version)).toEqual([1]);
  });

  test('save / versions / version / restore / current against the real table', async () => {
    const d0 = await notes.current(pool);
    expect(d0.global).toBe(migrate.seedBody());
    expect(d0.families).toEqual({});
    const v2 = await notes.save(pool, { scope: 'global', body: 'Be brief.\r\nAlways.  \n', editNote: 'shorter', author: AUTH });
    expect(v2).toMatchObject({ version: 2, body: 'Be brief.\nAlways.', author_id: 6, author_name: 'IT', edit_note: 'shorter' });
    await expect(notes.save(pool, { scope: 'global', body: 'Be brief.\nAlways.', editNote: 'same', author: AUTH })).rejects.toMatchObject({ status: 409 });
    const f1 = await notes.save(pool, { scope: '/api/tasks', body: 'Use /complete.', editNote: 'tasks', author: AUTH });
    expect(f1.version).toBe(1);
    const d1 = await notes.current(pool);   // save cleared the cache
    expect(d1).toEqual({ global: 'Be brief.\nAlways.', families: { '/api/tasks': 'Use /complete.' }, versions: { global: 2, '/api/tasks': 1 } });
    const vs = await notes.versions(pool, 'global');
    expect(vs.map((v) => [v.version, v.chars, v.author_name])).toEqual([[2, 17, 'IT'], [1, migrate.seedBody().length, 'seed']]);
    expect(typeof vs[0].created_at).toBe('string');
    const r = await notes.restore(pool, { scope: 'global', version: 1, editNote: 'back', author: AUTH });
    expect(r).toMatchObject({ version: 3, body: migrate.seedBody(), edit_note: 'Restored version 1: back' });
    expect((await notes.current(pool)).global).toBe(migrate.seedBody());
    const rows = await notes.currentRows(pool);
    expect(rows.map((x) => [x.scope, x.version])).toEqual([['global', 3], ['/api/tasks', 1]]);
    // blank body: allowed (the note is off) and visible as '' / absent
    await notes.save(pool, { scope: '/api/tasks', body: '', editNote: 'off', author: AUTH });
    expect((await notes.current(pool)).families).toEqual({});
    expect((await notes.current(pool)).versions['/api/tasks']).toBe(2);
  });

  test('a FORCED overlap: a saver holding the latest row FOR UPDATE inserts the next version while a second save waits — InnoDB kills the waiter with ER_LOCK_DEADLOCK and the service re-runs it once onto the new latest (review S1)', async () => {
    const before = (await notes.versions(pool, 'global'))[0].version;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const holder = await mysql.createConnection({ uri: URL_, timezone: 'Z' });
    try {
      await holder.query('SET SESSION lock_wait_timeout = 10');
      await holder.beginTransaction();
      await holder.query('SELECT version FROM casey_notes WHERE scope = ? ORDER BY version DESC LIMIT 1 FOR UPDATE', ['global']);
      const waiting = notes.save(pool, { scope: 'global', body: 'waiter ' + Date.now(), editNote: 'w', author: AUTH });   // blocks on the holder's lock
      await new Promise((r) => setTimeout(r, 400));
      await holder.query('INSERT INTO casey_notes (scope, version, body, edit_note, author_id, author_name) VALUES (?, ?, ?, ?, ?, ?)', ['global', before + 1, 'holder', 'h', 6, 'IT']);   // the waiter is the deadlock victim here
      await holder.commit();
      const r = await waiting;
      expect(r.version).toBe(before + 2);
      expect(r.body).toMatch(/^waiter /);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/deadlock — re-running/));
    } finally { warn.mockRestore(); await holder.end(); }
    const all = await q('SELECT version, body FROM casey_notes WHERE scope = ? AND version > ? ORDER BY version', ['global', before]);
    expect(all.map((x) => [x.version, x.body.split(' ')[0]])).toEqual([[before + 1, 'holder'], [before + 2, 'waiter']]);
    // and two plain saves fired together both land (one may be re-run)
    const both = await Promise.all([
      notes.save(pool, { scope: 'global', body: 'A ' + Date.now(), editNote: 'a', author: AUTH }),
      notes.save(pool, { scope: 'global', body: 'B ' + Date.now(), editNote: 'b', author: AUTH }),
    ]);
    expect(both.map((x) => x.version).sort()).toEqual([before + 3, before + 4]);
  });
});
