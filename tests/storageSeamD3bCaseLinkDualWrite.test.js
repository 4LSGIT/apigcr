// tests/storageSeamD3bCaseLinkDualWrite.test.js
//
/**
 * storage-seam D3b-1: the two house write paths for cases.case_dropbox carry a
 * hand-written folder link into the binding (entityFolderService.setHumanLink),
 * because the filing paths now read entity_folders FIRST — a link that lived
 * only in the column would be invisible to them until the sweep's lap.
 *   - updateCase with case_dropbox among the fields → setHumanLink after the
 *     row UPDATE (a blank link → the row removed); without it → no binding SQL.
 *   - createCase with a non-blank case_dropbox → setHumanLink after the INSERT;
 *     a blank or absent one → nothing.
 * The binding write is best-effort: a failing one is logged, the case write stands.
 * Scripted db (the caseJudgeFill pattern); domainEvents mocked.
 */

'use strict';

process.env.CREDENTIALS_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('base64');

jest.mock('../lib/domainEvents', () => ({
  ...jest.requireActual('../lib/domainEvents'),
  emit: jest.fn(() => Promise.resolve()),
}));

const caseService = require('../services/caseService');

const PRIOR = { case_id: 'C1', case_type: '', case_number: '', case_number_full: '', case_judge: '', case_trustee: '', case_chapter: '', case_caption: '', case_dropbox: null, case_notes: '' };

function caseDb(priorRow, { bindingFails = false } = {}) {
  const writes = [];
  return {
    writes,
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/^SELECT \* FROM cases WHERE case_id/.test(s)) return [[{ ...priorRow }]];
      if (/FROM information_schema\.COLUMNS/.test(s)) return [Object.keys(PRIOR).map(c => ({ COLUMN_NAME: c }))];
      if (/^UPDATE cases SET/.test(s) || /^INSERT INTO cases/.test(s)) { writes.push({ s, params }); return [{ affectedRows: 1 }]; }
      if (/entity_folders/.test(s)) { if (bindingFails) throw new Error('binding table is on fire'); writes.push({ s, params }); return [{ affectedRows: 1 }]; }
      return [[]];
    },
  };
}
const bindingWrites = db => db.writes.filter(w => /entity_folders/.test(w.s));

describe('updateCase', () => {
  test('case_dropbox in the write → the row UPDATE, then setHumanLink with the same link', async () => {
    const db = caseDb(PRIOR);
    await caseService.updateCase(db, 'C1', { case_dropbox: 'https://www.dropbox.com/scl/fo/byhand01?dl=0', case_notes: 'x' }, { userId: 6, source: 'manual' });
    expect(db.writes.map(w => w.s)).toEqual([expect.stringMatching(/^UPDATE cases SET `case_dropbox` = \?, `case_notes` = \? WHERE case_id = \?$/), expect.stringMatching(/^INSERT INTO entity_folders \(entity_kind, entity_id, source, human_link\)/)]);
    expect(bindingWrites(db)[0].params).toEqual(['case', 'C1', 'dropbox', 'https://www.dropbox.com/scl/fo/byhand01?dl=0']);
  });
  test('a blank link removes the binding; the column key is matched case-insensitively (MySQL would)', async () => {
    const db = caseDb({ ...PRIOR, case_dropbox: 'https://old' });
    await caseService.updateCase(db, 'C1', { CASE_DROPBOX: '' }, { userId: 6 });
    expect(bindingWrites(db)).toHaveLength(1);
    expect(bindingWrites(db)[0].s).toMatch(/^DELETE FROM entity_folders WHERE entity_kind = \? AND entity_id = \? AND source = \?/);
    expect(bindingWrites(db)[0].params).toEqual(['case', 'C1', 'dropbox']);
  });
  test('a write that does not touch case_dropbox writes no binding SQL', async () => {
    const db = caseDb(PRIOR);
    await caseService.updateCase(db, 'C1', { case_notes: 'hello' }, { userId: 6 });
    expect(bindingWrites(db)).toEqual([]);
  });
  test('best-effort: a failing binding write is logged and the case write stands', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = caseDb(PRIOR, { bindingFails: true });
      const r = await caseService.updateCase(db, 'C1', { case_dropbox: 'https://x' }, { userId: 6 });
      expect(r.updated_fields).toEqual(['case_dropbox']);
      expect(warn.mock.calls.some(c => /\[ENTITY FOLDERS\] setHumanLink case C1 failed/.test(String(c[0])))).toBe(true);
    } finally { warn.mockRestore(); }
  });
});

describe('createCase', () => {
  test('a folder link at create time binds the new case after the INSERT; blank or absent binds nothing', async () => {
    const db = caseDb(null);
    const made = await caseService.createCase(db, { case_type: 'Bankruptcy', case_dropbox: 'https://www.dropbox.com/scl/fo/atcreate?dl=0' });
    expect(db.writes.map(w => w.s)).toEqual([expect.stringMatching(/^INSERT INTO cases \(`case_id`, /), expect.stringMatching(/^INSERT INTO entity_folders \(entity_kind, entity_id, source, human_link\)/)]);
    expect(bindingWrites(db)[0].params).toEqual(['case', made.case_id, 'dropbox', 'https://www.dropbox.com/scl/fo/atcreate?dl=0']);
    const db2 = caseDb(null);
    await caseService.createCase(db2, { case_type: 'Bankruptcy', case_dropbox: '   ' });
    await caseService.createCase(db2, { case_type: 'Bankruptcy' });
    expect(bindingWrites(db2)).toEqual([]);
  });
});
