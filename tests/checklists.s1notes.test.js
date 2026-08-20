// tests/checklists.s1notes.test.js
//
// S1 — notes/checklists merge. Covers the two layers the slice actually
// changed, and nothing below them:
//
//   lib/checklistStatus.js       the note exemption. A note's status is MANUAL,
//                                so the derivation must refuse to run at all —
//                                not run and happen to agree.
//   routes/api.checklists.js     shape exclusivity (a note rejects items, a
//                                checklist rejects a body), the kind filter on
//                                GET, manual status on PATCH gated by the
//                                STORED kind, kind immutability, and the
//                                docs_needed path staying scoped to checklists.
//
// DRIVEN OVER REAL HTTP for the route half. routes/api.checklists.js exports
// only the router — no handlers — so, exactly as tests/portalDocsRoutes.test.js
// reasoned for routes/portal.docs.js, mounting the real router in a real
// express app on an ephemeral port is the honest alternative and needs no new
// dependency (express is a prod dep; fetch is global on Node 18+). It also
// exercises the json body parser and status serialisation for real.
//
// The file header of api.checklists.js prescribes this harness by name for
// mayDetachPersonal. Reused here rather than inventing a second one.
//
// MOCKED — everything the router requires that is not the subject:
//   lib/auth.jwtOrApiKey     passthrough injecting req.auth (SU by default, so
//                            the tag gate never masks a shape assertion)
//   lib/checklistStatus      for the ROUTE half only. The lib half below pulls
//                            the real implementation through requireActual, so
//                            one file can hold both without the route tests
//                            paying for the lib's queries.
//   lib/domainEvents         asserted NOT to fire on a manual note status
//   services/pipelineService, lib/alerting, services/emailService,
//   services/logService, services/uploadTargetService,
//   services/settingsService, lib/firmConfig, services/portalDocsService
//                            require-graph pruning — the public upload routes
//                            are not in scope for S1 and have their own suites.
//
// WHAT THIS SUITE CANNOT PROVE. Test 8 ("a note and a checklist may share a
// tag on one entity") is a statement about UNIQUE KEY uq_link_kind_tag, which
// lives in the database. Against a scripted stub both INSERTs succeed because
// the script says so — a tautology. What IS asserted here is the route-layer
// half: two inserts are issued, the discriminator is bound distinctly, and the
// route manufactures no 409 of its own. The constraint itself is verified
// against the live DB after the migration:
//
//   SHOW CREATE TABLE checklists;
//     -> UNIQUE KEY `uq_link_kind_tag` (`link_type`,`link`,`kind`,`tag`)
//     -> no `uq_link_tag`
//
// Run:
//   npx jest tests/checklists.s1notes.test.js

'use strict';

// lib/auth.superuser.isSuperuser string-matches user_auth against the exact
// literal "authorized - SU" — the repo-wide convention (see that file's note).
// A shorter value here silently degrades every tagged test to a 403.
const SU_AUTH = { type: 'jwt', userId: 1, username: 'fred', user_auth: 'authorized - SU' };

// `mock` prefix is load-bearing: jest hoists mock factories above the file and
// refuses out-of-scope references unless the identifier is prefixed this way.
// Mutable so a test can swap identity without re-requiring the router; every
// test in this suite runs as SU, because the tag gate (mayWriteTag) is not the
// subject here and a 403 would mask the shape assertions.
let mockAuth = SU_AUTH;

jest.mock('../lib/auth.jwtOrApiKey', () => (req, res, next) => {
  req.auth = mockAuth;
  next();
});

jest.mock('../lib/checklistStatus', () => ({
  computeAndSaveStatus: jest.fn(async () => ({ status: 'incomplete', transitioned: false })),
}));
jest.mock('../lib/domainEvents', () => ({ emit: jest.fn() }));
jest.mock('../services/pipelineService', () => ({ advanceStage: jest.fn(async () => ({})) }));
jest.mock('../lib/alerting', () => ({ alert: jest.fn(async () => {}) }));
jest.mock('../services/emailService', () => ({ sendEmail: jest.fn(async () => {}) }));
jest.mock('../services/logService', () => ({ createLogEntry: jest.fn(async () => {}) }));
jest.mock('../services/uploadTargetService', () => ({
  issueClientUploadLink: jest.fn(),
  inspectUploadDestination: jest.fn(),
  raiseUnsortedUploadTask: jest.fn(),
}));
jest.mock('../services/settingsService', () => ({ getSetting: jest.fn(async () => '') }));
jest.mock('../lib/firmConfig', () => ({ cfg: jest.fn(() => 'automations@example.test') }));
jest.mock('../services/portalDocsService', () => ({
  NOTIFY_TO_KEY: 'portal_docs_notify_to',
  ALLOWED_EXTENSIONS: new Set(['pdf']),
  MAX_FILE_SIZE: 50 * 1024 * 1024,
  _extOf: (n) => String(n).split('.').pop().toLowerCase(),
}));

const express      = require('express');
const domainEvents = require('../lib/domainEvents');
const router       = require('../routes/api.checklists');
const { scriptGuard } = require('./helpers/scriptGuard');

// The REAL lib, alongside the mock the router got. jest.mock is file-wide;
// requireActual is the documented way to have both in one suite.
const { computeAndSaveStatus } = jest.requireActual('../lib/checklistStatus');

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scripted mysql2 stub. Ordered script, shifted per query, guarded in both
 * directions by tests/helpers/scriptGuard.js — see that file for why the
 * guard is mandatory rather than optional.
 */
function stubDb(script) {
  const calls = [];
  const guard = scriptGuard('stubDb', script);
  return {
    calls,
    guard,
    query: async (sql, params) => {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: params || [] });
      if (!script.length) guard.overrun(sql);
      return [script.shift()];
    },
  };
}

/** The stub the NEXT request will see. Set by each test before calling. */
let db = null;

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.db = db; next(); });
app.use(router);

let server;
let base;

beforeAll(done => {
  server = app.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll(done => {
  // undici (global fetch) keeps sockets alive, so a bare close() would wait on
  // them. close()'s callback argument must be swallowed — jest's `done` treats
  // any argument as a failure.
  server.closeAllConnections?.();
  server.close(() => done());
});

beforeEach(() => { mockAuth = SU_AUTH; db = null; });
afterEach(() => jest.clearAllMocks());

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: json };
}

/** An OkPacket shaped like mysql2's, for INSERT/UPDATE script entries. */
const ok = (insertId = 1, affectedRows = 1) => ({ insertId, affectedRows });

// ─────────────────────────────────────────────────────────────────────────────
// 1. lib/checklistStatus — the note exemption
// ─────────────────────────────────────────────────────────────────────────────

describe('computeAndSaveStatus — notes are exempt from derivation', () => {
  test('a note returns { status: null, transitioned: false } and writes NOTHING', async () => {
    // ONE query scripted: the kind lookup. If the guard ever stops short-
    // circuiting, the items SELECT overruns the script and scriptGuard fails
    // the test with the offending SQL — which is the point of scripting
    // exactly one entry rather than a generous fixture.
    const d = stubDb([[{ kind: 'note' }]]);

    const out = await computeAndSaveStatus(d, 42);

    expect(out).toEqual({ status: null, transitioned: false });
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0].sql).toBe('SELECT kind FROM checklists WHERE id = ?');
    expect(d.calls[0].params).toEqual([42]);
    // The critical negative: no status write, and no updated_date touch. A
    // note's status is whatever a human last set.
    expect(d.calls.some(c => /UPDATE checklists/i.test(c.sql))).toBe(false);
  });

  test('a checklist still derives and writes, unchanged', async () => {
    const d = stubDb([
      [{ kind: 'checklist' }],                                  // kind lookup
      [{ status: 'complete' }, { status: 'complete' }],          // items
      ok(0, 1),                                                  // guarded UPDATE
    ]);

    const out = await computeAndSaveStatus(d, 7);

    expect(out).toEqual({ status: 'complete', transitioned: true });
    expect(d.calls[1].sql).toContain('FROM checkitems WHERE checklist_id = ?');
    expect(d.calls[2].sql).toContain('UPDATE checklists SET status = ?');
    expect(d.calls[2].params).toEqual(['complete', 7, 'complete']);
  });

  test('an unchanged checklist still gets its updated_date touched', async () => {
    // Regression guard on the pre-existing behaviour the kind gate sits above:
    // the sort columns updated_desc / updated_asc depend on this bump.
    const d = stubDb([
      [{ kind: 'checklist' }],
      [{ status: 'incomplete' }],
      ok(0, 0),          // guarded UPDATE matched nothing — no transition
      ok(0, 1),          // explicit updated_date touch
    ]);

    const out = await computeAndSaveStatus(d, 9);

    expect(out).toEqual({ status: 'incomplete', transitioned: false });
    expect(d.calls[3].sql).toBe('UPDATE checklists SET updated_date = NOW() WHERE id = ?');
  });

  test('a missing checklist short-circuits the same way', async () => {
    const d = stubDb([[]]);          // no row
    expect(await computeAndSaveStatus(d, 999)).toEqual({ status: null, transitioned: false });
    expect(d.calls).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2–3. POST /checklists — shape exclusivity, both directions
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /checklists — a note and a checklist are mutually exclusive shapes', () => {
  test('kind=note with items is a 400, and nothing is written', async () => {
    db = stubDb([]);                 // empty script: any query at all overruns

    const res = await call('POST', '/checklists', {
      title: 'Call the trustee',
      kind: 'note',
      items: [{ name: 'nope' }],
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/note holds freeform text, not items/i);
    expect(db.calls).toHaveLength(0);
  });

  test('kind=note with an EMPTY items array is still a 400', async () => {
    // Presence of the key is the test, not its contents — an empty array is a
    // harmless no-op to execute but signals a caller that thinks it is making
    // a checklist. Swallowing it produces a note the caller believes has items.
    db = stubDb([]);
    const res = await call('POST', '/checklists', { title: 'n', kind: 'note', items: [] });
    expect(res.status).toBe(400);
    expect(db.calls).toHaveLength(0);
  });

  test('kind=checklist with a body is a 400, and nothing is written', async () => {
    db = stubDb([]);

    const res = await call('POST', '/checklists', {
      title: 'Docs',
      kind: 'checklist',
      body: 'stray text nothing renders',
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/checklist holds items, not a body/i);
    expect(db.calls).toHaveLength(0);
  });

  test('an unrecognised kind is a 400 naming the vocabulary', async () => {
    db = stubDb([]);
    const res = await call('POST', '/checklists', { title: 't', kind: 'memo' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('kind must be one of: checklist, note');
    expect(db.calls).toHaveLength(0);
  });

  test('a valid note inserts with kind and body bound, and no items query runs', async () => {
    db = stubDb([
      ok(101),                                                        // INSERT
      [{ id: 101, title: 'Call trustee', kind: 'note', body: 'ring back Tuesday' }],
      [],                                                             // items (always empty)
    ]);

    const res = await call('POST', '/checklists', {
      title: 'Call trustee', kind: 'note', body: 'ring back Tuesday',
      link_type: 'case', link: 'C-1',
    });

    expect(res.status).toBe(201);
    const insert = db.calls[0];
    expect(insert.sql).toContain('INSERT INTO checklists (title, kind, body,');
    expect(insert.params[1]).toBe('note');
    expect(insert.params[2]).toBe('ring back Tuesday');
  });

  test('omitting kind defaults to checklist — every pre-notes caller is unaffected', async () => {
    // public/checklistView.html sends exactly this payload today.
    db = stubDb([
      ok(102),
      [{ id: 102, title: 'Groceries', kind: 'checklist' }],
      [],
    ]);

    const res = await call('POST', '/checklists', {
      title: 'Groceries', link: '22', link_type: 'user',
    });

    expect(res.status).toBe(201);
    expect(db.calls[0].params[1]).toBe('checklist');
    expect(db.calls[0].params[2]).toBeNull();     // body
  });

  test('an empty-string body on a note is stored as "", not collapsed to NULL', async () => {
    // `body ?? null` rather than `body || null`. A title-only note the user
    // has deliberately cleared is a real state.
    db = stubDb([ok(103), [{ id: 103, kind: 'note', body: '' }], []]);
    await call('POST', '/checklists', { title: 'blank', kind: 'note', body: '' });
    expect(db.calls[0].params[2]).toBe('');
  });

  test('a non-string body is refused before it can land as [object Object]', async () => {
    db = stubDb([]);
    const res = await call('POST', '/checklists', { title: 't', kind: 'note', body: { a: 1 } });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/body must be a string or null/i);
    expect(db.calls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. uq_link_kind_tag — the route-layer half (see the header for the caveat)
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /checklists — a note and a checklist may share one tag on one entity', () => {
  test('both inserts are issued, discriminated by kind, with no route-manufactured 409', async () => {
    db = stubDb([
      ok(201), [{ id: 201, kind: 'checklist', tag: 'docs_needed' }], [],
      ok(202), [{ id: 202, kind: 'note', tag: 'docs_needed' }], [],
    ]);

    const a = await call('POST', '/checklists', {
      title: 'Docs Needed', kind: 'checklist', tag: 'docs_needed',
      link_type: 'case', link: 'C-9',
    });
    const b = await call('POST', '/checklists', {
      title: 'Docs Needed', kind: 'note', tag: 'docs_needed', body: 'chased twice',
      link_type: 'case', link: 'C-9',
    });

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    // Same (link_type, link, tag) on both; only `kind` differs. That triple
    // used to be the whole of uq_link_tag, so under the OLD key the second
    // insert was a duplicate by construction.
    const [i1, , , i2] = db.calls.map(c => c.params);
    expect(i1[1]).toBe('checklist');
    expect(i2[1]).toBe('note');
    expect([i1[5], i1[6]]).toEqual(['case', 'docs_needed']);
    expect([i2[5], i2[6]]).toEqual(['case', 'docs_needed']);
  });

  test('a real ER_DUP_ENTRY still surfaces as a 409 naming the per-kind rule', async () => {
    const dup = Object.assign(new Error('Duplicate entry'), {
      code: 'ER_DUP_ENTRY', errno: 1062,
    });
    db = {
      calls: [],
      query: async () => { throw dup; },
    };

    const res = await call('POST', '/checklists', {
      title: 'Docs Needed', kind: 'note', tag: 'docs_needed',
      link_type: 'case', link: 'C-9',
    });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/per entity per kind per tag/i);
    expect(res.body.message).toMatch(/A note tagged "docs_needed"/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4–5. PATCH /checklists/:id — manual status, and kind immutability
// ─────────────────────────────────────────────────────────────────────────────

describe('PATCH /checklists/:id — status is manual for a note, derived for a checklist', () => {
  test('setting status on a CHECKLIST is a 400 pointing at the derivation rule', async () => {
    db = stubDb([[{ id: 5, link_type: 'case', link: 'C-1', kind: 'checklist' }]]);

    const res = await call('PATCH', '/checklists/5', { status: 'complete' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/derived from its items and cannot be set directly/i);
    // Judged on the STORED row, so the row IS loaded — but nothing is written.
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].sql).toContain('SELECT id, link_type, link, kind FROM checklists');
  });

  test('setting status on a NOTE is a 200 and writes the column', async () => {
    db = stubDb([
      [{ id: 6, link_type: 'case', link: 'C-1', kind: 'note' }],   // current
      ok(0, 1),                                                     // UPDATE
      [{ id: 6, kind: 'note', status: 'complete' }],                // re-read
      [],                                                           // items
    ]);

    const res = await call('PATCH', '/checklists/6', { status: 'complete' });

    expect(res.status).toBe(200);
    const upd = db.calls[1];
    expect(upd.sql).toBe('UPDATE checklists SET status = ? WHERE id = ?');
    expect(upd.params).toEqual(['complete', '6']);
  });

  test('a manual note status change emits NO domain event', async () => {
    // note.completed is deliberately out of scope for S1: additive later,
    // breaking to remove. This is the assertion that keeps it out.
    db = stubDb([
      [{ id: 6, link_type: 'case', link: 'C-1', kind: 'note' }],
      ok(0, 1),
      [{ id: 6, kind: 'note', status: 'complete' }],
      [],
    ]);

    await call('PATCH', '/checklists/6', { status: 'complete' });

    expect(domainEvents.emit).not.toHaveBeenCalled();
  });

  test('an out-of-vocabulary status is a 400 before the row is even loaded', async () => {
    db = stubDb([]);
    const res = await call('PATCH', '/checklists/6', { status: 'done' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('status must be one of: incomplete, complete');
    expect(db.calls).toHaveLength(0);
  });

  test('setting body on a CHECKLIST is a 400', async () => {
    db = stubDb([[{ id: 5, link_type: 'case', link: 'C-1', kind: 'checklist' }]]);
    const res = await call('PATCH', '/checklists/5', { body: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/checklist holds items, not a body/i);
    expect(db.calls).toHaveLength(1);
  });

  test('setting body on a NOTE is a 200', async () => {
    db = stubDb([
      [{ id: 6, link_type: 'case', link: 'C-1', kind: 'note' }],
      ok(0, 1),
      [{ id: 6, kind: 'note', body: 'updated' }],
      [],
    ]);
    const res = await call('PATCH', '/checklists/6', { body: 'updated' });
    expect(res.status).toBe(200);
    expect(db.calls[1].params).toEqual(['updated', '6']);
  });

  test('kind in the body is a 400, refused before the row is loaded', async () => {
    db = stubDb([]);

    const res = await call('PATCH', '/checklists/6', { kind: 'checklist' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/kind cannot be changed after creation/i);
    expect(db.calls).toHaveLength(0);
  });

  test('kind is refused even alongside an otherwise valid title change', async () => {
    // The whole request fails — a partial apply would rename the row and
    // silently drop the conversion the caller asked for.
    db = stubDb([]);
    const res = await call('PATCH', '/checklists/6', { title: 'new', kind: 'note' });
    expect(res.status).toBe(400);
    expect(db.calls).toHaveLength(0);
  });

  test('a title-only PATCH is untouched by any of this', async () => {
    db = stubDb([
      [{ id: 5, link_type: 'case', link: 'C-1', kind: 'checklist' }],
      ok(0, 1),
      [{ id: 5, title: 'Renamed', kind: 'checklist' }],
      [],
    ]);
    const res = await call('PATCH', '/checklists/5', { title: 'Renamed' });
    expect(res.status).toBe(200);
    expect(db.calls[1].sql).toBe('UPDATE checklists SET title = ? WHERE id = ?');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. POST /checklists/:id/items — a note can never acquire an item
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /checklists/:id/items — notes hold no items', () => {
  test('a note parent is a 400 and no checkitem row is inserted', async () => {
    db = stubDb([[{ id: 6, link_type: 'case', link: 'C-1', kind: 'note' }]]);

    const res = await call('POST', '/checklists/6/items', { name: 'Bank statements' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/that is a note, not a checklist/i);
    // Parent loaded; nothing else. Critically no INSERT INTO checkitems, which
    // is the orphan row the lib guard alone could not have prevented.
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].sql).toContain('SELECT id, link_type, link, kind FROM checklists');
  });

  test('a checklist parent still accepts the item', async () => {
    db = stubDb([
      [{ id: 5, link_type: 'case', link: 'C-1', kind: 'checklist' }],  // parent
      [{ maxPos: 3 }],                                                 // MAX(position)
      ok(77),                                                          // INSERT item
      [{ id: 5, kind: 'checklist' }],                                  // re-read list
      [{ id: 77, name: 'Bank statements' }],                           // items
    ]);

    const res = await call('POST', '/checklists/5/items', { name: 'Bank statements' });

    expect(res.status).toBe(201);
    expect(db.calls[2].sql).toContain('INSERT INTO checkitems');
    expect(db.calls[2].params[3]).toBe(4);            // maxPos + 1
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. GET /checklists?kind= — the filter, and its omission
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /checklists — the kind filter', () => {
  test('kind=note filters to notes', async () => {
    db = stubDb([
      [{ total: 1 }],
      [{ id: 6, kind: 'note', items_total: '0', items_done: '0' }],
    ]);

    const res = await call('GET', '/checklists?kind=note');

    expect(res.status).toBe(200);
    expect(db.calls[0].sql).toContain('cl.kind = ?');
    expect(db.calls[0].params).toEqual(['note']);
    expect(db.calls[1].params).toEqual(['note', 200, 0]);
    expect(res.body.checklists).toHaveLength(1);
    expect(res.body.checklists[0].kind).toBe('note');
  });

  test('kind=checklist filters to checklists', async () => {
    db = stubDb([
      [{ total: 2 }],
      [{ id: 5, kind: 'checklist', items_total: '3', items_done: '1' }],
    ]);

    const res = await call('GET', '/checklists?kind=checklist');

    expect(db.calls[0].params).toEqual(['checklist']);
    expect(res.body.checklists[0].kind).toBe('checklist');
    // Pre-existing contract: COUNT(*) arrives as a string and must be coerced.
    expect(res.body.checklists[0].items_total).toBe(3);
  });

  test('OMITTING kind returns both — the merged board is the default', async () => {
    db = stubDb([
      [{ total: 2 }],
      [
        { id: 5, kind: 'checklist', items_total: '3', items_done: '3' },
        { id: 6, kind: 'note',      items_total: '0', items_done: '0' },
      ],
    ]);

    const res = await call('GET', '/checklists?link_type=case&link=C-1');

    expect(db.calls[0].sql).not.toContain('cl.kind');
    expect(res.body.checklists.map(c => c.kind)).toEqual(['checklist', 'note']);
  });

  test('an unrecognised kind is a 400, not an empty list', async () => {
    // Same posture as link_type and status: a typo must read as a typo, not as
    // "you have nothing".
    db = stubDb([]);
    const res = await call('GET', '/checklists?kind=memo');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('kind must be one of: checklist, note');
    expect(db.calls).toHaveLength(0);
  });

  test('include=items gives a note [] without a special case', async () => {
    db = stubDb([
      [{ total: 1 }],
      [{ id: 6, kind: 'note', items_total: '0', items_done: '0' }],
      [],                                    // the IN(...) items query returns nothing
    ]);

    const res = await call('GET', '/checklists?kind=note&include=items');

    expect(res.body.checklists[0].items).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3g. upsert-items — the docs_needed path stays scoped to checklists
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /checklists/upsert-items — a note can never become the docs target', () => {
  test('the find query is scoped to kind=checklist', async () => {
    // The failure this prevents is silent and total: a tag=docs_needed note,
    // or a staff note merely TITLED "Docs Needed", selected here would receive
    // the checkitems, while portalDocsService and the public docs GET keep
    // reading the real checklist — and the client portal renders nothing.
    db = stubDb([
      [{ id: 30, tag: 'docs_needed' }],       // FIND_DOCS_SQL
      [],                                     // existing items
      ok(0, 1),                               // INSERT item 1
      [{ id: 30, kind: 'checklist' }],        // re-read list
      [{ id: 90, name: 'Paystubs' }],         // items
    ]);

    const res = await call('POST', '/checklists/upsert-items', {
      case_id: 'C-1', items: ['Paystubs'],
    });

    expect(res.status).toBe(200);
    expect(db.calls[0].sql).toContain("kind = 'checklist'");
  });

  test('the created Docs Needed row states kind explicitly', async () => {
    db = stubDb([
      [],                                     // FIND_DOCS_SQL — nothing yet
      ok(31),                                 // INSERT checklist
      [],                                     // existing items
      ok(0, 1),                               // INSERT item
      [{ id: 31, kind: 'checklist' }],
      [{ id: 91, name: 'Paystubs' }],
    ]);

    await call('POST', '/checklists/upsert-items', { case_id: 'C-2', items: ['Paystubs'] });

    const insert = db.calls[1];
    expect(insert.sql).toContain('INSERT INTO checklists (title, kind,');
    expect(insert.sql).toContain("'Docs Needed', 'checklist'");
  });
});
