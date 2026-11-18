// tests/storageSeamD3c3Contract.test.js
//
/**
 * scripts/storageSeamD3c3Contract.js over a scripted connection: CHECK (GO,
 * naming re-copy vs already-equal), --apply (lock_wait → UPDATE (only when the
 * case block differs) → read-back verify → DELETE → verify gone), ALREADY
 * APPLIED (legacy gone, tree has case), and the NO-GOs (no tree; contact not
 * null; legacy present but not a stage map; legacy gone and no case block; a
 * read-back mismatch keeps the legacy row). Key order ignored.
 */

'use strict';

const mig = require('../scripts/storageSeamD3c3Contract');
const quiet = { log: () => {} };
const STAGES = { potential: { default: '/  P/ {{case_id}}', subfolders: ['Client Uploads'] }, active: { 'Bankruptcy:Chapter 7': '/  A/ 7 - {{lfm_name}}', default: '/  A/ {{case_id}}', subfolders: [' Docket'] } };

function conn({ tree, legacy, readBackTree } = {}) {
  const calls = [];
  let treeNow = tree === undefined ? undefined : (typeof tree === 'string' ? tree : JSON.stringify(tree));
  let legacyNow = legacy === undefined ? undefined : (typeof legacy === 'string' ? legacy : JSON.stringify(legacy));
  let updated = false;
  return {
    calls,
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      calls.push([s, params]);
      if (/^SET SESSION lock_wait_timeout = 5$/.test(s)) return [{}];
      if (/^SELECT `key`, `value` FROM app_settings WHERE `key` IN \(\?, \?\)$/.test(s)) {
        const rows = [];
        const t = updated && readBackTree !== undefined ? JSON.stringify(readBackTree) : treeNow;
        if (t !== undefined) rows.push({ key: 'storage_folders', value: t });
        if (legacyNow !== undefined) rows.push({ key: 'dropbox_case_folder_templates', value: legacyNow });
        return [rows];
      }
      if (/^UPDATE app_settings SET `value` = \? WHERE `key` = \?$/.test(s)) { expect(params[1]).toBe('storage_folders'); treeNow = params[0]; updated = true; return [{ affectedRows: 1 }]; }
      if (/^DELETE FROM app_settings WHERE `key` = \?$/.test(s)) { expect(params[0]).toBe('dropbox_case_folder_templates'); legacyNow = undefined; return [{ affectedRows: 1 }]; }
      throw new Error('unexpected SQL: ' + s.slice(0, 80));
    },
    get tree() { return treeNow == null ? null : JSON.parse(treeNow); },
    get legacy() { return legacyNow; },
  };
}
const verbs = (c) => c.calls.map(([s]) => s.split(' ')[0]);

test('CHECK on the D3c-1 state (the tree holds an older copy): GO naming the re-copy; nothing written', async () => {
  const c = conn({ tree: { case: { potential: { default: '/  OLD', subfolders: [] } }, contact: null }, legacy: STAGES });
  const r = await mig.run(c, quiet);
  expect(r).toEqual({ ok: true, copied: false, deleted: false, line: expect.stringMatching(/^CHECK OK — GO\. storage_folders\.case will be re-copied from the live dropbox_case_folder_templates row \(potential, active\); then the legacy row is deleted/) });
  expect(verbs(c)).toEqual(['SELECT']);
  const same = await mig.run(conn({ tree: { case: STAGES, contact: null }, legacy: STAGES }), quiet);
  expect(same.line).toMatch(/already equals the live dropbox_case_folder_templates row/);
});

test('--apply: lock_wait, the UPDATE carrying { ...tree, case: <the legacy row NOW> } with the tree\'s other keys kept, the read-back verify, the DELETE, verified gone → GO', async () => {
  const c = conn({ tree: { case: { potential: { default: '/  OLD', subfolders: [] } }, contact: null, note: 'kept' }, legacy: STAGES });
  const r = await mig.run(c, { apply: true, ...quiet });
  expect(r).toEqual({ ok: true, copied: true, deleted: true, line: expect.stringMatching(/^APPLIED — GO\. storage_folders\.case re-copied from the legacy row, verified, and dropbox_case_folder_templates deleted/) });
  expect(verbs(c)).toEqual(['SELECT', 'SET', 'UPDATE', 'SELECT', 'DELETE', 'SELECT']);
  expect(c.tree).toEqual({ case: STAGES, contact: null, note: 'kept' });
  expect(c.legacy).toBeUndefined();
  // already equal: no UPDATE, still the DELETE
  const c2 = conn({ tree: { contact: null, case: Object.fromEntries(Object.entries(STAGES).reverse()) }, legacy: STAGES });
  expect(await mig.run(c2, { apply: true, ...quiet })).toMatchObject({ ok: true, copied: false, deleted: true });
  expect(verbs(c2)).toEqual(['SELECT', 'SET', 'SELECT', 'DELETE', 'SELECT']);
});

test('a later run is ALREADY APPLIED; the NO-GOs never touch a row', async () => {
  expect((await mig.run(conn({ tree: { case: STAGES, contact: null } }), { apply: true, ...quiet })).line).toMatch(/^ALREADY APPLIED — GO\. dropbox_case_folder_templates is gone and storage_folders\.case holds the templates \(potential, active\)/);
  const cases = [
    [conn({ legacy: STAGES }), /^NO-GO — storage_folders is absent \(run scripts\/storageSeamD3cStorageFolders\.js first\)/],
    [conn({ tree: '[1]', legacy: STAGES }), /^NO-GO — storage_folders is not a JSON object/],
    [conn({ tree: { case: STAGES, contact: { default: '/C' } }, legacy: STAGES }), /^NO-GO — storage_folders\.contact is not null/],
    [conn({ tree: { case: STAGES }, legacy: STAGES }), /^NO-GO — storage_folders\.contact is absent/],
    [conn({ tree: { case: STAGES, contact: null }, legacy: '{"potential": "x"}' }), /^NO-GO — dropbox_case_folder_templates is present but not a stage map/],
    [conn({ tree: { contact: null } }), /^NO-GO — dropbox_case_folder_templates is gone but storage_folders\.case is not a stage map/],
  ];
  for (const [c, re] of cases) {
    const r = await mig.run(c, { apply: true, ...quiet });
    expect(r.ok).toBe(false);
    expect(r.line).toMatch(re);
    expect(verbs(c)).toEqual(['SELECT']);
  }
  // a read-back mismatch after the UPDATE keeps the legacy row (no DELETE)
  const bad = conn({ tree: { case: { potential: { default: '/  OLD', subfolders: [] } }, contact: null }, legacy: STAGES, readBackTree: { case: { potential: STAGES.potential }, contact: null } });
  expect(await mig.run(bad, { apply: true, ...quiet })).toMatchObject({ ok: false, copied: true, deleted: false, line: expect.stringMatching(/^NO-GO — after the copy/) });
  expect(verbs(bad)).toEqual(['SELECT', 'SET', 'UPDATE', 'SELECT']);
  expect(bad.legacy).toBeDefined();
});

test('helpers: canon ignores key order only; isStageMap wants a non-empty map of { default: string }', () => {
  expect(mig.canon({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(mig.canon({ a: [1, { c: 3, d: 2 }], b: 1 }));
  expect(mig.isStageMap(STAGES)).toBe(true);
  expect(mig.isStageMap({})).toBe(false);
  expect(mig.isStageMap({ a: { subfolders: [] } })).toBe(false);
  expect(mig.isStageMap(null)).toBe(false);
  expect(require('fs').readFileSync(mig.RECORD, 'utf8')).toMatch(/DELETE FROM app_settings WHERE `key` = 'dropbox_case_folder_templates'/);
});
