// tests/formsDraftPrecondition.mysql.test.js
//
/**
 * The draft POST's precondition on REAL MySQL: POST /api/forms/draft
 * (routes/api.forms.js → services/formService.js draftExpectation +
 * upsertDraft) with { expected_draft_id, expected_updated_at }, over
 * form_submissions cloned from ref/database.sql (its idx_draft_unique key on
 * the generated draft_key included) and then MIGRATED by
 * scripts/formDraftUpdatedAtMs.js's own run() — updated_at → DATETIME(3) —
 * under the production sql_mode. The auth gate is stubbed (a staff JWT whose
 * user comes from the x-user header); nothing else is.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/forms_draft_precondition_test npx jest tests/formsDraftPrecondition.mysql.test.js --runInBand
 * The database name must end in _test and the port must not be 3306 (the
 * production proxy). This suite DROPS and recreates its tables (and any
 * sibling-built child of them) in its before-hook AND its after-hook.
 *
 * WHAT IS LOCKED
 *   - The migration: CHECK on the pre-state writes nothing; --apply reaches
 *     DATETIME(3) / CURRENT_TIMESTAMP(3) / the comment; a re-run is a GO with
 *     nothing written; the ref/migrations file carries the script's statement
 *     verbatim.
 *   - No precondition → replaced whole (the external route's / API callers'
 *     behaviour, at the route and at the service).
 *   - Equal → lands, updated_at moves; stale → 409 with the row there now
 *     (GET latest's draft shape, user name included) and nothing written;
 *     null with a row → 409; null with none → inserts; the expected row gone
 *     → a new draft (nothing unseen is replaced); a NEW row (discard +
 *     re-insert) carrying the old updated_at → 409 (the id is checked).
 *   - Atomicity: two concurrent POSTs on the same expected value → exactly
 *     one 200 and one 409 (and the same for two "no draft" inserts).
 *   - The same second: two writes inside one second, the stale one refused —
 *     what the DATETIME(3) / NOW(3) change buys (NOW() fails this test).
 *   - Bad preconditions → 400, nothing written.
 *   - The Date-vs-string compare: mysql2 hands back a Date carrying the
 *     milliseconds; the JSON string the client holds matches it.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const mysql = require('mysql2/promise');

jest.mock('../lib/auth.jwtOrApiKey', () => (req, _res, next) => {
  req.auth = { type: 'jwt', userId: Number(req.headers['x-user'] || 6) };
  next();
});
const migration = require('../scripts/formDraftUpdatedAtMs');
const formService = require('../services/formService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
// Production SESSION sql_mode (verified live 2026-09-25; CLAUDE.md "SQL mode is relaxed").
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['users', 'form_submissions'];

function schemaFor(tables) {
  const lines = fs.readFileSync(path.join(__dirname, '..', 'ref', 'database.sql'), 'utf8').split('\n');
  const creates = []; const alters = [];
  for (let i = 0; i < lines.length; i++) {
    for (const t of tables) {
      if (lines[i].startsWith(`CREATE TABLE \`${t}\` (`)) {
        const buf = [];
        for (; i < lines.length; i++) { buf.push(lines[i]); if (/^\) ENGINE=.*;$/.test(lines[i])) break; }
        creates.push(buf.join('\n'));
      } else if (lines[i] === `ALTER TABLE \`${t}\``) {
        const buf = [];
        for (; i < lines.length; i++) { buf.push(lines[i]); if (/;\s*$/.test(lines[i])) break; }
        const head = buf[0];
        const clauses = buf.slice(1).map((l) => l.replace(/[,;]\s*$/, ''))
          .filter((l) => { const m = /REFERENCES `([a-z_]+)`/.exec(l); return !m || tables.includes(m[1]); });
        if (clauses.length) alters.push(`${head}\n${clauses.join(',\n')};`);
      }
    }
  }
  if (creates.length !== tables.length) throw new Error(`schema extraction found ${creates.length} CREATE blocks`);
  return { creates, alters };
}

function call(app, method, urlPath, body, user = 6) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app).listen(0, () => {
      const payload = body == null ? '' : JSON.stringify(body);
      const req = http.request({ port: srv.address().port, path: urlPath, method,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-user': String(user) } }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => { srv.close(); resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }); });
      });
      req.on('error', (e) => { srv.close(); reject(e); });
      req.end(payload);
    });
  });
}

const KEY = 'precond_form';
const LINK = { form_key: KEY, link_type: 'case', link_id: 'PC1' };

d('POST /api/forms/draft precondition on real MySQL', () => {
  let pool; let app;
  const migrationLogs = { check: [], apply: [], again: [] };
  const migrationResults = {};
  const q = async (sql, p) => (await pool.query(sql, p))[0];

  async function dropAll(conn) {
    const [children] = await conn.query(
      `SELECT DISTINCT TABLE_NAME AS t FROM information_schema.REFERENTIAL_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IN (?) AND TABLE_NAME NOT IN (?)`, [TABLES, TABLES]);
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of [...new Set(children.map((r) => r.t)), ...[...TABLES].reverse()]) {
      await conn.query(`DROP TABLE IF EXISTS \`${t}\``);
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  }

  const post = (body, user) => call(app, 'POST', '/api/forms/draft', { ...LINK, schema_version: 1, ...body }, user);
  const draftRows = () => q(`SELECT * FROM form_submissions WHERE status = 'draft' ORDER BY id`);
  const asObj = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
  // Two writes in the same MILLISECOND would still tie (the residual of DATETIME(3));
  // a stale-write assertion steps past it so it cannot flake.
  const nextMs = () => new Promise((r) => setTimeout(r, 3));
  // Wait for the start of a fresh wall-clock second (bounded: at most ~1 s).
  const freshSecond = async () => {
    const s0 = Math.floor(Date.now() / 1000);
    const until = Date.now() + 1500;
    while (Math.floor(Date.now() / 1000) === s0 && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
  };

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    if (new URL(URL_).port === '3306') throw new Error('refusing to run against the production proxy port');
    pool = mysql.createPool({ uri: URL_, connectionLimit: 10, timezone: 'Z' });
    pool.on('connection', (conn) => conn.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    const conn = await pool.getConnection();
    try {
      await dropAll(conn);
      await conn.query('SET FOREIGN_KEY_CHECKS = 0');
      const { creates, alters } = schemaFor(TABLES);
      for (const sql of creates) await conn.query(sql);
      for (const sql of alters) await conn.query(sql);
      await conn.query('SET FOREIGN_KEY_CHECKS = 1');
      // The migration, through the script's own run() on one connection.
      migrationResults.preCol = await migration.columnState(conn);
      migrationResults.check = await migration.run(conn, { apply: false, log: (l) => migrationLogs.check.push(l) });
      migrationResults.afterCheckCol = await migration.columnState(conn);
      migrationResults.apply = await migration.run(conn, { apply: true, log: (l) => migrationLogs.apply.push(l) });
      migrationResults.again = await migration.run(conn, { apply: true, log: (l) => migrationLogs.again.push(l) });
      migrationResults.col = await migration.columnState(conn);
    } finally { conn.release(); }
    if (!migrationResults.col || migrationResults.col.type !== 'datetime(3)') {
      throw new Error(`form_submissions.updated_at is not DATETIME(3) after the migration (${migrationResults.col && migrationResults.col.type})`);
    }
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.db = pool; next(); });
    app.use(require('../routes/api.forms'));
  });

  afterAll(async () => {
    if (!pool) return;
    const conn = await pool.getConnection();
    try { await dropAll(conn); } finally { conn.release(); }
    await pool.end();
  });

  beforeEach(async () => {
    await q('DELETE FROM form_submissions');
    await q('DELETE FROM users');
    await q(`INSERT INTO users (user, user_name) VALUES (6, 'Fred'), (1, 'Stuart')`);
  });

  test('the migration: CHECK writes nothing, --apply reaches DATETIME(3), a re-run writes nothing; the SQL file carries the statement', async () => {
    expect(migrationResults.preCol.type).toBe('datetime');
    expect(migration.classify(migrationResults.preCol)).toBe('pre');
    expect(migrationResults.check).toEqual({ ok: true, state: 'pre' });
    expect(migrationResults.afterCheckCol.type).toBe('datetime');
    expect(migrationLogs.check[migrationLogs.check.length - 1]).toMatch(/^\nGO — CHECK passed, nothing written\. Next: node scripts\/formDraftUpdatedAtMs\.js --apply$/);
    expect(migrationResults.apply).toEqual({ ok: true, state: 'migrated' });
    expect(migrationLogs.apply[migrationLogs.apply.length - 1]).toMatch(/^\nGO — updated_at is datetime\(3\)/);
    expect(migrationResults.again).toEqual({ ok: true, state: 'done' });
    expect(migrationLogs.again).not.toContain('  ✓ ALTER ran');
    const col = migrationResults.col;
    expect([col.type, col.nullable, col.dflt, col.comment]).toEqual(['datetime(3)', 'NO', 'CURRENT_TIMESTAMP(3)', migration.COLUMN_COMMENT]);
    expect(col.extra).toMatch(/on update CURRENT_TIMESTAMP\(3\)$/i);
    const sqlFile = fs.readFileSync(path.join(__dirname, '..', 'ref', 'migrations', '2026-11-11_form_submissions_updated_at_ms.sql'), 'utf8');
    expect(sqlFile).toContain(`${migration.ALTER_SQL};`);
    // Neither shape → refused, naming what it found.
    expect(() => migration.classify({ ...col, type: 'datetime(6)' })).toThrow(/neither the pre-state nor the migrated state/);
    expect(() => migration.classify({ ...col, comment: '' })).toThrow(/neither/);
    expect(() => migration.classify(null)).toThrow(/missing/);
  });

  test('no precondition → replaced whole (route and service), as before — stamped to the millisecond too', async () => {
    await freshSecond();
    const a = await post({ data: { a: 1, b: 2 } });
    expect(a.status).toBe(200);
    await nextMs();
    const b = await post({ data: { c: 3 } }, 1);
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    // Inside one second, yet a later updated_at (NOW(3) on the ON DUPLICATE KEY path as well).
    expect(Math.floor(Date.parse(b.body.updated_at) / 1000)).toBe(Math.floor(Date.parse(a.body.updated_at) / 1000));
    expect(Date.parse(b.body.updated_at)).toBeGreaterThan(Date.parse(a.body.updated_at));
    let rows = await draftRows();
    expect(rows.length).toBe(1);
    expect([asObj(rows[0].data), rows[0].submitted_by]).toEqual([{ c: 3 }, 1]);
    // The external route's call shape: seven arguments, no opts.
    const out = await formService.upsertDraft(pool, KEY, 'case', 'PC1', 1, { d: 4 }, null);
    expect(out.id).toBe(a.body.id);
    rows = await draftRows();
    expect([rows.length, asObj(rows[0].data), rows[0].submitted_by]).toEqual([1, { d: 4 }, null]);
  });

  test('equal → lands and updated_at moves; the JSON string the client holds matches the Date column to the millisecond', async () => {
    const first = await post({ data: { a: 1 }, expected_draft_id: null, expected_updated_at: null });
    expect(first.status).toBe(200);
    expect(first.body.updated_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    const [raw] = await q('SELECT updated_at FROM form_submissions WHERE id = ?', [first.body.id]);
    expect(raw.updated_at).toBeInstanceOf(Date);
    expect(raw.updated_at.toISOString()).toBe(first.body.updated_at);
    await nextMs();
    const second = await post({ data: { a: 2 }, expected_draft_id: first.body.id, expected_updated_at: first.body.updated_at });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ status: 'success', id: first.body.id, ...LINK });
    expect(Date.parse(second.body.updated_at)).toBeGreaterThan(Date.parse(first.body.updated_at));
    // GET latest's string round-trips too.
    const latest = await call(app, 'GET', `/api/forms/latest?form_key=${KEY}&link_type=case&link_id=PC1`);
    expect(latest.body.draft.updated_at).toBe(second.body.updated_at);
    const third = await post({ data: { a: 3 }, expected_draft_id: String(latest.body.draft.id), expected_updated_at: latest.body.draft.updated_at });
    expect(third.status).toBe(200);
    expect(asObj((await draftRows())[0].data)).toEqual({ a: 3 });
  });

  test('stale → 409 with the row there now (GET latest\'s draft shape, user name) and nothing written', async () => {
    const mine = await post({ data: { a: 1 }, expected_draft_id: null, expected_updated_at: null }, 6);
    await nextMs();
    const theirs = await post({ data: { a: 'stuart' }, expected_draft_id: mine.body.id, expected_updated_at: mine.body.updated_at }, 1);
    expect(theirs.status).toBe(200);
    const before = await draftRows();
    const res = await post({ data: { a: 'stale' }, expected_draft_id: mine.body.id, expected_updated_at: mine.body.updated_at }, 6);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      status: 'conflict',
      message: 'The draft was saved again since it was read — nothing was written',
      draft: { id: mine.body.id, schema_version: 1, data: { a: 'stuart' }, updated_at: theirs.body.updated_at, submitted_by: 1, user_name: 'Stuart' },
    });
    const latest = await call(app, 'GET', `/api/forms/latest?form_key=${KEY}&link_type=case&link_id=PC1`);
    expect(res.body.draft).toEqual(latest.body.draft);
    expect(await draftRows()).toEqual(before);
  });

  test('null with a row → 409 with it; null with none → inserts', async () => {
    const none = await post({ data: { a: 1 }, expected_draft_id: null, expected_updated_at: null }, 1);
    expect(none.status).toBe(200);
    expect((await draftRows()).length).toBe(1);
    const before = await draftRows();
    const res = await post({ data: { a: 2 }, expected_draft_id: null, expected_updated_at: null }, 6);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      status: 'conflict',
      message: 'A draft of this form already exists for this record — nothing was written',
      draft: { id: none.body.id, schema_version: 1, data: { a: 1 }, updated_at: none.body.updated_at, submitted_by: 1, user_name: 'Stuart' },
    });
    expect(await draftRows()).toEqual(before);
  });

  test('the expected row gone (discarded) → a NEW draft; a new row someone else made, even on the old updated_at → 409 (the id is checked)', async () => {
    const a = await post({ data: { a: 1 }, expected_draft_id: null, expected_updated_at: null });
    expect((await call(app, 'DELETE', `/api/forms/draft?form_key=${KEY}&link_type=case&link_id=PC1`)).body.deleted).toBe(true);
    const fresh = await post({ data: { a: 2 }, expected_draft_id: a.body.id, expected_updated_at: a.body.updated_at });
    expect(fresh.status).toBe(200);
    expect(fresh.body.id).not.toBe(a.body.id);
    let rows = await draftRows();
    expect([rows.length, rows[0].id, asObj(rows[0].data)]).toEqual([1, fresh.body.id, { a: 2 }]);
    // Discarded again; someone else's new draft, forced onto the very same updated_at as A's.
    await call(app, 'DELETE', `/api/forms/draft?form_key=${KEY}&link_type=case&link_id=PC1`);
    const b = await post({ data: { b: 1 }, expected_draft_id: null, expected_updated_at: null }, 1);
    await q('UPDATE form_submissions SET updated_at = ? WHERE id = ?', [new Date(a.body.updated_at), b.body.id]);
    const res = await post({ data: { a: 3 }, expected_draft_id: a.body.id, expected_updated_at: a.body.updated_at });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ status: 'conflict', message: 'The draft was saved again since it was read — nothing was written',
      draft: { id: b.body.id, schema_version: 1, data: { b: 1 }, updated_at: a.body.updated_at, submitted_by: 1, user_name: 'Stuart' } });
    rows = await draftRows();
    expect([rows.length, asObj(rows[0].data)]).toEqual([1, { b: 1 }]);
  });

  test('atomic: two concurrent POSTs on the same expected value → exactly one 200, one 409 (and two concurrent inserts: "no draft", or the expected row gone)', async () => {
    for (let round = 0; round < 5; round++) {
      await q('DELETE FROM form_submissions');
      const pair = await Promise.all([
        post({ data: { who: 'x' }, expected_draft_id: null, expected_updated_at: null }, 6),
        post({ data: { who: 'y' }, expected_draft_id: null, expected_updated_at: null }, 1),
      ]);
      expect(pair.map((r) => r.status).sort()).toEqual([200, 409]);
      expect((await draftRows()).length).toBe(1);
      const base = pair.find((r) => r.status === 200).body;
      await nextMs();
      const race = await Promise.all([
        post({ data: { who: 'x2' }, expected_draft_id: base.id, expected_updated_at: base.updated_at }, 6),
        post({ data: { who: 'y2' }, expected_draft_id: base.id, expected_updated_at: base.updated_at }, 1),
      ]);
      expect(race.map((r) => r.status).sort()).toEqual([200, 409]);
      const won = race.find((r) => r.status === 200).body;
      const lost = race.find((r) => r.status === 409).body;
      expect(lost.draft).toMatchObject({ id: base.id, updated_at: won.updated_at });
      const rows = await draftRows();
      expect(rows.length).toBe(1);
      expect(rows[0].updated_at.toISOString()).toBe(won.updated_at);
      // The expected row gone: both would insert; the unique key lets one.
      await q('DELETE FROM form_submissions');
      const gone = await Promise.all([
        post({ data: { who: 'x3' }, expected_draft_id: won.id, expected_updated_at: won.updated_at }, 6),
        post({ data: { who: 'y3' }, expected_draft_id: won.id, expected_updated_at: won.updated_at }, 1),
      ]);
      expect(gone.map((r) => r.status).sort()).toEqual([200, 409]);
      expect((await draftRows()).length).toBe(1);
    }
  });

  test('the same second: two writes inside one second, the stale one refused (DATETIME(3) + NOW(3))', async () => {
    await freshSecond();
    const a = await post({ data: { v: 'a' }, expected_draft_id: null, expected_updated_at: null }, 6);
    await nextMs();
    const b = await post({ data: { v: 'b' }, expected_draft_id: a.body.id, expected_updated_at: a.body.updated_at }, 1);
    const stale = await post({ data: { v: 'stale' }, expected_draft_id: a.body.id, expected_updated_at: a.body.updated_at }, 6);
    expect([a.status, b.status]).toEqual([200, 200]);
    // Both writes really fell inside one wall-clock second.
    expect(Math.floor(Date.parse(b.body.updated_at) / 1000)).toBe(Math.floor(Date.parse(a.body.updated_at) / 1000));
    expect(stale.status).toBe(409);
    expect(asObj((await draftRows())[0].data)).toEqual({ v: 'b' });
  });

  test('a precondition the server cannot read → 400, nothing written', async () => {
    const a = await post({ data: { a: 1 }, expected_draft_id: null, expected_updated_at: null });
    const before = await draftRows();
    const bad = [
      [{ expected_updated_at: 'yesterday', expected_draft_id: a.body.id }, 'expected_updated_at is not a date'],
      [{ expected_updated_at: '', expected_draft_id: a.body.id }, 'expected_updated_at is not a date'],
      [{ expected_updated_at: true, expected_draft_id: a.body.id }, 'expected_updated_at is not a date'],
      [{ expected_updated_at: a.body.updated_at }, 'expected_draft_id and expected_updated_at go together: both null (no draft held) or both set'],
      [{ expected_draft_id: a.body.id }, 'expected_draft_id and expected_updated_at go together: both null (no draft held) or both set'],
      [{ expected_draft_id: null, expected_updated_at: a.body.updated_at }, 'expected_draft_id and expected_updated_at go together: both null (no draft held) or both set'],
      [{ expected_draft_id: '1x', expected_updated_at: a.body.updated_at }, 'expected_draft_id must be a positive integer'],
      [{ expected_draft_id: 0, expected_updated_at: a.body.updated_at }, 'expected_draft_id must be a positive integer'],
      [{ expected_draft_id: 1.5, expected_updated_at: a.body.updated_at }, 'expected_draft_id must be a positive integer'],
    ];
    for (const [body, message] of bad) {
      const res = await post({ data: { a: 'bad' }, ...body });
      expect({ body, status: res.status, res: res.body }).toEqual({ body, status: 400, res: { status: 'error', message } });
    }
    expect(await draftRows()).toEqual(before);
  });
});
