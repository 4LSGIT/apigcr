// tests/entityFolderService.test.js
//
/**
 * services/entityFolderService.js — the binding row's write semantics (storage-seam
 * D3a), over a scripted db: a resolved write sets handle + paths and clears the
 * error but never erases a known handle with NULL; an error write keeps prior
 * paths; the heal moves paths only; relink dismissal by ids; remove; get. And the
 * posture: best-effort behind the primary write unless strict.
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

test('get returns the row or null; bad keys are refused before any SQL', async () => {
  const db = dbStub([[{ entity_id: 'x', external_id: 'id:1' }]]);
  expect(await svc.get(db, { kind: 'case', id: 'x' })).toEqual({ entity_id: 'x', external_id: 'id:1' });
  expect(await svc.get(dbStub([[]]), { kind: 'case', id: 'x' })).toBeNull();
  await expect(svc.setResolved(db, { kind: 'matter', id: 'x' })).rejects.toThrow('kind must be case | contact');
  await expect(svc.remove(db, { kind: 'case', id: '' })).rejects.toThrow('id is required');
  expect(db.calls).toHaveLength(1);
});

test('best-effort by default — a failing write is logged and swallowed so the primary write stands; strict throws', async () => {
  const failing = { query: jest.fn(async () => { throw new Error("Table 'entity_folders' doesn't exist"); }) };
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    expect(await svc.setResolved(failing, { kind: 'case', id: 'x', humanLink: 'l' })).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/\[ENTITY FOLDERS\] setResolved case x failed .*doesn't exist/));
    await expect(svc.setResolved(failing, { kind: 'case', id: 'x' }, { strict: true })).rejects.toThrow("doesn't exist");
  } finally { warn.mockRestore(); }
});
