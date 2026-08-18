/**
 * tests/sequences.ensureDraft.test.js
 *
 * S4 counterpart of tests/workflows.ensureDraft.test.js: scripted-mock tests
 * of the sequence-template draft fork, plus static wiring assertions for the
 * S4 lifecycle endpoints, the versioned-condition split, and the engine-side
 * guards (fail-loud enroll funnel, cascade filter, pinned-condition join,
 * step-load hardening).
 *
 *   npx jest tests/sequences.ensureDraft.test.js
 */

const fs = require('fs');
const path = require('path');

const router = require('../routes/sequences');
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

describe('sequences ensureDraft — draft fork mechanics', () => {
  test('first edit forks a draft: parent lock FIRST, copies current, condition snapshot COALESCEs to the version row', async () => {
    const conn = mockConn([
      [/SELECT current_version, draft_version FROM sequence_templates WHERE id = \? FOR UPDATE/, [[{ current_version: 2, draft_version: null }]]],
      [/SELECT COALESCE\(MAX\(version\), 0\) AS mx FROM sequence_template_versions/, [[{ mx: 4 }]]],
      [/INSERT INTO sequence_steps/, [{ affectedRows: 3 }]],
      [/INSERT INTO sequence_template_versions/, [{ affectedRows: 1 }]],
      [/UPDATE sequence_templates SET draft_version/, [{ affectedRows: 1 }]],
    ]);

    const draft = await ensureDraft(conn, 19);
    expect(draft).toBe(5); // past the retired v3/v4 drafts

    // Lock-ordering invariant: parent-row FOR UPDATE is statement #1.
    expect(conn.captured[0].sql).toMatch(/FROM sequence_templates WHERE id = \? FOR UPDATE/);
    expect(conn.captured[0].params).toEqual([19]);

    const copy = conn.captured.find(c => /INSERT INTO sequence_steps/.test(c.sql));
    expect(copy.params).toEqual([5, 19, 2]);

    // The metadata stub takes template_condition from the CURRENT VERSION row
    // (post-S4 truth), falling back to the legacy live column only for v0
    // templates — that COALESCE + LEFT JOIN shape is load-bearing.
    const stub = conn.captured.find(c => /INSERT INTO sequence_template_versions/.test(c.sql));
    expect(stub.sql).toMatch(/COALESCE\(cv\.template_condition, tt\.`condition`\)/);
    expect(stub.sql).toMatch(/LEFT JOIN sequence_template_versions cv/);
    expect(stub.sql).not.toMatch(/published_at/);
  });

  test('an existing draft is reused — single SELECT', async () => {
    const conn = mockConn([[/FOR UPDATE/, [[{ current_version: 2, draft_version: 3 }]]]]);
    expect(await ensureDraft(conn, 19)).toBe(3);
    expect(conn.captured).toHaveLength(1);
  });

  test('missing template returns null', async () => {
    const conn = mockConn([[/FOR UPDATE/, [[]]]]);
    expect(await ensureDraft(conn, 999)).toBeNull();
  });

  test('never-published template (v0) forks an empty draft numbered 1', async () => {
    const conn = mockConn([
      [/FOR UPDATE/, [[{ current_version: 0, draft_version: null }]]],
      [/COALESCE\(MAX\(version\), 0\)/, [[{ mx: 0 }]]],
      [/INSERT INTO sequence_steps/, [{ affectedRows: 0 }]],
      [/INSERT INTO sequence_template_versions/, [{ affectedRows: 1 }]],
      [/UPDATE sequence_templates SET draft_version/, [{ affectedRows: 1 }]],
    ]);
    expect(await ensureDraft(conn, 7)).toBe(1);
  });
});

describe('S4 lifecycle endpoints — wiring', () => {
  const routes = router.stack.filter(l => l.route).map(l => ({ path: l.route.path, methods: l.route.methods }));
  const has = (m, p) => routes.some(r => r.path === p && r.methods[m]);

  test('lifecycle routes are registered', () => {
    expect(has('get', '/sequences/templates/:id/versions')).toBe(true);
    expect(has('get', '/sequences/templates/:id/draft-diff')).toBe(true);
    expect(has('post', '/sequences/templates/:id/publish')).toBe(true);
    expect(has('post', '/sequences/templates/:id/discard-draft')).toBe(true);
  });

  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sequences.js'), 'utf8');

  test('publish refuses structural migration server-side and remaps pending jobs by (template, version, step_number)', () => {
    expect(src).toMatch(/Structural changes cannot migrate in-flight enrollments/);
    expect(src).toMatch(/JSON_SET\(sj\.data, '\$\.stepId', ns\.id\)/);
    expect(src).toMatch(/sj\.type = 'sequence_step' AND sj\.status = 'pending'/);
    expect(src).toMatch(/sj\.sequence_enrollment_id IN \(\?\)/);
  });

  test('discard retires in place — no DELETE of draft step rows in the discard route', () => {
    const start = src.indexOf("'/sequences/templates/:id/discard-draft'");
    const end = src.indexOf('router.', start + 10);
    const body = src.slice(start, end);
    expect(body).toMatch(/SET retired_at = NOW\(\)/);
    expect(body).not.toMatch(/DELETE FROM sequence_steps/);
  });

  test('creation paths are born unpublished with no published metadata seeds', () => {
    expect(src).toMatch(/current_version\)\s+VALUES \(\?, \?, \?, \?, \?, \?, \?, 0\)/);
    expect(src).toMatch(/current_version, draft_version\)\s+VALUES \(\?, \?, \?, \?, \?, 0, \?, \?, \?, 0, 1\)/);
    expect(src).not.toMatch(/'create'\)/);
    expect(src).not.toMatch(/'duplicate'\)/);
  });

  test('PUT template writes the versioned condition to the DRAFT version row, not the live column', () => {
    expect(src).toMatch(/UPDATE sequence_template_versions SET template_condition = \? WHERE template_id = \? AND version = \?/);
    // and the live-column write for `condition` is gone from the PUT's
    // dynamic update list.
    const putStart = src.indexOf("router.put('/sequences/templates/:id',");
    const putEnd = src.indexOf('router.', putStart + 10);
    const putBody = src.slice(putStart, putEnd);
    expect(putBody).not.toMatch(/updates\.push\('\\?`condition`/);
  });

  test('publish validation re-runs the editor validators across the whole draft', () => {
    expect(src).toMatch(/_validateSequenceDraft/);
    const fn = src.slice(src.indexOf('async function _validateSequenceDraft'), src.indexOf('// POST /sequences/templates/:id/publish'));
    expect(fn).toMatch(/validateTiming\(timing\)/);
    expect(fn).toMatch(/validateStepConfig\(db, s\.action_type, cfg\)/);
  });
});

describe('engine-side S4 guards (lib/sequenceEngine.js)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sequenceEngine.js'), 'utf8');

  test('the enroll funnel fail-louds on never-published templates (no || 1 fallback)', () => {
    expect(src).toMatch(/has never been published — publish it before enrolling/);
    expect(src).not.toMatch(/Number\(template\.current_version\) \|\| 1/);
  });

  test('cascade matching filters out unpublished templates', () => {
    expect(src).toMatch(/WHERE type = \? AND active = 1 AND current_version > 0/);
  });

  test('executeStep reads the template condition from the enrollment-pinned version row and fails loud on a missing row', () => {
    expect(src).toMatch(/LEFT JOIN sequence_template_versions tv\s+ON tv\.template_id = e\.template_id AND tv\.version = e\.template_version/);
    expect(src).toMatch(/template_version_row_missing/);
    // the old live-column join is gone
    expect(src).not.toMatch(/t\.`condition` AS template_condition/);
  });

  test('executeStep constrains the job stepId to the pinned (template, version)', () => {
    expect(src).toMatch(/SELECT \* FROM sequence_steps WHERE id = \? AND template_id = \? AND version = \?/);
  });

  test('preview template mode is draft-else-current and reads the condition from the SAME version row', () => {
    expect(src).toMatch(/pinnedVersion \?\? \(template\.draft_version \?\? template\.current_version\)/);
    expect(src).toMatch(/SELECT template_condition FROM sequence_template_versions WHERE template_id = \? AND version = \?/);
  });
});
