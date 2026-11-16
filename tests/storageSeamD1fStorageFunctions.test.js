// tests/storageSeamD1fStorageFunctions.test.js
//
/**
 * scripts/storageSeamD1fStorageFunctions.js — every path of run() over a
 * scripted connection: the plan from the live fixture, the rewrite (names and
 * param KEYS only — values, placeholders and the other config keys untouched),
 * already-applied, resume after a half-done run, base drift (an unknown row, a
 * vanished fixture row, drifted keys), a dropbox_ mention outside
 * workflow_steps, an UPDATE that misses, a read-back mismatch. And the proof
 * that matters for the editor: every migrated config validates against the
 * REAL registry's __meta for its storage_* name.
 */

'use strict';

process.env.CREDENTIALS_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('base64');

const mig = require('../scripts/storageSeamD1fStorageFunctions');
const FIXTURE = require('./fixtures/storageReplay.workflowSteps.json');
const registry = require('../lib/internal_functions');

/** Live-shaped rows from the fixture: config = {function_name, params, set_vars?} as MySQL hands them back (objects). */
function liveRows(fixture = FIXTURE) {
  return fixture.steps.map((s) => ({
    id: s.step_id, workflow_id: s.workflow_id, version: s.version, step_number: s.step_number, type: 'internal_function',
    config: { function_name: s.function_name, params: JSON.parse(JSON.stringify(s.params)), ...(s.step_number === 9 ? { set_vars: { dbx_path: '{{this.output.metadata.path_display}}' } } : {}) },
  }));
}

/** A scripted connection over in-memory rows; `others` = counts for the five other columns. */
function conn(rows, { others = 0, updateHits = null, rereadMutate = null } = {}) {
  const calls = [];
  return {
    calls, rows,
    async query(sql, params) {
      calls.push([sql, params]);
      if (/^SELECT id, workflow_id, version/.test(sql)) {
        const names = params[0];
        return [rows.filter((r) => JSON.stringify(r.config).includes('dropbox_') || names.includes(r.config.function_name)).map((r) => ({ ...r, config: JSON.stringify(r.config) }))];
      }
      if (/^SELECT COUNT\(\*\) AS n FROM/.test(sql)) return [[{ n: others }]];
      if (/^UPDATE workflow_steps SET config/.test(sql)) {
        const [json, id, from] = params;
        const row = rows.find((r) => r.id === id && r.config.function_name === from);
        if (updateHits !== null) return [{ affectedRows: updateHits }];
        if (!row) return [{ affectedRows: 0 }];
        row.config = JSON.parse(json);
        return [{ affectedRows: 1 }];
      }
      if (/^SELECT id, config FROM workflow_steps WHERE id IN/.test(sql)) {
        const ids = params[0];
        return [rows.filter((r) => ids.includes(r.id)).map((r) => ({ id: r.id, config: rereadMutate ? rereadMutate(r) : { ...r.config } }))];
      }
      return [{ affectedRows: 0 }];
    },
  };
}
const sqls = (c) => c.calls.map(([s]) => s);
const quiet = { log: () => {} };

test('CHECK plans every live row, changes nothing, and names the next command', async () => {
  const c = conn(liveRows());
  const r = await mig.run(c, quiet);
  expect(r).toEqual({ ok: true, applied: 0, line: expect.stringMatching(/^CHECK OK — GO\. 21 row\(s\) to rewrite\. Next: node scripts\/storageSeamD1fStorageFunctions\.js --apply$/) });
  expect(sqls(c).some((s) => /^UPDATE|^START TRANSACTION/.test(s))).toBe(false);
  expect(sqls(c).filter((s) => /^SELECT COUNT/.test(s))).toHaveLength(5);
});

test('--apply renames the function and the param KEYS only; values, placeholders and set_vars are untouched; verified after COMMIT', async () => {
  const rows = liveRows();
  const before = JSON.parse(JSON.stringify(rows));
  const c = conn(rows);
  const r = await mig.run(c, { apply: true, ...quiet });
  expect(r).toEqual({ ok: true, applied: 21, line: expect.stringMatching(/^APPLIED — GO\. 21 row\(s\) rewritten and verified/) });
  const s = sqls(c);
  expect(s.filter((x) => /^UPDATE/.test(x))).toHaveLength(21);
  expect(s.indexOf('SET SESSION lock_wait_timeout = 5')).toBeLessThan(s.indexOf('START TRANSACTION'));
  expect(s.indexOf('START TRANSACTION')).toBeLessThan(s.findIndex((x) => /^UPDATE/.test(x)));
  expect(s.indexOf('COMMIT')).toBeGreaterThan(s.lastIndexOf('UPDATE workflow_steps SET config = CAST(? AS JSON) WHERE id = ? AND JSON_UNQUOTE(JSON_EXTRACT(config, \'$.function_name\')) = ?'));
  expect(s.indexOf('COMMIT')).toBeLessThan(s.findIndex((x) => /^SELECT id, config/.test(x)));
  const byId = new Map(before.map((b) => [b.id, b]));
  for (const row of rows) {
    const old = byId.get(row.id);
    const m = mig.MAPPING[old.config.function_name];
    expect(row.config.function_name).toBe(m.to);
    for (const [k, v] of Object.entries(old.config.params)) {
      const nk = k in m.keys ? m.keys[k] : k;
      if (nk === null) expect(row.config.params).not.toHaveProperty(k);
      else expect(row.config.params[nk]).toEqual(v);                          // the VALUE, placeholder and all
    }
    expect(Object.keys(row.config.params)).toHaveLength(Object.keys(old.config.params).filter((k) => m.keys[k] !== null).length);
    if (old.config.set_vars) expect(row.config.set_vars).toEqual(old.config.set_vars);
  }
  // the specific renames the live workflows need
  const byStep = (id) => rows.find((r) => r.id === id).config;
  expect(byStep(206)).toEqual({ function_name: 'storage_move', params: { to_path: '{{active_path}}', from_human_link: '{{case_dropbox}}' } });
  expect(byStep(585).params).toEqual({ path: '{{unsorted_path}}', with_link: true });
  expect(byStep(616).params.human_link).toBe('{{dest_link}}');
  expect(byStep(616).params.timeout_ms).toBe(90000);
  expect(byStep(619)).toEqual({ function_name: 'storage_list', params: { human_link: '{{dest_link}}' } });
});

test('every migrated config validates against the REAL registry __meta of its storage_* name (what the editor checks at save)', async () => {
  const rows = liveRows();
  await mig.run(conn(rows), { apply: true, ...quiet });
  for (const row of rows) {
    const problem = registry.__validateFunctionParams(row.config.function_name, row.config.params);
    expect({ id: row.id, fn: row.config.function_name, problem }).toEqual({ id: row.id, fn: row.config.function_name, problem: null });
  }
});

test('ALREADY APPLIED after a full run; a half-done run resumes and rewrites only what is left', async () => {
  const rows = liveRows();
  const c1 = conn(rows);
  await mig.run(c1, { apply: true, ...quiet });
  const again = await mig.run(conn(rows), { apply: true, ...quiet });
  expect(again).toEqual({ ok: true, applied: 0, line: expect.stringMatching(/^ALREADY APPLIED — GO\. 21 row\(s\) carry their storage_\* name/) });
  expect((await mig.run(conn(rows), quiet)).line).toMatch(/^ALREADY APPLIED — GO/);
  // put two rows back the way they were
  const fresh = liveRows();
  for (const id of [206, 585]) rows.find((r) => r.id === id).config = fresh.find((r) => r.id === id).config;
  const c3 = conn(rows);
  const r = await mig.run(c3, { apply: true, ...quiet });
  expect(r.applied).toBe(2);
  expect(sqls(c3).filter((x) => /^UPDATE/.test(x))).toHaveLength(2);
  expect(r.line).toMatch(/^APPLIED — GO\. 2 row\(s\)/);
});

test('base drift is NO-GO and changes nothing: an unknown live row, a vanished fixture row, drifted param keys', async () => {
  const extra = liveRows(); extra.push({ id: 9999, workflow_id: 77, version: 1, step_number: 1, type: 'internal_function', config: { function_name: 'dropbox_move', params: { to_path: '/x', from_path: '/y' } } });
  let c = conn(extra);
  let r = await mig.run(c, { apply: true, ...quiet });
  expect(r.ok).toBe(false); expect(r.line).toMatch(/^NO-GO — the live rows are not the base/);
  expect(sqls(c).some((s) => /^UPDATE|^START TRANSACTION/.test(s))).toBe(false);

  const missing = liveRows().filter((row) => row.id !== 206);
  r = await mig.run(conn(missing), { apply: true, ...quiet });
  expect(r.ok).toBe(false); expect(r.line).toMatch(/not the base/);

  const drifted = liveRows(); drifted.find((row) => row.id === 206).config.params.autorename = true;
  c = conn(drifted);
  r = await mig.run(c, { apply: true, ...quiet });
  expect(r.ok).toBe(false); expect(r.line).toMatch(/not the base/);
  expect(sqls(c).some((s) => /^UPDATE/.test(s))).toBe(false);
});

test('a dropbox_ mention in another config column is NO-GO before anything else', async () => {
  const c = conn(liveRows(), { others: 1 });
  const r = await mig.run(c, { apply: true, ...quiet });
  expect(r.ok).toBe(false); expect(r.line).toMatch(/^NO-GO — a dropbox_ mention sits outside workflow_steps/);
  expect(sqls(c).some((s) => /^UPDATE|^START TRANSACTION/.test(s))).toBe(false);
});

test('an UPDATE that misses rolls everything back; a read-back mismatch after COMMIT is NO-GO and says do not deploy', async () => {
  let c = conn(liveRows(), { updateHits: 0 });
  let r = await mig.run(c, { apply: true, ...quiet });
  expect(r).toEqual({ ok: false, applied: 0, line: expect.stringMatching(/^NO-GO — row 223: the UPDATE matched 0 row\(s\)/) });
  expect(sqls(c)).toContain('ROLLBACK'); expect(sqls(c)).not.toContain('COMMIT');

  c = conn(liveRows(), { rereadMutate: (row) => ({ ...row.config, params: { ...row.config.params, extra: 1 } }) });
  r = await mig.run(c, { apply: true, ...quiet });
  expect(r.ok).toBe(false); expect(r.applied).toBe(21); expect(r.line).toMatch(/do not read back as written \(committed\).*do not deploy D1f-3/);
});

test('the plan ignores a dropbox_ mention that is not a function name (a get_setting key) and reports it', async () => {
  const rows = liveRows();
  rows.push({ id: 579, workflow_id: 48, version: 1, step_number: 2, type: 'internal_function', config: { function_name: 'get_setting', params: { key: 'dropbox_unsorted_forms_path', output_var: 'unsorted_path' } } });
  const lines = [];
  const r = await mig.run(conn(rows), { log: (l) => lines.push(l) });
  expect(r.ok).toBe(true);
  expect(lines.some((l) => /ignored: row 579 \(wf 48\) get_setting/.test(l))).toBe(true);
  expect(lines[0]).toMatch(/rows mentioning dropbox_: 22 — pending 21, already migrated 0, ignored \(not a function name\) 1/);
});

test('canonical() ignores key order at every level (MySQL re-orders JSON on write); the fixture is the base the script knows', () => {
  expect(mig.canonical({ b: [{ y: 1, x: 2 }], a: 'z' })).toBe(mig.canonical({ a: 'z', b: [{ x: 2, y: 1 }] }));
  expect(mig.canonical({ a: [1, 2] })).not.toBe(mig.canonical({ a: [2, 1] }));
  expect(FIXTURE.steps).toHaveLength(21);
  expect(new Set(FIXTURE.steps.map((s) => s.function_name))).toEqual(new Set(['dropbox_save_url', 'dropbox_move', 'dropbox_create_folder', 'dropbox_ensure_case_folder', 'dropbox_get_shared_link', 'dropbox_list_folder']));
  expect(Object.keys(mig.MAPPING)).toHaveLength(8);
  // credential_id is dropped everywhere it could appear (no live row carries it, so only this sees the path)
  const m = mig.migrateConfig({ function_name: 'dropbox_save_url', params: { url: 'u', shared_link: 'L', filename: 'f', credential_id: 8, wait: false }, set_vars: { a: '{{x}}' } });
  expect(m.next).toEqual({ function_name: 'storage_import_url', params: { url: 'u', human_link: 'L', filename: 'f', wait: false }, set_vars: { a: '{{x}}' } });
  expect(m.renamed).toEqual(['shared_link→human_link']); expect(m.dropped).toEqual(['credential_id']);
  expect(mig.migrateConfig({ function_name: 'storage_move', params: {} })).toBeNull();
  expect(mig.migrateConfig({ function_name: 'get_setting', params: { key: 'dropbox_unsorted_forms_path' } })).toBeNull();
  for (const m of Object.values(mig.MAPPING)) expect(typeof registry[m.to]).toBe('function');
});
