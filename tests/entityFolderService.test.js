// tests/entityFolderService.test.js
//
/**
 * services/entityFolderService.js — the binding row's write semantics (storage-seam
 * D3a), over a scripted db: a resolved write sets handle + paths and clears the
 * error but never erases a known handle with NULL; an error write keeps prior
 * paths; the heal moves paths only; relink dismissal by ids; remove; get. And the
 * posture (D3d-2): every write throws — the binding is the record; strict: false
 * is the explicit best-effort opt-out. caseFolderLink reads the binding alone.
 */

'use strict';

const svc = require('../services/entityFolderService');

function dbStub(result = [{ affectedRows: 1 }]) {
  const calls = [];
  return { calls, query: jest.fn(async (sql, params) => { calls.push([sql.replace(/\s+/g, ' ').trim(), params]); return result; }) };
}
const DB = () => dbStub();

test('setResolved: INSERT … ON DUPLICATE KEY UPDATE with COALESCE on handle / paths / link, error cleared', async () => {
  const db = DB();
  await svc.setResolved(db, { kind: 'case', id: 'hjSFMabb', externalId: 'id:F1', pathLower: '/  a/ b', pathDisplay: '/  A/ B', humanLink: 'https://www.dropbox.com/scl/fo/x?dl=0' });
  const [sql, params] = db.calls[0];
  expect(sql).toMatch(/^INSERT INTO entity_folders \(entity_kind, entity_id, source, external_id, path_lower, path_display, human_link, resolve_error, resolved_at\) VALUES \(\?, \?, \?, \?, \?, \?, \?, NULL, NOW\(\)\) AS new ON DUPLICATE KEY UPDATE/);
  expect(sql).toMatch(/external_id = COALESCE\(new\.external_id, entity_folders\.external_id\)/);
  expect(sql).toMatch(/human_link = COALESCE\(new\.human_link, entity_folders\.human_link\)/);
  expect(sql).toMatch(/resolve_error = NULL, resolved_at = NOW\(\)/);
  expect(params).toEqual(['case', 'hjSFMabb', 'dropbox', 'id:F1', '/  a/ b', '/  A/ B', 'https://www.dropbox.com/scl/fo/x?dl=0']);
  await svc.setResolved(db, { kind: 'contact', id: 501, source: 'gcs', pathLower: '/x', pathDisplay: '/X' });
  expect(db.calls[1][1]).toEqual(['contact', '501', 'gcs', null, '/x', '/X', null]);   // id as a string; unknown handle/link → NULL → COALESCE keeps the old
});

test('setError keeps prior handle and paths: only the error, the timestamp and (when given) the link move', async () => {
  const db = DB();
  await svc.setError(db, { kind: 'case', id: 'deadLnk1', humanLink: 'https://x/l', error: 'x'.repeat(300) });
  const [sql, params] = db.calls[0];
  expect(sql).toMatch(/^INSERT INTO entity_folders \(entity_kind, entity_id, source, human_link, resolve_error, resolved_at\)/);
  expect(sql).not.toMatch(/path_lower|external_id/);
  expect(params[4]).toHaveLength(255);                              // clamped to the column
  expect(params.slice(0, 4)).toEqual(['case', 'deadLnk1', 'dropbox', 'https://x/l']);
});

test('setPaths (the folder heal) moves the paths by key and clears the error; setRelinkDismissed by ids; remove by key', async () => {
  const db = DB();
  await svc.setPaths(db, { kind: 'case', id: 'hjSFMabb', pathLower: '/  new', pathDisplay: '/  New' });
  expect(db.calls[0][0]).toMatch(/^UPDATE entity_folders SET path_lower = \?, path_display = \?, resolve_error = NULL, resolved_at = NOW\(\) WHERE entity_kind = \? AND entity_id = \? AND source = \?$/);
  expect(db.calls[0][1]).toEqual(['/  new', '/  New', 'case', 'hjSFMabb', 'dropbox']);
  await svc.setRelinkDismissed(db, { kind: 'case', ids: ['a', 'b', 'a'], dismissed: true, by: 6 });
  expect(db.calls[1][0]).toMatch(/SET relink_dismissed_at = NOW\(\), relink_dismissed_by = \? WHERE entity_kind = \? AND source = \? AND entity_id IN \(\?\)/);
  expect(db.calls[1][1]).toEqual([6, 'case', 'dropbox', ['a', 'b']]);
  await svc.setRelinkDismissed(db, { kind: 'case', ids: ['a'], dismissed: false, by: 6 });
  expect(db.calls[2][0]).toMatch(/relink_dismissed_at = NULL, relink_dismissed_by = \?/); expect(db.calls[2][1][0]).toBeNull();
  expect(await svc.setRelinkDismissed(db, { kind: 'case', ids: [], dismissed: true })).toEqual({ affectedRows: 0 });
  await svc.remove(db, { kind: 'case', id: 'loser1' });
  expect(db.calls[3]).toEqual(['DELETE FROM entity_folders WHERE entity_kind = ? AND entity_id = ? AND source = ?', ['case', 'loser1', 'dropbox']]);
});

test('setHumanLink: a changed link keeps ONLY the link — every other column goes NULL through <=> IFs, human_link assigned LAST; a blank link is a DELETE', async () => {
  const db = DB();
  await svc.setHumanLink(db, { kind: 'case', id: 'c1', humanLink: '  https://x/y  ' });
  const [sql, params] = db.calls[0];
  expect(sql).toMatch(/^INSERT INTO entity_folders \(entity_kind, entity_id, source, human_link\) VALUES \(\?, \?, \?, \?\) AS new ON DUPLICATE KEY UPDATE/);
  for (const col of ['external_id', 'path_lower', 'path_display', 'resolve_error', 'resolved_at']) {
    expect(sql).toContain(`${col} = IF(entity_folders.human_link <=> new.human_link, entity_folders.${col}, NULL)`);
  }
  expect(sql).toMatch(/human_link = new\.human_link$/);   // last: MySQL evaluates the assignments left to right
  expect(params).toEqual(['case', 'c1', 'dropbox', 'https://x/y']);
  const db2 = DB();
  await svc.setHumanLink(db2, { kind: 'case', id: 'c1', humanLink: '   ' });
  expect(db2.calls[0][0]).toMatch(/^DELETE FROM entity_folders WHERE/);
  const db3 = DB();
  await svc.setHumanLink(db3, { kind: 'case', id: 'c1', humanLink: null });
  expect(db3.calls[0][0]).toMatch(/^DELETE FROM entity_folders WHERE/);
});

test('caseFolderLink: the binding is the ONLY record of the link (D3d-2); `found` still means the case exists — a PK read of cases only when there is no binding row, never the column', async () => {
  const scripted = (bindingRow, caseExists = true) => {
    const calls = [];
    return { calls, query: jest.fn(async (sql) => { calls.push(sql.replace(/\s+/g, ' ').trim()); return /FROM entity_folders/.test(sql) ? [bindingRow ? [bindingRow] : []] : [caseExists ? [{ case_id: 'c1' }] : []]; }) };
  };
  let db = scripted({ external_id: 'id:1', path_lower: '/a', human_link: ' https://b ' });
  expect(await svc.caseFolderLink(db, 'c1')).toEqual({ found: true, link: 'https://b', via: 'binding', externalId: 'id:1', pathLower: '/a' });
  expect(db.calls).toEqual(['SELECT external_id, path_lower, human_link FROM entity_folders WHERE entity_kind = ? AND entity_id = ? AND source = ? LIMIT 1']);
  // a binding row without a link (setError on a never-resolved case): found, no link, what it knows kept
  db = scripted({ external_id: 'id:2', path_lower: '/p', human_link: null });
  expect(await svc.caseFolderLink(db, 'c1')).toEqual({ found: true, link: null, via: null, externalId: 'id:2', pathLower: '/p' });
  db = scripted({ external_id: null, path_lower: null, human_link: '   ' });
  expect(await svc.caseFolderLink(db, 'c1')).toEqual({ found: true, link: null, via: null, externalId: null, pathLower: null });
  // no binding row: the case exists → unbound (the auto-create rung); the case does not exist → not found (the bin)
  db = scripted(null, true);
  expect(await svc.caseFolderLink(db, 'c1')).toEqual({ found: true, link: null, via: null, externalId: null, pathLower: null });
  expect(db.calls).toEqual([
    'SELECT external_id, path_lower, human_link FROM entity_folders WHERE entity_kind = ? AND entity_id = ? AND source = ? LIMIT 1',
    'SELECT case_id FROM cases WHERE case_id = ? LIMIT 1',   // the PK, never the retired column
  ]);
  db = scripted(null, false);
  expect(await svc.caseFolderLink(db, 'c1')).toEqual({ found: false, link: null, via: null, externalId: null, pathLower: null });
  await expect(svc.caseFolderLink(db, '')).rejects.toThrow(/id is required/);
});

test('writes THROW by default (D3d-2: the binding is the record); strict: false restores the logged best-effort posture', async () => {
  const boom = { query: jest.fn(async () => { throw new Error('binding table is on fire'); }) };
  await expect(svc.setHumanLink(boom, { kind: 'case', id: 'c1', humanLink: 'https://x' })).rejects.toThrow('binding table is on fire');
  await expect(svc.setResolved(boom, { kind: 'case', id: 'c1', externalId: 'id:1', pathLower: '/a', pathDisplay: '/A', humanLink: 'https://x' })).rejects.toThrow('on fire');
  await expect(svc.setError(boom, { kind: 'case', id: 'c1', humanLink: 'https://x', error: 'e' })).rejects.toThrow('on fire');
  await expect(svc.setPaths(boom, { kind: 'case', id: 'c1', pathLower: '/a', pathDisplay: '/A' })).rejects.toThrow('on fire');
  await expect(svc.setRelinkDismissed(boom, { kind: 'case', ids: ['c1'], dismissed: true, by: 6 })).rejects.toThrow('on fire');
  await expect(svc.remove(boom, { kind: 'case', id: 'c1' })).rejects.toThrow('on fire');
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    expect(await svc.setHumanLink(boom, { kind: 'case', id: 'c1', humanLink: 'https://x' }, { strict: false })).toBeNull();
    expect(warn.mock.calls.some((c) => /\[ENTITY FOLDERS\] setHumanLink case c1 failed/.test(String(c[0])))).toBe(true);
  } finally { warn.mockRestore(); }
});

test('casePathLower: the bound path or null; resolvedOnly drops a row carrying a resolve_error', async () => {
  const one = (row) => dbStub([row ? [row] : []]);
  expect(await svc.casePathLower(one({ path_lower: '/a/b', resolve_error: null }), 'c1')).toBe('/a/b');
  expect(await svc.casePathLower(one({ path_lower: '/a/b', resolve_error: 'gone' }), 'c1')).toBe('/a/b');
  expect(await svc.casePathLower(one({ path_lower: '/a/b', resolve_error: 'gone' }), 'c1', { resolvedOnly: true })).toBeNull();
  expect(await svc.casePathLower(one({ path_lower: null, resolve_error: null }), 'c1')).toBeNull();
  expect(await svc.casePathLower(one(null), 'c1')).toBeNull();
  const db = one({ path_lower: '/a', resolve_error: null });
  await svc.casePathLower(db, 'c9', { source: 'gcs' });
  expect(db.calls[0]).toEqual(['SELECT path_lower, resolve_error FROM entity_folders WHERE entity_kind = ? AND entity_id = ? AND source = ? LIMIT 1', ['case', 'c9', 'gcs']]);
});

test('get returns the row or null; bad keys are refused before any SQL', async () => {
  const db = dbStub([[{ entity_id: 'x', external_id: 'id:1' }]]);
  expect(await svc.get(db, { kind: 'case', id: 'x' })).toEqual({ entity_id: 'x', external_id: 'id:1' });
  expect(await svc.get(dbStub([[]]), { kind: 'case', id: 'x' })).toBeNull();
  await expect(svc.setResolved(db, { kind: 'matter', id: 'x' })).rejects.toThrow('kind must be case | contact');
  await expect(svc.remove(db, { kind: 'case', id: '' })).rejects.toThrow('id is required');
  expect(db.calls).toHaveLength(1);
});

test('strict: false — a failing write is logged and swallowed (the explicit best-effort opt-out); the default throws', async () => {
  const failing = { query: jest.fn(async () => { throw new Error("Table 'entity_folders' doesn't exist"); }) };
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    expect(await svc.setResolved(failing, { kind: 'case', id: 'x', humanLink: 'l' }, { strict: false })).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/\[ENTITY FOLDERS\] setResolved case x failed .*doesn't exist/));
    await expect(svc.setResolved(failing, { kind: 'case', id: 'x' })).rejects.toThrow("doesn't exist");
  } finally { warn.mockRestore(); }
});
