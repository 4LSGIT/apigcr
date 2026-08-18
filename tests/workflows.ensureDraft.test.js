/**
 * tests/workflows.ensureDraft.test.js
 *
 * Scripted-mock tests for the draft fork (routes/workflows.js ensureDraft,
 * exposed via router._test) plus static wiring assertions for the S3
 * versioning endpoints.
 *
 * ensureDraft is the concurrency-critical primitive of the whole versioning
 * arc: it must lock the PARENT row first (lock-ordering invariant — the only
 * deadlock defense, since withTransaction deliberately has no deadlock
 * retry), copy exactly the published version, and number new drafts past
 * retired ones. The mock connection scripts row responses per SQL pattern
 * and captures the statement order so those properties are asserted, not
 * assumed — same technique as tests/esignReminders.test.js.
 *
 *   npx jest tests/workflows.ensureDraft.test.js
 */

const fs = require('fs');
const path = require('path');

const router = require('../routes/workflows');
const { ensureDraft } = router._test;

function mockConn(script) {
  const captured = [];
  return {
    captured,
    query: jest.fn(async (sql, params) => {
      captured.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      for (const [re, result] of script) {
        if (re.test(sql)) return typeof result === 'function' ? result(sql, params) : result;
      }
      return [[]];
    }),
  };
}

describe('ensureDraft — draft fork mechanics', () => {
  test('first edit forks a draft: locks parent FIRST, copies current, numbers past retired versions', async () => {
    const conn = mockConn([
      [/SELECT current_version, draft_version FROM workflows WHERE id = \? FOR UPDATE/, [[{ current_version: 3, draft_version: null }]]],
      [/SELECT COALESCE\(MAX\(version\), 0\) AS mx FROM workflow_versions/, [[{ mx: 5 }]]], // v4, v5 = retired drafts
      [/INSERT INTO workflow_steps/, [{ affectedRows: 4 }]],
      [/INSERT INTO workflow_versions/, [{ affectedRows: 1 }]],
      [/UPDATE workflows SET draft_version/, [{ affectedRows: 1 }]],
    ]);

    const draft = await ensureDraft(conn, 42);

    // Retired drafts occupy numbers: next draft is MAX(6), not current+1 (4).
    expect(draft).toBe(6);

    // Lock-ordering invariant: the very first statement is the parent-row
    // FOR UPDATE — before any version-table access.
    expect(conn.captured[0].sql).toMatch(/FROM workflows WHERE id = \? FOR UPDATE/);
    expect(conn.captured[0].params).toEqual([42]);

    // The copy sources the PUBLISHED version's rows into the new draft.
    const copy = conn.captured.find((c) => /INSERT INTO workflow_steps/.test(c.sql));
    expect(copy.sql).toMatch(/SELECT workflow_id, \?, step_number, label, note, type, config, error_policy/);
    expect(copy.params).toEqual([6, 42, 3]);

    // Metadata stub carries NO published_at (that is publish's job).
    const stub = conn.captured.find((c) => /INSERT INTO workflow_versions/.test(c.sql));
    expect(stub.sql).not.toMatch(/published_at/);

    // And the parent row is pointed at the draft.
    const point = conn.captured.find((c) => /UPDATE workflows SET draft_version/.test(c.sql));
    expect(point.params).toEqual([6, 42]);
  });

  test('an existing draft is reused — single SELECT, no copies', async () => {
    const conn = mockConn([
      [/FOR UPDATE/, [[{ current_version: 3, draft_version: 4 }]]],
    ]);
    const draft = await ensureDraft(conn, 42);
    expect(draft).toBe(4);
    expect(conn.captured).toHaveLength(1);
  });

  test('missing workflow returns null (doubles as the 404 check)', async () => {
    const conn = mockConn([[/FOR UPDATE/, [[]]]]);
    expect(await ensureDraft(conn, 999)).toBeNull();
  });

  test('never-published workflow (current_version 0) forks an empty draft numbered 1', async () => {
    const conn = mockConn([
      [/FOR UPDATE/, [[{ current_version: 0, draft_version: null }]]],
      [/COALESCE\(MAX\(version\), 0\)/, [[{ mx: 0 }]]],
      [/INSERT INTO workflow_steps/, [{ affectedRows: 0 }]], // copies nothing from v0
      [/INSERT INTO workflow_versions/, [{ affectedRows: 1 }]],
      [/UPDATE workflows SET draft_version/, [{ affectedRows: 1 }]],
    ]);
    expect(await ensureDraft(conn, 7)).toBe(1);
  });
});

describe('S3 versioning endpoints — wiring', () => {
  const routes = router.stack
    .filter((l) => l.route)
    .map((l) => ({ path: l.route.path, methods: l.route.methods }));

  const has = (method, p) => routes.some((r) => r.path === p && r.methods[method]);

  test('lifecycle routes are registered', () => {
    expect(has('get', '/workflows/:id/versions')).toBe(true);
    expect(has('get', '/workflows/:id/draft-diff')).toBe(true);
    expect(has('post', '/workflows/:id/publish')).toBe(true);
    expect(has('post', '/workflows/:id/discard-draft')).toBe(true);
  });

  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'workflows.js'), 'utf8');

  test('publish re-runs the classifier inside the transaction and refuses structural migration server-side', () => {
    // The UI checkbox is convenience; THIS is the gate. If someone posts
    // migrate_in_flight against a structural diff, the tx must 409.
    expect(src).toMatch(/Structural changes cannot migrate in-flight runs/);
    // and the migration UPDATE only touches non-terminal executions on the
    // superseded version.
    expect(src).toMatch(/UPDATE workflow_executions\s+SET workflow_version = \?\s+WHERE workflow_id = \? AND workflow_version = \? AND status IN \('active','delayed','held'\)/);
  });

  test('discard retires in place — no DELETE of draft step rows anywhere in the discard route', () => {
    const start = src.indexOf('"/workflows/:id/discard-draft"');
    const end = src.indexOf('router.', start + 10);
    const body = src.slice(start, end);
    expect(body).toMatch(/SET retired_at = NOW\(\)/);
    expect(body).not.toMatch(/DELETE FROM workflow_steps/);
  });

  test('creation paths are born unpublished (current_version = 0) with no published metadata seed', () => {
    expect(src).toMatch(/INSERT INTO workflows \(name, description, test_input, current_version\)\s+VALUES \(\?, \?, \?, 0\)/);
    expect(src).toMatch(/INSERT INTO workflows \(name, description, test_input, current_version, draft_version\) VALUES \(\?, \?, \?, 0, 1\)/);
    // duplicate lands unpublished too
    expect(src).toMatch(/current_version, draft_version\) VALUES \(\?, \?, \?, \?, \?, 0, 1\)/);
    // no creation path stamps published_by anymore — publish is the only place
    expect(src).not.toMatch(/'create'\)/);
    expect(src).not.toMatch(/'bulk-import'\)/);
    expect(src).not.toMatch(/'duplicate'\)/);
  });

  test('the start route resolves use_draft and refuses never-published runs', () => {
    expect(src).toMatch(/use_draft/);
    expect(src).toMatch(/Workflow has never been published/);
  });
});

describe('dispatch sites refuse never-published workflows (review D4a)', () => {
  test('hook dispatcher, wf→wf function, and seq→wf step all guard current_version = 0', () => {
    const dispatchers = fs.readFileSync(path.join(__dirname, '..', 'lib', 'actionDispatchers.js'), 'utf8');
    const composition = fs.readFileSync(path.join(__dirname, '..', 'lib', 'internal_functions', 'composition.js'), 'utf8');
    const seqEngine = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sequenceEngine.js'), 'utf8');
    expect(dispatchers).toMatch(/has never been published/);
    expect(composition).toMatch(/has never been published/);
    expect(seqEngine).toMatch(/has never been published/);
  });
});
