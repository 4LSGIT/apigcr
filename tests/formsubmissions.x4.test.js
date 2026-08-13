// X4 — Form Inbox backend (EXTERNAL_FORMS_DESIGN §8).
// Two layers, matching the slice-4 / x2 precedents:
//   1. formService unit tests (scripted stub pool) — linkSubmission guard
//      ladder, version renumber into the target series, the intake-gate
//      stamp's additive WHERE, best-effort log isolation;
//      getSubmissionForRender's three-step definition resolution;
//      browseSubmissions unlinked=1 / with_data=1 opt-ins (and that their
//      ABSENCE keeps the pre-X4 query shape).
//   2. LIVE-ROUTER integration — routes/api.forms.js mounted in a real
//      express app on an ephemeral port: route→service wiring, .status error
//      mapping, linked_by from req.auth (never the body).
'use strict';

const path = require('path');
const assert = require('assert');
const express = require('express');

const formSvc = require(path.join(__dirname, '..', 'services', 'formService.js'));

// ── Stub pool (formTemplates_slice4_service pattern): scripted results, every
//    call recorded. Results are row arrays; [rows] is built here. UPDATEs are
//    scripted as result objects ({ affectedRows }).
function stubDb(script) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params: params || [] });
      if (!script.length) throw new Error('stubDb: unscripted query: ' + sql);
      return [script.shift()];
    },
  };
}

async function rejects(promise, status, msgPart) {
  try { await promise; }
  catch (err) {
    assert.strictEqual(err.status, status, `expected .status ${status}, got ${err.status}: ${err.message}`);
    if (msgPart) assert.ok(err.message.includes(msgPart), `message "${err.message}" should include "${msgPart}"`);
    return;
  }
  assert.fail('expected rejection with status ' + status);
}

// Rows reused across tests.
const unlinkedSub = { id: 286, form_key: 'intake', link_type: '', link_id: '', status: 'submitted', version: 1 };
const intakeTpl   = { title: 'Bankruptcy Intake', link_type: 'case' };

describe('X4 — linkSubmission', () => {

  test('happy path: guards pass, version renumbers into the target series, stamp + log fire', async () => {
    const db = stubDb([
      [unlinkedSub],                       // submission fetch
      [intakeTpl],                         // template fetch
      [{ case_id: 'hjSFMabb' }],           // target exists
      [{ max_version: 3 }],                // target series max
      { affectedRows: 1 },                 // linkage UPDATE
      { affectedRows: 1 },                 // intake stamp UPDATE
      { insertId: 900 },                   // createLogEntry INSERT (shape irrelevant)
    ]);
    const out = await formSvc.linkSubmission(db, 286, 'case', 'hjSFMabb', 6);

    assert.strictEqual(out.link_type, 'case');
    assert.strictEqual(out.link_id, 'hjSFMabb');
    assert.strictEqual(out.version, 4, 'MAX(version)+1 in the TARGET series, not the old anon version');
    assert.strictEqual(out.linked_by, 6);
    assert.strictEqual(out.intake_stamped, true);

    // linkage UPDATE: double-guarded WHERE + linked_by from the caller
    const upd = db.calls[4];
    assert.ok(upd.sql.includes("WHERE id = ? AND link_type = ''"), 'concurrent-adopt guard in WHERE');
    assert.deepStrictEqual(upd.params, ['case', 'hjSFMabb', 4, 6, 286]);

    // intake stamp: additive-only guard in the WHERE, wf40-step-8 value shape
    const stamp = db.calls[5];
    assert.ok(stamp.sql.includes("case_intake_form = ''"), 'stamp only fills an EMPTY gate');
    assert.deepStrictEqual(stamp.params, ['yf:286', 'hjSFMabb']);
  });

  test('guard ladder: 404 unknown, 400 draft, 409 already linked, 400 bad type, 400 empty id', async () => {
    await rejects(formSvc.linkSubmission(stubDb([[]]), 9, 'case', 'x', 6), 404, 'Submission 9 not found');
    await rejects(
      formSvc.linkSubmission(stubDb([[{ ...unlinkedSub, status: 'draft' }]]), 286, 'case', 'x', 6),
      400, 'Only submitted');
    await rejects(
      formSvc.linkSubmission(stubDb([[{ ...unlinkedSub, link_type: 'case', link_id: 'uT7EU36v' }]]), 286, 'case', 'x', 6),
      409, 'already linked');
    await rejects(formSvc.linkSubmission(stubDb([]), 286, 'bill', 'x', 6), 400, "link_type must be");
    await rejects(formSvc.linkSubmission(stubDb([]), 286, 'case', '  ', 6), 400, 'link_id is required');
    await rejects(formSvc.linkSubmission(stubDb([]), 'abc', 'case', 'x', 6), 400, 'positive integer');
  });

  test('template link_type mismatch 409s; a missing template row skips the guard', async () => {
    await rejects(
      formSvc.linkSubmission(stubDb([
        [unlinkedSub],
        [{ title: 'Intake', link_type: 'case' }],
      ]), 286, 'contact', '1001', 6),
      409, 'case-linked form');

    // No template row → guard skipped, flow proceeds to the entity probe (404s
    // there in this script, proving we got past the template guard).
    await rejects(
      formSvc.linkSubmission(stubDb([
        [{ ...unlinkedSub, form_key: 'legacy_key' }],
        [],                                  // no template
        [],                                  // entity not found
      ]), 286, 'contact', '999999', 6),
      404, 'contact "999999" not found');
  });

  test('target entity must exist — opaque equality probe per type', async () => {
    const db = stubDb([
      [unlinkedSub],
      [intakeTpl],
      [],                                    // case not found
    ]);
    await rejects(formSvc.linkSubmission(db, 286, 'case', 'ZZZZZZZZ', 6), 404, 'case "ZZZZZZZZ" not found');
    assert.ok(db.calls[2].sql.includes('SELECT case_id FROM cases WHERE case_id = ?'),
      'existence check is PK equality only — no shape parsing');
  });

  test('concurrent adopt loses cleanly: affectedRows 0 → 409, no side-effects', async () => {
    const db = stubDb([
      [unlinkedSub],
      [intakeTpl],
      [{ case_id: 'hjSFMabb' }],
      [{ max_version: 0 }],
      { affectedRows: 0 },                   // someone else linked it first
    ]);
    await rejects(formSvc.linkSubmission(db, 286, 'case', 'hjSFMabb', 6), 409, 'linked by someone else');
    assert.strictEqual(db.calls.length, 5, 'no stamp, no log after a lost race');
  });

  test('non-intake / non-case adopts never touch the intake gate; log failure never rolls back', async () => {
    // contact adopt of a contact-form: no stamp query at all; the log INSERT
    // throws (unscripted) and the linkage still returns success.
    const db = stubDb([
      [{ id: 50, form_key: 'contact_info', link_type: '', link_id: '', status: 'submitted', version: 2 }],
      [{ title: 'Contact Info', link_type: 'contact' }],
      [{ contact_id: 1001 }],
      [{ max_version: 7 }],
      { affectedRows: 1 },
      // nothing scripted for the log INSERT → stubDb throws → caught inside
    ]);
    const out = await formSvc.linkSubmission(db, 50, 'contact', '1001', 22);
    assert.strictEqual(out.intake_stamped, false);
    assert.strictEqual(out.logged, false, 'log failure surfaces as logged:false, not an error');
    assert.strictEqual(out.version, 8);
    const sqls = db.calls.map(c => c.sql).join(' | ');
    assert.ok(!sqls.includes('case_intake_form'), 'no intake stamp outside intake+case');
  });
});


describe('X4 — getSubmissionForRender', () => {
  const def = { sections: [{ title: 'S', rows: [{ fields: [{ name: 'a', type: 'text' }] }] }] };

  const subRow = (over) => ({
    id: 286, form_key: 'intake', link_type: '', link_id: '', status: 'submitted',
    version: 1, schema_version: 1, data: JSON.stringify({ a: 'x' }),
    submitted_by: null, user_name: null, linked_by: null, linked_at: null,
    created_at: 't', updated_at: 't', ...over,
  });

  test('current published definition when schema_version matches; data comes back parsed', async () => {
    const db = stubDb([
      [subRow()],
      [{ id: 8, title: 'Bankruptcy Intake', link_type: 'case', schema_version: 1, definition: JSON.stringify(def) }],
    ]);
    const out = await formSvc.getSubmissionForRender(db, 286);
    assert.strictEqual(out.schema_matched, true);
    assert.strictEqual(out.definition_schema_version, 1);
    assert.deepStrictEqual(out.definition, def);
    assert.deepStrictEqual(out.submission.data, { a: 'x' }, 'json column normalized to an object');
    assert.strictEqual(out.title, 'Bankruptcy Intake');
  });

  test('schema mismatch → newest version row with that schema_version wins', async () => {
    const db = stubDb([
      [subRow({ schema_version: 1 })],
      [{ id: 8, title: 'T', link_type: 'case', schema_version: 2, definition: JSON.stringify({ v: 'current' }) }],
      [{ definition: JSON.stringify(def), schema_version: 1 }],   // version row hit
    ]);
    const out = await formSvc.getSubmissionForRender(db, 286);
    assert.strictEqual(out.schema_matched, true);
    assert.deepStrictEqual(out.definition, def, 'archived definition, not the current one');
    assert.ok(db.calls[2].sql.includes('ORDER BY id DESC LIMIT 1'),
      'NEWEST version row for that schema_version (layout-only republishes share it)');
  });

  test('no version row → current definition flagged schema_matched:false; nothing anywhere → 404', async () => {
    const db = stubDb([
      [subRow({ schema_version: 1 })],
      [{ id: 8, title: 'T', link_type: 'case', schema_version: 3, definition: JSON.stringify({ v: 'current' }) }],
      [],                                    // no version row
    ]);
    const out = await formSvc.getSubmissionForRender(db, 286);
    assert.strictEqual(out.schema_matched, false);
    assert.deepStrictEqual(out.definition, { v: 'current' });

    await rejects(formSvc.getSubmissionForRender(stubDb([
      [subRow()],
      [{ id: 8, title: 'T', link_type: 'case', schema_version: 3, definition: null }],
      [],
    ]), 286), 404, 'No published definition');

    await rejects(formSvc.getSubmissionForRender(stubDb([
      [subRow({ form_key: 'ghost' })],
      [],                                    // template row gone
    ]), 286), 404, 'No template exists');
  });
});


describe('X4 — browseSubmissions opt-ins', () => {

  test('unlinked=1 adds the empty-link_type WHERE; with_data=1 adds fs.data; defaults stay pre-X4', async () => {
    const db = stubDb([[]]);
    await formSvc.browseSubmissions(db, { unlinked: '1', with_data: '1', status: 'submitted' });
    const c = db.calls[0];
    assert.ok(c.sql.includes("fs.link_type = ''"), 'unlinked convention in WHERE');
    assert.ok(c.sql.includes('fs.data'), 'data bodies included on opt-in');

    const dbDefault = stubDb([[]]);
    await formSvc.browseSubmissions(dbDefault, { status: 'submitted' });
    const d = dbDefault.calls[0];
    assert.ok(!d.sql.includes('fs.data'), 'no data bodies by default (slice-4 lock preserved)');
    assert.ok(!d.sql.includes("link_type = ''"), 'no unlinked filter by default');
    assert.ok(!d.sql.includes('link_type <> '), 'no linked filter by default');
  });

  test('linked=1 is the inverse filter; asking for both at once is a 400, not an empty list', async () => {
    const db = stubDb([[]]);
    await formSvc.browseSubmissions(db, { linked: '1', status: 'submitted' });
    const c = db.calls[0];
    assert.ok(c.sql.includes("fs.link_type <> ''"), 'linked scope excludes the unlinked convention');
    assert.ok(!c.sql.includes("fs.link_type = ''"), 'and does not also carry the unlinked filter');

    // Both together select nothing — a silent empty list would read as
    // "no submissions" instead of "bad query".
    await rejects(formSvc.browseSubmissions(stubDb([]), { unlinked: '1', linked: '1' }),
      400, 'mutually exclusive');
  });
});


// ═════════════════════════════════════════════════════════════════════════════
// LIVE-ROUTER integration — routes/api.forms.js on an ephemeral port.
// jwtOrApiKey is jest-mocked to inject req.auth; req.db is the stub pool.
// ═════════════════════════════════════════════════════════════════════════════

jest.mock('../lib/auth.jwtOrApiKey', () =>
  (req, res, next) => { req.auth = { userId: 42 }; next(); });

describe('X4 — routes (live router)', () => {
  let server, base, dbHolder;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    dbHolder = { db: null };
    app.use((req, res, next) => { req.db = dbHolder.db; next(); });
    app.use(require(path.join(__dirname, '..', 'routes', 'api.forms.js')));
    server = app.listen(0, () => {
      base = 'http://127.0.0.1:' + server.address().port;
      done();
    });
  });
  afterAll((done) => { server.close(done); });

  test('PATCH :id/link — linked_by comes from req.auth, NEVER the body', async () => {
    dbHolder.db = stubDb([
      [unlinkedSub],
      [intakeTpl],
      [{ case_id: 'hjSFMabb' }],
      [{ max_version: 0 }],
      { affectedRows: 1 },
      { affectedRows: 1 },
      { insertId: 1 },
    ]);
    const resp = await fetch(base + '/api/forms/submissions/286/link', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      // Hostile body tries to spoof the adopter — must be ignored.
      body: JSON.stringify({ link_type: 'case', link_id: 'hjSFMabb', linked_by: 999, userId: 999 }),
    });
    const body = await resp.json();
    assert.strictEqual(resp.status, 200);
    assert.strictEqual(body.linked_by, 42, 'auth principal, not the body');
    const upd = dbHolder.db.calls.find(c => c.sql.startsWith('UPDATE form_submissions'));
    assert.strictEqual(upd.params[3], 42);
  });

  test('PATCH :id/link maps service statuses (409 already linked)', async () => {
    dbHolder.db = stubDb([
      [{ ...unlinkedSub, link_type: 'case', link_id: 'uT7EU36v' }],
    ]);
    const resp = await fetch(base + '/api/forms/submissions/286/link', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ link_type: 'case', link_id: 'hjSFMabb' }),
    });
    assert.strictEqual(resp.status, 409);
    const body = await resp.json();
    assert.strictEqual(body.status, 'error');
    assert.ok(body.message.includes('already linked'));
  });

  test('GET :id/render returns the joined payload; 404 maps through', async () => {
    const def = { sections: [] };
    dbHolder.db = stubDb([
      [{ id: 286, form_key: 'intake', link_type: '', link_id: '', status: 'submitted',
         version: 1, schema_version: 1, data: JSON.stringify({ name: 'x' }),
         submitted_by: null, user_name: null, linked_by: null, linked_at: null,
         created_at: 't', updated_at: 't' }],
      [{ id: 8, title: 'Bankruptcy Intake', link_type: 'case', schema_version: 1,
         definition: JSON.stringify(def) }],
    ]);
    let resp = await fetch(base + '/api/forms/submissions/286/render');
    let body = await resp.json();
    assert.strictEqual(resp.status, 200);
    assert.strictEqual(body.schema_matched, true);
    expect(body.definition).toEqual(def);
    expect(body.submission.data).toEqual({ name: 'x' });

    dbHolder.db = stubDb([[]]);
    resp = await fetch(base + '/api/forms/submissions/999/render');
    assert.strictEqual(resp.status, 404);
  });

  test('GET /api/forms/submissions passes unlinked/with_data through to the service', async () => {
    dbHolder.db = stubDb([[]]);
    const resp = await fetch(base + '/api/forms/submissions?unlinked=1&with_data=1&status=submitted');
    assert.strictEqual(resp.status, 200);
    const c = dbHolder.db.calls[0];
    assert.ok(c.sql.includes("fs.link_type = ''") && c.sql.includes('fs.data'),
      'query-string opt-ins reach the SQL');
  });
});
