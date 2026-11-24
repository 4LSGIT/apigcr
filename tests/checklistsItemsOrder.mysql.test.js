// tests/checklistsItemsOrder.mysql.test.js
//
/**
 * The atomic reorder route PUT /checklists/:id/items/order on REAL MySQL
 * (routes/api.checklists.js — real handler, real pool, production sql_mode).
 * Ported at Casey v2 S6 (2026-11-24) from the retired v1 suite
 * caseyChecklistOrder.mysql.test.js, whose card half went with v1: these are
 * the ROUTE's cases, which no other suite exercised (tests/ycSync.test.js
 * knows only the matcher).
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3379/yc_checklists_order_test npx jest tests/checklistsItemsOrder.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates its
 * tables in it, cloned from ref/database.sql (live types and keys, the real
 * checkitems → checklists FK — the lock the route relies on rides on it).
 * Drops run with FOREIGN_KEY_CHECKS off in the before-hook AND the after-hook
 * and take any sibling-built child of ours with them. It shares table names
 * with the other checklist twins: give it its own _test DB.
 *
 * WHAT IS LOCKED
 *   - THE ROUTE WRITES THE ORDER: positions 1..N in the sent order, the answer
 *     is the whole list in that order (the GET shape), item names / statuses
 *     and the list's status untouched, no domain event.
 *   - THE SET CHECK: a missing, extra, foreign or repeated id, a note, a
 *     missing list, a non-array — refused (409 / 400 / 404) with NOTHING
 *     written (positions compared before and after).
 *   - ATOMIC AGAINST A CONCURRENT ADD: an item insert holding its FK lock on
 *     the list when the reorder starts makes the reorder WAIT and then refuse
 *     (409) — it never answers 200 for a set that no longer is the list's.
 *     Bounded waits only.
 *   - Two reorders racing end in exactly one of the two orders, never a mix.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const mysql = require('mysql2/promise');

jest.mock('../lib/auth.jwtOrApiKey', () => (req, _res, next) => { req.auth = { type: 'jwt', userId: 6 }; next(); });
jest.mock('../lib/domainEvents', () => ({ ...jest.requireActual('../lib/domainEvents'), emit: jest.fn() }));
jest.mock('../services/emailService', () => ({ sendEmail: jest.fn(async () => {}) }));
jest.mock('../services/logService', () => ({ createLogEntry: jest.fn(async () => {}) }));
jest.mock('../services/uploadTargetService', () => ({ issueClientUploadLink: jest.fn(), inspectUploadDestination: jest.fn(), raiseUnsortedUploadTask: jest.fn() }));
const domainEvents = require('../lib/domainEvents');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['cases', 'contacts', 'users', 'checklists', 'checkitems'];

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
  alters.sort((a, b) => /FOREIGN KEY/.test(a) - /FOREIGN KEY/.test(b));
  return { creates, alters };
}

function call(app, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app).listen(0, () => {
      const payload = body === undefined ? '' : JSON.stringify(body);
      const req = http.request({ port: srv.address().port, path: urlPath, method,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => { srv.close(); resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }); });
      });
      req.on('error', (e) => { srv.close(); reject(e); });
      req.end(payload);
    });
  });
}

// and run against an `api` that calls the real routes.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

d('the atomic reorder route PUT /checklists/:id/items/order on real MySQL (A10X; ported at S6)', () => {
  let pool; let app;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const C1 = 'A10XCASE';

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

  async function seed() {
    await q('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of [...TABLES].reverse()) await q(`DELETE FROM \`${t}\``);
    await q('SET FOREIGN_KEY_CHECKS = 1');
    await q(`INSERT INTO cases (case_id, case_number, case_type, case_subtype) VALUES (?, '25-60002', 'Bankruptcy', 'Chapter 7')`, [C1]);
    await q(`INSERT INTO checklists (id, title, kind, status, created_by, link, link_type, tag) VALUES
      (41, 'Pre-filing', 'checklist', 'incomplete', 6, ?, 'case', NULL),
      (42, 'Call log', 'note', 'incomplete', 6, ?, 'case', NULL),
      (43, 'Other list', 'checklist', 'incomplete', 6, ?, 'case', NULL)`, [C1, C1, C1]);
    // Positions with a gap and a tie, as the add route leaves them.
    await q(`INSERT INTO checkitems (id, checklist_id, name, status, position) VALUES
      (401, 41, 'Pull credit report', 'incomplete', 1), (402, 41, 'Order transcripts', 'complete', 2),
      (403, 41, 'Pay stubs', 'incomplete', 5), (404, 41, 'Bank statements', 'incomplete', 5),
      (431, 43, 'Foreign item', 'incomplete', 1)`);
  }
  const items = async (id) => (await q('SELECT id, name, status, position FROM checkitems WHERE checklist_id = ? ORDER BY position, id', [id]));
  const order = async (id) => (await items(id)).map((i) => Number(i.id));
  const positions = async (id) => (await q('SELECT id, position FROM checkitems WHERE checklist_id = ? ORDER BY id', [id])).map((r) => [Number(r.id), r.position]);

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
      // The FK the lock rides on is really there (a twin without it proves nothing).
      const [fk] = await conn.query(`SELECT DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'checkitems' AND REFERENCED_TABLE_NAME = 'checklists'`);
      if (fk.length !== 1 || fk[0].DELETE_RULE !== 'CASCADE') throw new Error('checkitems → checklists FK missing from the twin');
    } finally { conn.release(); }
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.db = pool; next(); });
    app.use(require('../routes/api.checklists'));
  });

  afterAll(async () => {
    if (!pool) return;
    const conn = await pool.getConnection();
    try { await dropAll(conn); } finally { conn.release(); }
    await pool.end();
  });

  beforeEach(async () => { await seed(); domainEvents.emit.mockClear(); });

  test('THE ROUTE WRITES THE ORDER — positions 1..N in the sent order; the answer is the list in that order; nothing else changes', async () => {
    expect(await order(41)).toEqual([401, 402, 403, 404]);
    const before = await items(41);
    const res = await call(app, 'PUT', '/checklists/41/items/order', { item_ids: [404, 401, '403', 402] });
    expect(res.status).toBe(200);
    expect([res.body.id, res.body.link_type, res.body.link, res.body.status]).toEqual([41, 'case', C1, 'incomplete']);
    expect(res.body.items.map((i) => [i.id, i.position])).toEqual([[404, 1], [401, 2], [403, 3], [402, 4]]);
    expect(await order(41)).toEqual([404, 401, 403, 402]);
    // Names and statuses untouched; the other list untouched; no event.
    const after = await items(41);
    expect(after.map((i) => [Number(i.id), i.name, i.status]).sort()).toEqual(before.map((i) => [Number(i.id), i.name, i.status]).sort());
    expect(await positions(43)).toEqual([[431, 1]]);
    expect(domainEvents.emit).not.toHaveBeenCalled();
    // The GET answers the same order.
    const got = await call(app, 'GET', '/checklists/41');
    expect(got.body.items.map((i) => i.id)).toEqual([404, 401, 403, 402]);
  });

  test.each([
    ['one missing', { item_ids: [401, 402, 403] }, 409, /^item_ids must be exactly the list's 4 current items — missing 1\./],
    ['one extra (foreign)', { item_ids: [401, 402, 403, 404, 431] }, 409, /— 1 not on this list\./],
    ['a swap for a foreign id', { item_ids: [401, 402, 403, 431] }, 409, /— missing 1 — 1 not on this list\./],
    ['a repeated id', { item_ids: [401, 401, 402, 403, 404] }, 400, /more than once/],
    ['not an array', { item_ids: '401,402' }, 400, /must be an array/],
    ['a zero id', { item_ids: [0, 401, 402, 403] }, 400, /positive whole item ids/],
    ['a fractional id', { item_ids: [401.5, 402, 403, 404] }, 400, /positive whole item ids/],
  ])('THE SET CHECK — %s is refused and nothing is written', async (_n, body, status, re) => {
    const before = await positions(41);
    const res = await call(app, 'PUT', '/checklists/41/items/order', body);
    expect([res.status, re.test(res.body.message)]).toEqual([status, true]);
    if (status === 409) expect(res.body.item_ids).toEqual([401, 402, 403, 404]);
    expect(await positions(41)).toEqual(before);
  });

  test('a note is a 400, a missing list a 404 — before any write', async () => {
    const note = await call(app, 'PUT', '/checklists/42/items/order', { item_ids: [] });
    const gone = await call(app, 'PUT', '/checklists/999/items/order', { item_ids: [1] });
    expect([note.status, gone.status, gone.body.message]).toEqual([400, 404, 'Checklist not found']);
  });

  test('ATOMIC AGAINST A CONCURRENT ADD — a reorder that starts while an item insert holds the list waits, then refuses (409)', async () => {
    const other = await pool.getConnection();
    try {
      await other.beginTransaction();
      // An item add mid-flight: the FK check takes a shared lock on list 41.
      await other.query("INSERT INTO checkitems (id, checklist_id, name, status, position) VALUES (405, 41, 'Late add', 'incomplete', 6)");
      let settled = null;
      const pending = call(app, 'PUT', '/checklists/41/items/order', { item_ids: [404, 403, 402, 401] }).then((r) => { settled = r; return r; });
      await sleep(400);
      // Still waiting on the insert's lock — it has not answered for a set that is about to change.
      expect(settled).toBe(null);
      await other.commit();
      const res = await Promise.race([pending, sleep(10000).then(() => ({ status: 'timeout' }))]);
      expect([res.status, res.body && res.body.item_ids]).toEqual([409, [401, 402, 403, 404, 405]]);
      expect(await order(41)).toEqual([401, 402, 403, 404, 405]);
    } finally {
      try { await other.rollback(); } catch (_) { /* committed */ }
      other.release();
    }
  });

  test('two reorders racing end in exactly one of the two orders, never a mix', async () => {
    const A = [404, 403, 402, 401]; const B = [402, 404, 401, 403];
    for (let round = 0; round < 5; round++) {
      const [ra, rb] = await Promise.all([
        call(app, 'PUT', '/checklists/41/items/order', { item_ids: A }),
        call(app, 'PUT', '/checklists/41/items/order', { item_ids: B })]);
      expect([ra.status, rb.status]).toEqual([200, 200]);
      const now = await order(41);
      expect([JSON.stringify(A), JSON.stringify(B)]).toContain(JSON.stringify(now));
      expect((await positions(41)).map(([, p]) => p).sort()).toEqual([1, 2, 3, 4]);
    }
  });

});
