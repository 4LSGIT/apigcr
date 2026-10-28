// tests/sharedValues.test.js
//
/**
 * Shared values — routes/api.shared.js over services/sharedValuesService.js
 * (settings-access arc, 2026-10-28).
 *
 * HARNESS: the REAL router + service + lib/auth.requireAuth (signed JWTs) +
 * lib/withTransaction over an in-memory engine that EVALUATES each statement
 * it is given: WHERE clauses are parsed into `col = ?` / `col > ?` conjuncts
 * and applied to stored rows, SET lists are parsed and applied (`rev = rev +
 * 1` included), INSERT honours the primary key (ER_DUP_ENTRY) and the FK
 * (ER_NO_REFERENCED_ROW_2), DELETE of a namespace cascades, and a transaction
 * snapshots on begin and restores on rollback. Names compare byte for byte
 * (the columns are utf8mb4_bin). An unknown statement THROWS — so dropping or
 * changing a predicate changes behaviour here instead of passing against
 * scripted results. The SQL's behaviour on a real engine is the gated twin's
 * job (tests/sharedValues.mysql.test.js).
 *
 * WHAT IS LOCKED
 *   - Auth: staff JWT only — no token, an API key, a portal token → 401; a
 *     read-only View-as write → 403 (view_as_read_only), nothing written; a
 *     live View-as write stamps updated_act with the human behind it.
 *   - Namespaces: any staff member creates (created_by stamped, defaults
 *     staff / 65536 / 1000); duplicates 409; names lowercase-only; limits
 *     bounded; PATCH / DELETE by the creator or firm.settings only; DELETE
 *     removes the values.
 *   - Values: no namespace → 404; rev is required; compare-and-set (create
 *     → rev 1, update → rev+1, stale rev → 409 with `current`, nothing
 *     written); size refused in BYTES before SQL (413); max_keys (409 full);
 *     write modes staff / creator / own_key and an invalid stored mode;
 *     compare-and-delete; paging; updated_by stamped from the JWT.
 *   - Every 409 / 404 decision after a failed write re-reads FOR SHARE (the
 *     latest committed row, not the REPEATABLE READ snapshot — the twin shows
 *     why); this engine has no snapshots, so here the statement is pinned.
 *   - A namespace page holds at most 8 MB of values: limit ≤
 *     floor(8 MB / max_value_bytes), `trimmed` says it was cut.
 *
 * Run: npx jest tests/sharedValues.test.js
 */
'use strict';

process.env.JWT_SECRET = 'shared-values-test-secret';
process.env.JWT_VERSION = '1';
process.env.INTERNAL_API_KEY = 'yci_shared_values_test_internal';   // secret-scan: allow

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const { withTransaction } = require('../lib/withTransaction');

const SECRET = process.env.JWT_SECRET;

// ─────────────────────────────────────────────────────────────────────────────
// In-memory engine
// ─────────────────────────────────────────────────────────────────────────────

const NS_COLS = ['ns', 'description', 'write_mode', 'max_value_bytes', 'max_keys', 'created_by', 'created_at', 'updated_at'];
const V_COLS = ['ns', 'k', 'v', 'rev', 'updated_by', 'updated_act', 'created_at', 'updated_at'];
const WRITE_MODES = ['staff', 'creator', 'own_key'];

function sqlError(code, msg) { const e = new Error(msg || code); e.code = code; return e; }

/** "a = ? AND b > ?" → [{ col, op }] — anything else throws. */
function parseWhere(text) {
  return text.split(/\s+AND\s+/i).map((part) => {
    const m = part.trim().match(/^(?:\w+\.)?(\w+)\s*(=|>)\s*\?$/);
    if (!m) throw new Error('engine: unsupported predicate ' + JSON.stringify(part));
    return { col: m[1], op: m[2] };
  });
}

function matches(row, conds, params) {
  return conds.every((c, i) => {
    const want = params[i];
    const got = row[c.col];
    if (got === undefined) throw new Error('engine: unknown column ' + c.col);
    if (c.op === '=') return typeof got === 'number' ? got === Number(want) : got === want;
    return String(got) > String(want);              // utf8mb4_bin: byte order
  });
}

function makeEngine() {
  let tables = { shared_namespaces: [], shared_values: [] };
  const calls = [];
  let clock = 0;
  const stamp = () => `2026-10-28 00:00:${String(clock++).padStart(2, '0')}`;
  const pick = (row, cols) => Object.fromEntries(cols.map((c) => [c, row[c]]));

  async function query(sql, params = []) {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    calls.push({ sql: s, params });
    let m;

    if (/jwt_api_audit_log/.test(s)) return [{ affectedRows: 1 }];

    // SELECT … FROM shared_namespaces n … key_count (the listing)
    if (/^SELECT .*\(SELECT COUNT\(\*\) FROM shared_values v WHERE v\.ns = n\.ns\) AS key_count FROM shared_namespaces n ORDER BY n\.ns$/.test(s)) {
      const rows = tables.shared_namespaces.slice().sort((a, b) => (a.ns < b.ns ? -1 : 1))
        .map((r) => ({ ...pick(r, NS_COLS), key_count: tables.shared_values.filter((v) => v.ns === r.ns).length }));
      return [rows];
    }
    if ((m = s.match(/^SELECT (.+) FROM shared_namespaces WHERE (.+?)( FOR UPDATE)?$/))) {
      const rows = tables.shared_namespaces.filter((r) => matches(r, parseWhere(m[2]), params));
      return [rows.map((r) => pick(r, NS_COLS))];
    }
    if ((m = s.match(/^SELECT COUNT\(\*\) AS n FROM shared_values WHERE (.+)$/))) {
      return [[{ n: tables.shared_values.filter((r) => matches(r, parseWhere(m[1]), params)).length }]];
    }
    if ((m = s.match(/^SELECT (.+) FROM shared_values WHERE (.+?)(?: ORDER BY k)?(?: LIMIT (\d+))?(?: FOR SHARE)?$/))) {
      let rows = tables.shared_values.filter((r) => matches(r, parseWhere(m[2]), params));
      if (/ORDER BY k/.test(s)) rows.sort((a, b) => (a.k < b.k ? -1 : 1));
      if (m[3]) rows = rows.slice(0, Number(m[3]));
      return [rows.map((r) => pick(r, V_COLS))];
    }
    if ((m = s.match(/^INSERT INTO shared_namespaces \(([^)]+)\) VALUES \(([^)]+)\)$/))) {
      const cols = m[1].split(',').map((x) => x.trim());
      const row = Object.fromEntries(cols.map((c, i) => [c, params[i]]));
      if (tables.shared_namespaces.some((r) => r.ns === row.ns)) throw sqlError('ER_DUP_ENTRY');
      if (!WRITE_MODES.includes(row.write_mode)) row.write_mode = '';     // relaxed sql_mode enum
      const now = stamp();
      tables.shared_namespaces.push({ description: null, write_mode: 'staff', max_value_bytes: 65536, max_keys: 1000,
        ...row, created_at: now, updated_at: now });
      return [{ affectedRows: 1 }];
    }
    if ((m = s.match(/^INSERT INTO shared_values \(([^)]+)\) VALUES \(([^)]+)\)$/))) {
      const cols = m[1].split(',').map((x) => x.trim());
      const vals = m[2].split(',').map((x) => x.trim());
      let p = 0;
      const row = Object.fromEntries(cols.map((c, i) => [c, vals[i] === '?' ? params[p++] : Number(vals[i])]));
      if (!tables.shared_namespaces.some((r) => r.ns === row.ns)) throw sqlError('ER_NO_REFERENCED_ROW_2');
      if (tables.shared_values.some((r) => r.ns === row.ns && r.k === row.k)) throw sqlError('ER_DUP_ENTRY');
      const now = stamp();
      tables.shared_values.push({ updated_act: null, ...row, created_at: now, updated_at: now });
      return [{ affectedRows: 1 }];
    }
    if ((m = s.match(/^UPDATE (shared_namespaces|shared_values) SET (.+) WHERE (.+)$/))) {
      const sets = m[2].split(/,\s*/).map((a) => {
        const x = a.match(/^(\w+) = (\?|rev \+ 1)$/);
        if (!x) throw new Error('engine: unsupported SET ' + a);
        return { col: x[1], expr: x[2] };
      });
      const nParams = sets.filter((x) => x.expr === '?').length;
      const setParams = params.slice(0, nParams);
      const rows = tables[m[1]].filter((r) => matches(r, parseWhere(m[3]), params.slice(nParams)));
      for (const r of rows) {
        let p = 0;
        for (const st of sets) {
          if (!(st.col in r)) throw new Error('engine: unknown column ' + st.col);
          r[st.col] = st.expr === '?' ? setParams[p++] : r[st.col] + 1;
        }
        if (m[1] === 'shared_namespaces' && !WRITE_MODES.includes(r.write_mode)) r.write_mode = '';
        r.updated_at = stamp();
      }
      return [{ affectedRows: rows.length }];
    }
    if ((m = s.match(/^DELETE FROM (shared_namespaces|shared_values) WHERE (.+)$/))) {
      const conds = parseWhere(m[2]);
      const gone = tables[m[1]].filter((r) => matches(r, conds, params));
      tables[m[1]] = tables[m[1]].filter((r) => !gone.includes(r));
      if (m[1] === 'shared_namespaces') {                                // ON DELETE CASCADE
        tables.shared_values = tables.shared_values.filter((v) => !gone.some((n) => n.ns === v.ns));
      }
      return [{ affectedRows: gone.length }];
    }
    throw new Error('engine: unsupported statement ' + s);
  }

  const db = {
    calls,
    query,
    get tables() { return tables; },
    seed(t) { tables = JSON.parse(JSON.stringify(t)); },
    getConnection: async () => {
      let snapshot = null;
      return {
        query,
        beginTransaction: async () => { snapshot = JSON.stringify(tables); },
        commit: async () => { snapshot = null; },
        rollback: async () => { if (snapshot) tables = JSON.parse(snapshot); snapshot = null; },
        release: () => {}, destroy: () => {},
      };
    },
  };
  db.withTransaction = (fn, opts) => withTransaction(db, fn, opts);
  return db;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────────────────────────────────────

function call(db, method, urlPath, { headers = {}, body } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.db = db; next(); });
  app.use(require('../routes/api.shared'));
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request({
        port: server.address().port, path: urlPath, method,
        headers: Object.assign(payload ? { 'content-type': 'application/json' } : {}, headers),
      }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

const tok = (claims = {}) => jwt.sign(Object.assign(
  { sub: 5, username: 'sb', user_type: 'staff', user_auth: 'authorized', aud: 'staff', ver: 1, roles: ['staff'] },
  claims), SECRET, { expiresIn: '1h' });
const as = (claims) => ({ authorization: 'Bearer ' + tok(claims) });
const STAFF5 = as({ sub: 5, username: 'u5' });
const STAFF7 = as({ sub: 7, username: 'u7' });
const ADMIN9 = as({ sub: 9, username: 'adm', roles: ['admin', 'staff'] });

const sharedSql = (db) => db.calls.filter((c) => /shared_/.test(c.sql));
const writesOf = (db) => db.calls.filter((c) => /^(INSERT|UPDATE|DELETE)/.test(c.sql) && /shared_/.test(c.sql));
const nsRow = (ns, extra = {}) => ({ ns, description: null, write_mode: 'staff', max_value_bytes: 65536, max_keys: 1000,
  created_by: 5, created_at: 't', updated_at: 't', ...extra });
const vRow = (ns, k, v, rev = 1, by = 5) => ({ ns, k, v, rev, updated_by: by, updated_act: null, created_at: 't', updated_at: 't' });

function seeded(ns = [nsRow('scores')], values = []) {
  const db = makeEngine();
  db.seed({ shared_namespaces: ns, shared_values: values });
  return db;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────────────────────

describe('auth: staff JWT only', () => {
  test('no token, an API key, a portal token → 401 and no shared_* SQL', async () => {
    for (const headers of [
      {},
      { 'x-api-key': process.env.INTERNAL_API_KEY },
      { authorization: 'Bearer ' + jwt.sign({ sub: 7, aud: 'contact', ver: 1 }, SECRET, { expiresIn: '1h' }) },
    ]) {
      const db = seeded();
      const r = await call(db, 'PUT', '/api/shared/scores/high', { headers, body: { v: '1', rev: null } });
      expect([JSON.stringify(headers).slice(0, 20), r.status]).toEqual([JSON.stringify(headers).slice(0, 20), 401]);
      expect(sharedSql(db)).toEqual([]);
    }
  });

  test('a read-only View-as write → 403 view_as_read_only, nothing written', async () => {
    const db = seeded();
    const r = await call(db, 'PUT', '/api/shared/scores/high', {
      headers: as({ sub: 5, view_as: true, act: { sub: '6', username: 'it' } }), body: { v: '1', rev: null } });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('view_as_read_only');
    expect(writesOf(db)).toEqual([]);
  });

  test('a live View-as write lands as the target, the human behind it in updated_act', async () => {
    const db = seeded();
    const r = await call(db, 'PUT', '/api/shared/scores/high', {
      headers: as({ sub: 5, view_as: true, view_as_mode: 'live', act: { sub: '6', username: 'fred' } }),
      body: { v: '120', rev: null } });
    expect(r.status).toBe(200);
    expect(r.body.value).toMatchObject({ k: 'high', v: '120', rev: 1, updated_by: 5, updated_act: 6 });
    expect(db.tables.shared_values[0]).toMatchObject({ updated_by: 5, updated_act: 6 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Namespaces
// ─────────────────────────────────────────────────────────────────────────────

describe('namespaces', () => {
  test('any staff member creates one: created_by stamped, defaults applied', async () => {
    const db = seeded([]);
    const r = await call(db, 'POST', '/api/shared', { headers: STAFF7, body: { ns: 'carve-scores', description: 'Office high score' } });
    expect(r.status).toBe(201);
    expect(r.body.namespace).toMatchObject({ ns: 'carve-scores', description: 'Office high score', write_mode: 'staff',
      max_value_bytes: 65536, max_keys: 1000, created_by: 7 });
    expect(db.tables.shared_namespaces).toHaveLength(1);
  });

  test('a duplicate → 409 exists', async () => {
    const db = seeded();
    const r = await call(db, 'POST', '/api/shared', { headers: STAFF7, body: { ns: 'scores' } });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('exists');
    expect(db.tables.shared_namespaces).toHaveLength(1);
  });

  test.each(['Scores', 'scores ', '-x', '_x', 'a'.repeat(65), 'a.b', 'a b', '', 'é'])('name %j → 400, nothing written', async (ns) => {
    const db = seeded([]);
    const r = await call(db, 'POST', '/api/shared', { headers: STAFF5, body: { ns } });
    expect(r.status).toBe(400);
    expect(writesOf(db)).toEqual([]);
  });

  test('a 64-character name is accepted', async () => {
    const db = seeded([]);
    const r = await call(db, 'POST', '/api/shared', { headers: STAFF5, body: { ns: 'a'.repeat(64) } });
    expect(r.status).toBe(201);
  });

  test.each([
    [{ write_mode: 'everyone' }], [{ max_value_bytes: 0 }], [{ max_value_bytes: 1048577 }], [{ max_value_bytes: 1.5 }],
    [{ max_value_bytes: '10' }], [{ max_keys: 0 }], [{ max_keys: 10001 }], [{ description: 'x'.repeat(501) }], [{ description: 5 }],
  ])('create with %j → 400, nothing written', async (extra) => {
    const db = seeded([]);
    const r = await call(db, 'POST', '/api/shared', { headers: STAFF5, body: { ns: 'x', ...extra } });
    expect(r.status).toBe(400);
    expect(writesOf(db)).toEqual([]);
  });

  test('PATCH: another staff member → 403; the creator and an admin → 200', async () => {
    let db = seeded();
    let r = await call(db, 'PATCH', '/api/shared/scores', { headers: STAFF7, body: { write_mode: 'creator' } });
    expect(r.status).toBe(403);
    expect(db.tables.shared_namespaces[0].write_mode).toBe('staff');
    for (const who of [STAFF5, ADMIN9]) {
      db = seeded();
      r = await call(db, 'PATCH', '/api/shared/scores', { headers: who, body: { write_mode: 'own_key', max_keys: 50 } });
      expect(r.status).toBe(200);
      expect(r.body.namespace).toMatchObject({ write_mode: 'own_key', max_keys: 50 });
      expect(db.tables.shared_namespaces[0]).toMatchObject({ write_mode: 'own_key', max_keys: 50 });
    }
  });

  test('PATCH with nothing to change → 400; on a missing namespace → 404', async () => {
    const db = seeded();
    expect((await call(db, 'PATCH', '/api/shared/scores', { headers: STAFF5, body: {} })).status).toBe(400);
    expect((await call(db, 'PATCH', '/api/shared/nope', { headers: STAFF5, body: { description: 'x' } })).status).toBe(404);
  });

  test('DELETE: another staff member → 403 (values kept); the creator → gone with its values', async () => {
    const db = seeded([nsRow('scores'), nsRow('other')], [vRow('scores', 'a', '1'), vRow('scores', 'b', '2'), vRow('other', 'a', '9')]);
    let r = await call(db, 'DELETE', '/api/shared/scores', { headers: STAFF7 });
    expect(r.status).toBe(403);
    expect(db.tables.shared_values).toHaveLength(3);
    r = await call(db, 'DELETE', '/api/shared/scores', { headers: STAFF5 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ns: 'scores', values_deleted: 2 });
    expect(db.tables.shared_namespaces.map((n) => n.ns)).toEqual(['other']);
    expect(db.tables.shared_values).toEqual([expect.objectContaining({ ns: 'other', k: 'a' })]);
  });

  test('the listing carries key counts', async () => {
    const db = seeded([nsRow('b'), nsRow('a')], [vRow('a', 'x', '1'), vRow('a', 'y', '2')]);
    const r = await call(db, 'GET', '/api/shared', { headers: STAFF7 });
    expect(r.status).toBe(200);
    expect(r.body.namespaces.map((n) => [n.ns, n.key_count])).toEqual([['a', 2], ['b', 0]]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Values — compare-and-set
// ─────────────────────────────────────────────────────────────────────────────

describe('values: compare-and-set', () => {
  test('a namespace nobody created → 404, nothing written', async () => {
    const db = seeded([]);
    const r = await call(db, 'PUT', '/api/shared/nope/high', { headers: STAFF5, body: { v: '1', rev: null } });
    expect(r.status).toBe(404);
    expect(writesOf(db)).toEqual([]);
  });

  test('rev is required (no blind writes); v must be a string; key names like ns names', async () => {
    const db = seeded();
    expect((await call(db, 'PUT', '/api/shared/scores/high', { headers: STAFF5, body: { v: '1' } })).status).toBe(400);
    expect((await call(db, 'PUT', '/api/shared/scores/high', { headers: STAFF5, body: { v: 1, rev: null } })).status).toBe(400);
    expect((await call(db, 'PUT', '/api/shared/scores/high', { headers: STAFF5, body: { v: '1', rev: 0 } })).status).toBe(400);
    expect((await call(db, 'PUT', '/api/shared/scores/High', { headers: STAFF5, body: { v: '1', rev: null } })).status).toBe(400);
    expect(writesOf(db)).toEqual([]);
  });

  test('create → rev 1; create again → 409 exists with the current row, nothing changed', async () => {
    const db = seeded();
    let r = await call(db, 'PUT', '/api/shared/scores/high', { headers: STAFF5, body: { v: '100', rev: null } });
    expect(r.status).toBe(200);
    expect(r.body.value).toMatchObject({ ns: 'scores', k: 'high', v: '100', rev: 1, updated_by: 5, updated_act: null });
    r = await call(db, 'PUT', '/api/shared/scores/high', { headers: STAFF7, body: { v: '200', rev: null } });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'exists', current: { v: '100', rev: 1, updated_by: 5 } });
    expect(db.tables.shared_values).toEqual([expect.objectContaining({ v: '100', rev: 1 })]);
  });

  test('update from the rev read → rev+1, stamped; a stale rev → 409 rev_conflict with current, nothing changed', async () => {
    const db = seeded(undefined, [vRow('scores', 'high', '100', 1, 5)]);
    let r = await call(db, 'PUT', '/api/shared/scores/high', { headers: STAFF7, body: { v: '150', rev: 1 } });
    expect(r.status).toBe(200);
    expect(r.body.value).toMatchObject({ v: '150', rev: 2, updated_by: 7 });
    r = await call(db, 'PUT', '/api/shared/scores/high', { headers: STAFF5, body: { v: '120', rev: 1 } });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'rev_conflict', current: { v: '150', rev: 2, updated_by: 7 } });
    expect(db.tables.shared_values[0]).toMatchObject({ v: '150', rev: 2, updated_by: 7 });
  });

  test('an update of a key that is gone → 409 rev_conflict with current null', async () => {
    const db = seeded();
    const r = await call(db, 'PUT', '/api/shared/scores/high', { headers: STAFF5, body: { v: '1', rev: 3 } });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'rev_conflict', current: null });
    expect(db.tables.shared_values).toEqual([]);
  });

  test('size is refused in BYTES before any write (413); exactly the limit is accepted', async () => {
    const db = seeded([nsRow('tiny', { max_value_bytes: 10 })]);
    expect((await call(db, 'PUT', '/api/shared/tiny/a', { headers: STAFF5, body: { v: 'x'.repeat(10), rev: null } })).status).toBe(200);
    const before = writesOf(db).length;
    const r1 = await call(db, 'PUT', '/api/shared/tiny/b', { headers: STAFF5, body: { v: 'x'.repeat(11), rev: null } });
    const r2 = await call(db, 'PUT', '/api/shared/tiny/c', { headers: STAFF5, body: { v: 'é'.repeat(6), rev: null } });   // 6 chars, 12 bytes
    expect([r1.status, r2.status]).toEqual([413, 413]);
    expect(writesOf(db)).toHaveLength(before);
  });

  test('max_keys: a create beyond it → 409 full; the key that exists → 409 exists', async () => {
    const db = seeded([nsRow('two', { max_keys: 2 })], [vRow('two', 'a', '1'), vRow('two', 'b', '2')]);
    let r = await call(db, 'PUT', '/api/shared/two/c', { headers: STAFF5, body: { v: '3', rev: null } });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('full');
    r = await call(db, 'PUT', '/api/shared/two/a', { headers: STAFF5, body: { v: '3', rev: null } });
    expect(r.body.code).toBe('exists');
    r = await call(db, 'PUT', '/api/shared/two/a', { headers: STAFF5, body: { v: '3', rev: 1 } });   // an update is not a create
    expect(r.status).toBe(200);
    expect(db.tables.shared_values).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Write modes
// ─────────────────────────────────────────────────────────────────────────────

describe('write modes', () => {
  test('creator: another staff member → 403; the creator and an admin write', async () => {
    const db = seeded([nsRow('board', { write_mode: 'creator', created_by: 5 })]);
    let r = await call(db, 'PUT', '/api/shared/board/x', { headers: STAFF7, body: { v: '1', rev: null } });
    expect(r.status).toBe(403);
    expect(db.tables.shared_values).toEqual([]);
    expect((await call(db, 'PUT', '/api/shared/board/x', { headers: STAFF5, body: { v: '1', rev: null } })).status).toBe(200);
    expect((await call(db, 'PUT', '/api/shared/board/x', { headers: ADMIN9, body: { v: '2', rev: 1 } })).status).toBe(200);
  });

  test('own_key: a user writes only the key equal to their user id; an admin any', async () => {
    const db = seeded([nsRow('mine', { write_mode: 'own_key' })]);
    expect((await call(db, 'PUT', '/api/shared/mine/7', { headers: STAFF5, body: { v: 'x', rev: null } })).status).toBe(403);
    expect((await call(db, 'PUT', '/api/shared/mine/5', { headers: STAFF5, body: { v: 'x', rev: null } })).status).toBe(200);
    expect((await call(db, 'PUT', '/api/shared/mine/7', { headers: ADMIN9, body: { v: 'y', rev: null } })).status).toBe(200);
    expect(db.tables.shared_values.map((v) => v.k).sort()).toEqual(['5', '7']);
  });

  test('a stored write_mode that is not one of the three refuses every write (fail closed)', async () => {
    const db = seeded([nsRow('broken', { write_mode: '' })]);
    for (const who of [STAFF5, ADMIN9]) {
      const r = await call(db, 'PUT', '/api/shared/broken/x', { headers: who, body: { v: '1', rev: null } });
      expect(r.status).toBe(403);
    }
    expect(db.tables.shared_values).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reads and deletes
// ─────────────────────────────────────────────────────────────────────────────

describe('reads and deletes', () => {
  test('GET one key; a missing key → 404', async () => {
    const db = seeded(undefined, [vRow('scores', 'high', '100', 4, 7)]);
    let r = await call(db, 'GET', '/api/shared/scores/high', { headers: STAFF5 });
    expect(r.status).toBe(200);
    expect(r.body.value).toMatchObject({ k: 'high', v: '100', rev: 4, updated_by: 7 });
    r = await call(db, 'GET', '/api/shared/scores/low', { headers: STAFF5 });
    expect(r.status).toBe(404);
  });

  test('GET a namespace pages by key: limit + after; next is null on the last page', async () => {
    const db = seeded(undefined, [vRow('scores', 'c', '3'), vRow('scores', 'a', '1'), vRow('scores', 'b', '2')]);
    let r = await call(db, 'GET', '/api/shared/scores?limit=2', { headers: STAFF5 });
    expect(r.body.values.map((v) => v.k)).toEqual(['a', 'b']);
    expect(r.body.next).toBe('b');
    r = await call(db, 'GET', '/api/shared/scores?limit=2&after=b', { headers: STAFF5 });
    expect(r.body.values.map((v) => v.k)).toEqual(['c']);
    expect(r.body.next).toBeNull();
    expect(r.body).toMatchObject({ limit: 2, trimmed: false });
    expect((await call(db, 'GET', '/api/shared/scores?limit=0', { headers: STAFF5 })).status).toBe(400);
    expect((await call(db, 'GET', '/api/shared/scores?limit=1001', { headers: STAFF5 })).status).toBe(400);
  });

  test('a page holds at most 8 MB of values: 1 MB values → 8 a page, trimmed; 64 KB → 128', async () => {
    const big = Array.from({ length: 10 }, (_, i) => vRow('big', 'k' + i, 'x'));
    let db = seeded([nsRow('big', { max_value_bytes: 1048576 })], big);
    let r = await call(db, 'GET', '/api/shared/big?limit=1000', { headers: STAFF5 });
    expect(r.status).toBe(200);
    expect(r.body.values).toHaveLength(8);
    expect(r.body).toMatchObject({ limit: 8, trimmed: true, next: 'k7' });
    r = await call(db, 'GET', '/api/shared/big?limit=1000&after=k7', { headers: STAFF5 });
    expect(r.body.values.map((v) => v.k)).toEqual(['k8', 'k9']);
    expect(r.body.next).toBeNull();
    db = seeded([nsRow('std')], [vRow('std', 'a', '1')]);
    r = await call(db, 'GET', '/api/shared/std?limit=1000', { headers: STAFF5 });
    expect(r.body).toMatchObject({ limit: 128, trimmed: true });
    r = await call(db, 'GET', '/api/shared/std?limit=100', { headers: STAFF5 });
    expect(r.body).toMatchObject({ limit: 100, trimmed: false });
  });

  test('every 409 / 404 decision after a failed write reads the row FOR SHARE (latest committed)', async () => {
    const db = seeded(undefined, [vRow('scores', 'high', '100', 2)]);
    const lastValueRead = () => db.calls.filter((c) => /^SELECT .* FROM shared_values WHERE ns = \? AND k = \?/.test(c.sql)).pop().sql;
    expect((await call(db, 'PUT', '/api/shared/scores/high', { headers: STAFF5, body: { v: 'x', rev: 1 } })).status).toBe(409);
    expect(lastValueRead()).toMatch(/ FOR SHARE$/);
    expect((await call(db, 'PUT', '/api/shared/scores/high', { headers: STAFF5, body: { v: 'x', rev: null } })).status).toBe(409);
    expect(lastValueRead()).toMatch(/ FOR SHARE$/);
    expect((await call(db, 'DELETE', '/api/shared/scores/high?rev=1', { headers: STAFF5 })).status).toBe(409);
    expect(lastValueRead()).toMatch(/ FOR SHARE$/);
    expect((await call(db, 'DELETE', '/api/shared/scores/none', { headers: STAFF5 })).status).toBe(404);
    expect(lastValueRead()).toMatch(/ FOR SHARE$/);
    const full = seeded([nsRow('one', { max_keys: 1 })], [vRow('one', 'a', '1')]);
    expect((await call(full, 'PUT', '/api/shared/one/a', { headers: STAFF5, body: { v: 'x', rev: null } })).body.code).toBe('exists');
    expect(full.calls.filter((c) => /^SELECT .* FROM shared_values WHERE ns = \? AND k = \?/.test(c.sql)).pop().sql).toMatch(/ FOR SHARE$/);
  });

  test('DELETE a key: the write rule applies; ?rev compares; missing → 404', async () => {
    const db = seeded([nsRow('board', { write_mode: 'creator', created_by: 5 })], [vRow('board', 'x', '1', 2)]);
    expect((await call(db, 'DELETE', '/api/shared/board/x', { headers: STAFF7 })).status).toBe(403);
    let r = await call(db, 'DELETE', '/api/shared/board/x?rev=1', { headers: STAFF5 });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'rev_conflict', current: { rev: 2 } });
    expect((await call(db, 'DELETE', '/api/shared/board/x?rev=abc', { headers: STAFF5 })).status).toBe(400);
    expect(db.tables.shared_values).toHaveLength(1);
    r = await call(db, 'DELETE', '/api/shared/board/x?rev=2', { headers: STAFF5 });
    expect(r.status).toBe(200);
    expect(db.tables.shared_values).toEqual([]);
    expect((await call(db, 'DELETE', '/api/shared/board/x', { headers: STAFF5 })).status).toBe(404);
  });
});
