// tests/contactRelations.routeEcho.test.js
//
// DELETE /api/contact-relations/:id answers the deleted row's two ends
// (yc-sync matchers slice). The service's deleteRelation returns only
// { deleted_id }, and the sync bus sees response bodies, never request
// bodies, so the route reads the row first and adds contact_a_id /
// contact_b_id to the answer: public/js/yc-sync.js announces
// `relations:contact:<id>` for BOTH contacts from them. A row already gone
// keeps the service's own 404 ("Relation N not found" — Casey's relation
// cards key their refusal on that text).
//
// The real router on an ephemeral port (the tests/checklists.s1notes.test.js
// harness), lib/auth.jwtOrApiKey jest-mocked; req.db dispatches on SQL text.
// The real engine runs the same route in the gated
// tests/caseyContactRelationsRemove.mysql.test.js.
//
//   npx jest tests/contactRelations.routeEcho.test.js
'use strict';

const express = require('express');

jest.mock('../lib/auth.jwtOrApiKey', () => (req, res, next) => { req.auth = { type: 'jwt', userId: 6 }; next(); });
const router = require('../routes/api.contactRelations');

let db = null;
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.db = db; next(); });
app.use(router);
let server; let base;
beforeAll((done) => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; done(); }); });
afterAll((done) => { server.closeAllConnections?.(); server.close(() => done()); });

const JOINED = {
  id: 44, type_code: 'spouse', contact_a_id: 1001, contact_b_id: 1002, active: 1, status: '', start_date: null,
  end_date: null, end_reason: '', notes: '', created_at: '2026-11-01T00:00:00.000Z', created_by: 6,
  updated_at: '2026-11-01T00:00:00.000Z', is_symmetric: 1, forward_label: 'Spouse', reverse_label: 'Spouse',
  sort_order: 0, created_by_name: 'Fred', a_id: 1001, a_name: 'Ann', a_pname: '', a_type: 'Client',
  b_id: 1002, b_name: 'Bob', b_pname: '', b_type: 'Client',
};

/** Dispatch on SQL text, never on call order. */
function relDb({ row = JOINED, affected = 1 } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ s, params });
      if (/FROM contact_relations cr JOIN contact_relation_types crt .* WHERE cr\.id = \?$/.test(s)) return [row ? [row] : []];
      if (/^DELETE FROM contact_relations WHERE id = \?$/.test(s)) return [{ affectedRows: affected }];
      throw new Error('relDb: unscripted query — ' + s);
    },
  };
}

async function del(id) {
  const res = await fetch(`${base}/api/contact-relations/${id}`, { method: 'DELETE' });
  return { status: res.status, body: await res.json() };
}

describe('DELETE /api/contact-relations/:id — the sync-bus echo', () => {
  test('answers deleted_id AND the row\'s two ends; the row is read before it is deleted', async () => {
    db = relDb();
    expect(await del(44)).toEqual({ status: 200, body: { status: 'success', deleted_id: 44, contact_a_id: 1001, contact_b_id: 1002 } });
    expect(db.calls.map((c) => c.s.split(' ')[0])).toEqual(['SELECT', 'DELETE']);
    expect(db.calls.map((c) => c.params)).toEqual([['44'], ['44']]);
  });

  test('a row already gone keeps the service\'s 404, text unchanged', async () => {
    db = relDb({ row: null, affected: 0 });
    expect(await del(45)).toEqual({ status: 404, body: { status: 'error', message: 'Relation 45 not found' } });
  });

  test('a row deleted between the read and the DELETE is still the 404; one read but not found answers null ends', async () => {
    db = relDb({ row: JOINED, affected: 0 });
    expect((await del(44)).status).toBe(404);
    db = relDb({ row: null, affected: 1 });
    expect(await del(46)).toEqual({ status: 200, body: { status: 'success', deleted_id: 46, contact_a_id: null, contact_b_id: null } });
  });
});
