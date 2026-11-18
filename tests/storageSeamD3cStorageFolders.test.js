// tests/storageSeamD3cStorageFolders.test.js
//
/**
 * storage-seam D3c-1 — the v3 folder-tree setting and {{case_type_full}}.
 *   - scripts/storageSeamD3cStorageFolders.js over a scripted connection: CHECK
 *     (GO), --apply (INSERT + read-back verify), ALREADY APPLIED, the NO-GOs (a
 *     hand-edited tree; a missing or drifted templates row; a read-back
 *     mismatch), lock_wait before the write, key-order-insensitive compares.
 *   - caseService.caseTypeFull: "Type: Subtype" / "Type" / "unknown".
 *   - caseService._loadCaseFolderTemplates: storage_folders.case first, the
 *     legacy key second, {} last; a tree without a case block falls through.
 */

'use strict';

const fs = require('fs');
const mig = require('../scripts/storageSeamD3cStorageFolders');
const caseService = require('../services/caseService');

const FROZEN = JSON.parse(fs.readFileSync(mig.BEFORE, 'utf8'));
const quiet = { log: () => {} };

function conn({ templates = FROZEN, tree, readBackTree, readBackTemplates } = {}) {
  const calls = [];
  let inserted = null;
  return {
    calls,
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      calls.push([s, params]);
      if (/^SET SESSION lock_wait_timeout = 5$/.test(s)) return [{}];
      if (/^SELECT `key`, `value` FROM app_settings WHERE `key` IN \(\?, \?\)$/.test(s)) {
        const rows = [];
        const tpl = inserted && readBackTemplates !== undefined ? readBackTemplates : templates;
        if (tpl !== undefined && tpl !== null) rows.push({ key: 'dropbox_case_folder_templates', value: typeof tpl === 'string' ? tpl : JSON.stringify(tpl) });
        const t = inserted ? (readBackTree !== undefined ? readBackTree : JSON.parse(inserted)) : tree;
        if (t !== undefined && t !== null) rows.push({ key: 'storage_folders', value: typeof t === 'string' ? t : JSON.stringify(t) });
        return [rows];
      }
      if (/^INSERT INTO app_settings \(`key`, `value`\) VALUES \(\?, \?\)$/.test(s)) { inserted = params[1]; return [{ affectedRows: 1 }]; }
      throw new Error('unexpected SQL: ' + s.slice(0, 80));
    },
    get inserted() { return inserted; },
  };
}

describe('the seed script', () => {
  test('CHECK on the base: GO, nothing written', async () => {
    const c = conn();
    const r = await mig.run(c, quiet);
    expect(r).toEqual({ ok: true, applied: false, line: expect.stringMatching(/^CHECK OK — GO\. storage_folders will be seeded as \{ case: <the live dropbox_case_folder_templates row, 2 stage\(s\)>, contact: null \}/) });
    expect(c.calls.some(([s]) => /^INSERT|^SET SESSION/.test(s))).toBe(false);
  });
  test('--apply: lock_wait, then ONE INSERT of { case: <the live row>, contact: null }, then the read-back verify → GO', async () => {
    const c = conn();
    const r = await mig.run(c, { apply: true, ...quiet });
    expect(r).toEqual({ ok: true, applied: true, line: expect.stringMatching(/^APPLIED — GO\. storage_folders seeded and verified/) });
    const order = c.calls.map(([s]) => s.split(' ')[0]);
    expect(order).toEqual(['SELECT', 'SET', 'INSERT', 'SELECT']);
    const [, params] = c.calls.find(([s]) => /^INSERT/.test(s));
    expect(params[0]).toBe('storage_folders');
    expect(JSON.parse(params[1])).toEqual({ case: FROZEN, contact: null });
    // the frozen copy IS 4LSG's live row shape: two stages, the four per-chapter active templates, the leading-space subfolders
    expect(Object.keys(FROZEN).sort()).toEqual(['active', 'potential']);
    expect(Object.keys(FROZEN.active).sort()).toEqual(['Bankruptcy:Chapter 11', 'Bankruptcy:Chapter 12', 'Bankruptcy:Chapter 13', 'Bankruptcy:Chapter 7', 'default', 'subfolders']);
    expect(FROZEN.active.subfolders[0]).toMatch(/^ Docket - /);
  });
  test('a second run is ALREADY APPLIED — key order ignored (MySQL JSON re-orders keys)', async () => {
    const reordered = { contact: null, case: { potential: FROZEN.potential, active: Object.fromEntries(Object.entries(FROZEN.active).reverse()) } };
    const c = conn({ tree: reordered });
    const r = await mig.run(c, quiet);
    expect(r.line).toMatch(/^ALREADY APPLIED — GO/);
    expect(await mig.run(c, { apply: true, ...quiet })).toMatchObject({ ok: true, applied: false });
    expect(c.calls.some(([s]) => /^INSERT/.test(s))).toBe(false);
  });
  test('NO-GOs: a hand-edited tree is never overwritten; a missing templates row; a drifted templates row; a read-back mismatch', async () => {
    const edited = await mig.run(conn({ tree: { case: { active: { default: '/  Else', subfolders: [] } }, contact: null } }), { apply: true, ...quiet });
    expect(edited).toMatchObject({ ok: false, applied: false, line: expect.stringMatching(/^NO-GO — storage_folders exists but is not/) });
    const contactSet = await mig.run(conn({ tree: { case: FROZEN, contact: { default: '/Clients/{{lfm_name}}', subfolders: [] } } }), quiet);
    expect(contactSet.line).toMatch(/^NO-GO — storage_folders exists but is not/);
    expect((await mig.run(conn({ templates: null }), quiet)).line).toMatch(/^NO-GO — dropbox_case_folder_templates is missing/);
    expect((await mig.run(conn({ templates: '{nope' }), quiet)).line).toMatch(/^NO-GO — dropbox_case_folder_templates is missing or not a JSON object/);
    const drifted = { ...FROZEN, active: { ...FROZEN.active, default: FROZEN.active.default + ' x' } };
    const d = conn({ templates: drifted });
    expect((await mig.run(d, { apply: true, ...quiet })).line).toMatch(/^NO-GO — the live dropbox_case_folder_templates row is not the frozen copy/);
    expect(d.calls.some(([s]) => /^INSERT/.test(s))).toBe(false);
    const bad = await mig.run(conn({ readBackTree: { case: { active: FROZEN.active }, contact: null } }), { apply: true, ...quiet });
    expect(bad).toMatchObject({ ok: false, applied: true, line: expect.stringMatching(/^NO-GO — after the INSERT the read-back/) });
  });
  test('canon: key order ignored, values and array order kept', () => {
    expect(mig.canon({ b: [1, { d: 1, c: 2 }], a: 'x' })).toBe(mig.canon({ a: 'x', b: [1, { c: 2, d: 1 }] }));
    expect(mig.canon({ a: [1, 2] })).not.toBe(mig.canon({ a: [2, 1] }));
    expect(mig.canon({ a: ' x' })).not.toBe(mig.canon({ a: 'x' }));
    expect(mig.payloadFor({ s: 1 })).toEqual({ case: { s: 1 }, contact: null });
    expect(JSON.parse(fs.readFileSync(mig.RECORD, 'utf8')).key).toBe('storage_folders');
  });
});

describe('caseTypeFull', () => {
  test.each([
    ['Bankruptcy', 'Ch 12', 'Bankruptcy: Ch 12'],
    ['Bankruptcy', '', 'Bankruptcy'],
    ['Bankruptcy', null, 'Bankruptcy'],
    [' Litigation ', '  ', 'Litigation'],
    ['', 'Ch 7', 'unknown'],
    [null, null, 'unknown'],
    [undefined, 'x', 'unknown'],
  ])('(%j, %j) → %j', (t, s, out) => { expect(caseService.caseTypeFull(t, s)).toBe(out); });
});

describe('_loadCaseFolderTemplates', () => {
  const dbWith = (rows) => ({ query: jest.fn(async (sql) => { const m = sql.match(/`key` = '([a-z_]+)'/); const v = rows[m[1]]; return [v == null ? [] : [{ value: v }], []]; }) });
  const stages = { active: { default: '/  A/ {{case_id}}', subfolders: [] } };
  test('D3c-3: storage_folders.case is the one source — a leftover dropbox_case_folder_templates row is never read', async () => {
    const legacy = { active: { default: '/  STALE', subfolders: [] } };
    const db = dbWith({ storage_folders: JSON.stringify({ case: stages, contact: null }), dropbox_case_folder_templates: JSON.stringify(legacy) });
    expect(await caseService._loadCaseFolderTemplates(db)).toEqual(stages);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0][0]).toMatch(/`key` = 'storage_folders'/);
  });
  test('storage_folders.case; a tree without a case block (or not an object, or an array, or bad JSON) → {}', async () => {
    expect(await caseService._loadCaseFolderTemplates(dbWith({ storage_folders: JSON.stringify({ case: stages, contact: null }) }))).toEqual(stages);
    expect(await caseService._loadCaseFolderTemplates(dbWith({ storage_folders: JSON.stringify({ contact: { default: '/C', subfolders: [] } }) }))).toEqual({});
    expect(await caseService._loadCaseFolderTemplates(dbWith({ storage_folders: JSON.stringify({ case: ['x'] }) }))).toEqual({});
    expect(await caseService._loadCaseFolderTemplates(dbWith({ storage_folders: '{nope' }))).toEqual({});
    expect(await caseService._loadCaseFolderTemplates(dbWith({}))).toEqual({});
  });
});
