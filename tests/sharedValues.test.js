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
 *   - HISTORY: every successful write — namespace create / update / delete,
 *     value create / update / delete — writes exactly ONE
 *     shared_values_history row with the right op, before / after, revs and
 *     writer (+ the View-as actor); a namespace delete writes one row carrying
 *     the key count; NO failure path (400 / 403 / 404 / 409 / 413) writes
 *     one; a history INSERT that fails rolls the write back.
 *   - GET /api/shared/:ns/_history: newest first, ?k, ?before paging with
 *     `next`, limit 1-200, an 8 MB byte budget on old_v + new_v (at least one
 *     row), readable after the namespace is deleted (namespace null), 404
 *     when there is neither; `_history` never shadows a key named history.
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

const SECRET = process.env.JWT_SECRET;

const { makeEngine } = require('./helpers/sharedValuesEngine');

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

// ─────────────────────────────────────────────────────────────────────────────
// History
// ─────────────────────────────────────────────────────────────────────────────

const hist = (db) => db.tables.shared_values_history;
const strip = (h) => { const { id, changed_at, ...rest } = h; return rest; };   // eslint-disable-line no-unused-vars
const rules = (o) => JSON.stringify({ description: null, write_mode: 'staff', max_value_bytes: 65536, max_keys: 1000, ...o });

describe('history: one row per successful write', () => {
  test('namespace create / update / delete, each one row, with the rules as JSON', async () => {
    const db = seeded([]);
    expect((await call(db, 'POST', '/api/shared', { headers: STAFF7, body: { ns: 'board', description: 'B' } })).status).toBe(201);
    expect(hist(db).map(strip)).toEqual([{ ns: 'board', k: null, op: 'ns_create', old_v: null, new_v: rules({ description: 'B' }),
      old_rev: null, new_rev: null, changed_by: 7, changed_act: null }]);
    expect((await call(db, 'PATCH', '/api/shared/board', { headers: STAFF7, body: { write_mode: 'creator', max_keys: 5 } })).status).toBe(200);
    expect(strip(hist(db)[1])).toEqual({ ns: 'board', k: null, op: 'ns_update', old_v: rules({ description: 'B' }),
      new_v: rules({ description: 'B', write_mode: 'creator', max_keys: 5 }), old_rev: null, new_rev: null, changed_by: 7, changed_act: null });
    await call(db, 'PUT', '/api/shared/board/a', { headers: STAFF7, body: { v: '1', rev: null } });
    await call(db, 'PUT', '/api/shared/board/b', { headers: STAFF7, body: { v: '2', rev: null } });
    expect((await call(db, 'DELETE', '/api/shared/board', { headers: ADMIN9 })).status).toBe(200);
    const last = hist(db)[hist(db).length - 1];
    expect(strip(last)).toEqual({ ns: 'board', k: null, op: 'ns_delete',
      old_v: rules({ description: 'B', write_mode: 'creator', max_keys: 5, key_count: 2 }), new_v: null,
      old_rev: null, new_rev: null, changed_by: 9, changed_act: null });
    expect(hist(db).map((h) => h.op)).toEqual(['ns_create', 'ns_update', 'create', 'create', 'ns_delete']);   // ONE row for the delete
    expect(hist(db).map((h) => h.id)).toEqual([1, 2, 3, 4, 5]);
  });

  test('value create / update / delete: before, after, revs, writer', async () => {
    const db = seeded();
    await call(db, 'PUT', '/api/shared/scores/high', { headers: STAFF5, body: { v: '100', rev: null } });
    await call(db, 'PUT', '/api/shared/scores/high', { headers: STAFF7, body: { v: '250', rev: 1 } });
    await call(db, 'DELETE', '/api/shared/scores/high?rev=2', { headers: STAFF5 });
    expect(hist(db).map(strip)).toEqual([
      { ns: 'scores', k: 'high', op: 'create', old_v: null, new_v: '100', old_rev: null, new_rev: 1, changed_by: 5, changed_act: null },
      { ns: 'scores', k: 'high', op: 'update', old_v: '100', new_v: '250', old_rev: 1, new_rev: 2, changed_by: 7, changed_act: null },
      { ns: 'scores', k: 'high', op: 'delete', old_v: '250', new_v: null, old_rev: 2, new_rev: null, changed_by: 5, changed_act: null },
    ]);
  });

  test('a delete without ?rev records the rev it removed; a live View-as stamps the actor', async () => {
    const db = seeded(undefined, [vRow('scores', 'high', '7', 3)]);
    await call(db, 'DELETE', '/api/shared/scores/high', {
      headers: as({ sub: 5, view_as: true, view_as_mode: 'live', act: { sub: '6', username: 'fred' } }) });
    expect(strip(hist(db)[0])).toEqual({ ns: 'scores', k: 'high', op: 'delete', old_v: '7', new_v: null, old_rev: 3, new_rev: null,
      changed_by: 5, changed_act: 6 });
  });

  test('NO failure path writes a history row', async () => {
    const big = 'x'.repeat(65537);
    const cases = [
      ['POST', '/api/shared', { ns: 'scores' }, STAFF5, 409],                         // duplicate namespace
      ['POST', '/api/shared', { ns: 'Bad' }, STAFF5, 400],
      ['PATCH', '/api/shared/scores', { max_keys: 5 }, STAFF7, 403],                 // not the creator
      ['PATCH', '/api/shared/nope', { max_keys: 5 }, STAFF5, 404],
      ['DELETE', '/api/shared/scores', undefined, STAFF7, 403],
      ['PUT', '/api/shared/scores/high', { v: 'x', rev: null }, STAFF5, 409],          // exists
      ['PUT', '/api/shared/scores/high', { v: 'x', rev: 1 }, STAFF5, 409],             // stale rev (row is at 2)
      ['PUT', '/api/shared/scores/gone', { v: 'x', rev: 1 }, STAFF5, 409],             // no such key
      ['PUT', '/api/shared/scores/high', { v: big, rev: 2 }, STAFF5, 413],
      ['PUT', '/api/shared/scores/high', { v: 'x' }, STAFF5, 400],                     // no rev
      ['PUT', '/api/shared/nope/high', { v: 'x', rev: null }, STAFF5, 404],
      ['PUT', '/api/shared/locked/k', { v: 'x', rev: null }, STAFF7, 403],             // creator-only namespace
      ['PUT', '/api/shared/one/b', { v: 'x', rev: null }, STAFF5, 409],               // full
      ['DELETE', '/api/shared/scores/high?rev=1', undefined, STAFF5, 409],
      ['DELETE', '/api/shared/scores/none', undefined, STAFF5, 404],
    ];
    for (const [method, url, body, headers, status] of cases) {
      const db = seeded([nsRow('scores'), nsRow('locked', { write_mode: 'creator' }), nsRow('one', { max_keys: 1 })],
        [vRow('scores', 'high', '100', 2), vRow('one', 'a', '1')]);
      const r = await call(db, method, url, { headers, body });
      expect([method, url, r.status, hist(db)]).toEqual([method, url, status, []]);
    }
  });

  test('a failed history INSERT rolls the write back — no value without its history', async () => {
    const db = seeded(undefined, [vRow('scores', 'high', '100', 1)]);
    db.failHistory = true;
    expect((await call(db, 'PUT', '/api/shared/scores/high', { headers: STAFF5, body: { v: '200', rev: 1 } })).status).toBe(500);
    expect((await call(db, 'PUT', '/api/shared/scores/new', { headers: STAFF5, body: { v: '1', rev: null } })).status).toBe(500);
    expect((await call(db, 'DELETE', '/api/shared/scores/high', { headers: STAFF5 })).status).toBe(500);
    expect((await call(db, 'POST', '/api/shared', { headers: STAFF5, body: { ns: 'fresh' } })).status).toBe(500);
    expect((await call(db, 'PATCH', '/api/shared/scores', { headers: STAFF5, body: { max_keys: 9 } })).status).toBe(500);
    expect((await call(db, 'DELETE', '/api/shared/scores', { headers: STAFF5 })).status).toBe(500);
    expect(db.tables.shared_values).toEqual([vRow('scores', 'high', '100', 1)]);
    expect(db.tables.shared_namespaces.map((n) => [n.ns, n.max_keys])).toEqual([['scores', 1000]]);
    expect(hist(db)).toEqual([]);
  });
});

describe('GET /api/shared/:ns/_history', () => {
  async function writeN(db, n) {
    await call(db, 'PUT', '/api/shared/scores/high', { headers: STAFF5, body: { v: 'v1', rev: null } });
    for (let i = 2; i <= n; i++) await call(db, 'PUT', '/api/shared/scores/high', { headers: STAFF5, body: { v: 'v' + i, rev: i - 1 } });
  }

  test('newest first; ?k filters; ?before + next page; the namespace is attached', async () => {
    const db = seeded();
    await writeN(db, 5);
    await call(db, 'PUT', '/api/shared/scores/other', { headers: STAFF7, body: { v: 'o', rev: null } });
    let r = await call(db, 'GET', '/api/shared/scores/_history', { headers: STAFF7 });
    expect(r.status).toBe(200);
    expect(r.body.history.map((h) => [h.id, h.k, h.op])).toEqual([[6, 'other', 'create'], [5, 'high', 'update'], [4, 'high', 'update'],
      [3, 'high', 'update'], [2, 'high', 'update'], [1, 'high', 'create']]);
    expect(r.body).toMatchObject({ ns: 'scores', namespace: { ns: 'scores' }, next: null, limit: 50, trimmed: false });
    expect(r.body.history[1]).toEqual({ id: 5, ns: 'scores', k: 'high', op: 'update', old_v: 'v4', new_v: 'v5', old_rev: 4, new_rev: 5,
      changed_by: 5, changed_act: null, changed_at: expect.any(String) });
    r = await call(db, 'GET', '/api/shared/scores/_history?k=high&limit=2', { headers: STAFF7 });
    expect([r.body.history.map((h) => h.id), r.body.next]).toEqual([[5, 4], 4]);
    r = await call(db, 'GET', '/api/shared/scores/_history?k=high&limit=2&before=4', { headers: STAFF7 });
    expect([r.body.history.map((h) => h.id), r.body.next]).toEqual([[3, 2], 2]);
    r = await call(db, 'GET', '/api/shared/scores/_history?k=high&limit=2&before=2', { headers: STAFF7 });
    expect([r.body.history.map((h) => h.id), r.body.next]).toEqual([[1], null]);
  });

  test('bad paging input → 400', async () => {
    const db = seeded();
    for (const q of ['limit=0', 'limit=201', 'limit=abc', 'before=0', 'before=-1', 'before=x', 'k=Bad', 'k=a%20b']) {
      expect([q, (await call(db, 'GET', `/api/shared/scores/_history?${q}`, { headers: STAFF5 })).status]).toEqual([q, 400]);
    }
  });

  test('an 8 MB byte budget on old_v + new_v: the page stops early, trimmed + next; never fewer than one row', async () => {
    // Seeded directly (a 1 MB value over HTTP is the 10 MB body limit's business, not this test's).
    const mb = 'x'.repeat(1048576);
    const hrow = (id, oldV, newV) => ({ id, ns: 'big', k: 'k', op: oldV ? 'update' : 'create', old_v: oldV, new_v: newV,
      old_rev: oldV ? id - 1 : null, new_rev: id, changed_by: 5, changed_act: null, changed_at: 't' });
    const db = makeEngine();
    db.seed({ shared_namespaces: [nsRow('big', { max_value_bytes: 1048576 })], shared_values: [],
      shared_values_history: [hrow(1, null, mb), ...[2, 3, 4, 5, 6].map((i) => hrow(i, mb, mb))] });   // 1 MB, then 2 MB each
    const r = await call(db, 'GET', '/api/shared/big/_history', { headers: STAFF5 });
    expect(r.body.history.map((h) => h.id)).toEqual([6, 5, 4, 3]);                      // 8 MB: four 2 MB rows
    expect([r.body.trimmed, r.body.next]).toEqual([true, 3]);
    // a single row over the budget still comes back alone (never an empty page)
    const one = makeEngine();
    one.seed({ shared_namespaces: [nsRow('big', { max_value_bytes: 1048576 })], shared_values: [],
      shared_values_history: [hrow(1, null, 'x'.repeat(9 * 1048576)), hrow(2, null, 'y')] });
    const r1 = await call(one, 'GET', '/api/shared/big/_history?before=2', { headers: STAFF5 });
    expect([r1.body.history.map((h) => h.id), r1.body.trimmed]).toEqual([[1], false]);
  });

  test('readable after the namespace is deleted (namespace null); 404 when there is neither', async () => {
    const db = seeded();
    await call(db, 'PUT', '/api/shared/scores/high', { headers: STAFF5, body: { v: '1', rev: null } });
    await call(db, 'DELETE', '/api/shared/scores', { headers: STAFF5 });
    const r = await call(db, 'GET', '/api/shared/scores/_history', { headers: STAFF7 });
    expect(r.status).toBe(200);
    expect([r.body.namespace, r.body.history.map((h) => h.op)]).toEqual([null, ['ns_delete', 'create']]);
    expect((await call(db, 'GET', '/api/shared/never/_history', { headers: STAFF7 })).status).toBe(404);
    expect((await call(db, 'GET', '/api/shared/never/_history?k=high', { headers: STAFF7 })).status).toBe(404);
    // the deleted namespace HAS history, just none for this key: an empty page, not a 404
    const r2 = await call(db, 'GET', '/api/shared/scores/_history?k=nokey', { headers: STAFF7 });
    expect([r2.status, r2.body.namespace, r2.body.history, r2.body.next]).toEqual([200, null, [], null]);
  });

  test('staff only; `_history` never shadows a key named "history"', async () => {
    const db = seeded();
    expect((await call(db, 'GET', '/api/shared/scores/_history')).status).toBe(401);
    expect((await call(db, 'PUT', '/api/shared/scores/history', { headers: STAFF5, body: { v: 'kept', rev: null } })).status).toBe(200);
    const r = await call(db, 'GET', '/api/shared/scores/history', { headers: STAFF5 });
    expect([r.status, r.body.value && r.body.value.v]).toEqual([200, 'kept']);
  });
});
