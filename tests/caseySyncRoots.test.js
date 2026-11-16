'use strict';
/**
 * tests/caseySyncRoots.test.js
 *
 * A11X — Casey adds ONE Dropbox folder as a documents sync root, or switches ONE
 * root on or off, through reviewed cards on the Sync panel's own routes (Fred,
 * 2026-11-15 / 16: "release means allow"), behind their OWN switch
 * (casey_document_sync_roots_enabled — engine configuration over thousands of
 * rows, apart from the per-document cards):
 *   document.sync_root.add.v1    {path, note?}      → POST  /api/documents/sync-roots
 *   document.sync_root.enable.v1 {root_id, enabled} → PATCH /api/documents/sync-roots/:id
 * plus the typed document.sync_roots read (the panel's own list and the kill switch).
 *
 * The contract pinned here:
 *   1. the switch; the by-name refusals (bulk, delete, a repoint on the enable
 *      card — the route's own reasons) and unknown keys, before anything is read;
 *   2. the add: `path` must be the folder row of a document.folder read of
 *      that EXACT path (a re-cased path is told to copy exactly); addRoot's own
 *      guards in its words — _validateRootPath (no leading slash, the account
 *      root, too long), the case-insensitive duplicate (with the disabled
 *      hint), the nesting conflict either way, a path that is a file (the
 *      route's 400); a folder that does not exist is DISCLOSED (the route's
 *      201 + warning), never refused; the BACKFILL danger line from the read's
 *      own counts ("500 or more"), the kill switch, NO delete, the existing
 *      roots by name; expected.roots_hash = SHA-256 of the sorted
 *      id:enabled:path_lower signature; nothing written;
 *   3. the enable / disable: the root row cited from a document.sync_roots
 *      read; a gone root; a state already equal; the nesting re-check on
 *      enable (setRootEnabled's words); what a disable does and does not do
 *      (the rotation, the cursor, nothing unregistered, the manual tick);
 *      RESUMES vs FIRST WALK PENDING on enable; the kill switch; expected;
 *   4. the read's rows (the engine head row, one per root with its state);
 *      the ledger receipts (root_id) and the request detector;
 *   5. the browser half (lifted from public/assistant.html by name): the
 *      POST / PATCH bodies, the precheck hashing the live list with the page's
 *      formDataHash (equal to the server's hash; any change refuses), the
 *      result checks, the known outcomes (the route's 409s), danger, the
 *      applied copy carrying the route's warning, text.
 *
 * The routes' own behaviour (the REAL add / enable, the nesting 409s, the
 * case-insensitive dupe, the hash refusing after a change) runs on a real
 * engine in tests/caseySyncRoots.mysql.test.js.
 *
 *   npx jest tests/caseySyncRoots.test.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.join(__dirname, '..');
const svc = require(path.join(REPO, 'services', 'assistantService'));
const ledger = require(path.join(REPO, 'services', 'assistantActionLedger'));
const dropbox = require(path.join(REPO, 'services', 'dropboxService'));
const ops = require(path.join(REPO, 'public', 'js', 'formTemplateOps'));
const { normalizeActionDraft, taskDraftRequested, documentSyncRootsRead } = svc;

const ME = 6;
const CREATED = new Date('2026-08-01T10:00:00Z');
const ROOTS = () => [
  { id: 1, path: '/  Law Office/   Cases/  Active Cases', note: 'active', enabled: 1, backfill_done: 1, syncing_since: null, last_sync_at: new Date('2026-11-16T09:00:00Z'), last_error: null, stats: '{"files":12}', created_at: CREATED, has_cursor: 1 },
  { id: 2, path: '/  Law Office/   Cases/  Closed', note: null, enabled: 1, backfill_done: 0, syncing_since: new Date('2026-11-16T09:30:00Z'), last_sync_at: null, last_error: null, stats: null, created_at: CREATED, has_cursor: 1 },
  { id: 3, path: '/  Law Office/   Cases/  Potential', note: 'off', enabled: 0, backfill_done: 1, syncing_since: null, last_sync_at: new Date('2026-10-01T09:00:00Z'), last_error: 'rate limited', stats: null, created_at: CREATED, has_cursor: 1 },
  { id: 4, path: '/  Law Office/   Cases/  Unsorted Generated Documents', note: null, enabled: 1, backfill_done: 0, syncing_since: null, last_sync_at: null, last_error: null, stats: null, created_at: CREATED, has_cursor: 0 },
];
const hashOf = (roots) => crypto.createHash('sha256').update(ops.canonical(roots.map((r) => `${r.id}:${Number(r.enabled) ? 1 : 0}:${r.path.toLowerCase()}`).sort())).digest('hex');

let spies = []; let calls;
function makeDb(over = {}) {
  const roots = over.roots || ROOTS();
  calls = { queries: [], dropbox: [] };
  const query = jest.fn(async (sql, params = []) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    calls.queries.push([flat, params]);
    if (flat.startsWith('SELECT id, path, note, enabled, backfill_done, syncing_since, last_sync_at, last_error, stats, created_at, (sync_cursor IS NOT NULL) AS has_cursor FROM document_sync_roots ORDER BY id ASC')) return [roots.map((r) => ({ ...r }))];
    if (flat === 'SELECT `value` FROM app_settings WHERE `key` = ? LIMIT 1') { expect(params[0]).toBe('documents_sync_enabled'); return [[{ value: over.syncOff ? '0' : '1' }]]; }
    throw new Error(`unexpected query: ${flat}`);
  });
  const meta = over.meta || {};
  spies = [
    jest.spyOn(dropbox, 'getMetadata').mockImplementation(async (_db, o) => { calls.dropbox.push(['getMetadata', o]); const m = meta[o.path]; if (!m) throw Object.assign(new Error('dropbox: POST /2/files/get_metadata → 409: path/not_found/..'), { status: 409, errorSummary: 'path/not_found/..' }); return m; }),
  ];
  return { query };
}
afterEach(() => { spies.forEach((s) => s.mockRestore()); spies = []; delete process.env.CASEY_DOCUMENT_SYNC_ROOTS_ENABLED; });

const NEW = '/  Law Office/   Cases/  Closed 2019';
const folderRow = (over = {}) => ({ row_type: 'folder', path: NEW, path_lower: NEW.toLowerCase(), path_display: NEW, exists: '1', is_folder: '1', under_enabled_root: '0', root: null,
  listed_files: '40', listed_folders: '3', listing_truncated: '0', registered_files: '2', proposable: '0', ...over });
const rootsRows = () => [{ row_type: 'engine', sync_enabled: '1', roots: '4' }, ...ROOTS().map((r) => ({ row_type: 'root', root_id: String(r.id), path: r.path, enabled: String(r.enabled) }))];
const EVIDENCE = [
  { id: 'q1', kind: 'document.folder', purpose: 'the folder', rows: [folderRow(), { row_type: 'entry', entry_id: 'id:X', name: 'a.pdf', is_folder: '0' }] },
  { id: 'q2', kind: 'document.sync_roots', purpose: 'the roots', rows: rootsRows() },
  { id: 'q3', rows: [{ case_id: 'ABC', path: NEW }] },
];
const add = (over = {}) => ({ kind: 'document.sync_root.add.v1', path: NEW, evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 1 }], ...over });
const enable = (over = {}) => ({ kind: 'document.sync_root.enable.v1', root_id: 3, enabled: true, evidence: [{ query_id: 'q2', row_number: 4 }], ...over });
const META = { [NEW]: { '.tag': 'folder', id: 'id:NEWROOT', path_lower: NEW.toLowerCase(), path_display: NEW } };

const run = (value, dbOver, evidence = EVIDENCE) => normalizeActionDraft(makeDb({ meta: META, ...dbOver }), value, evidence, { currentUserId: ME });
const refuse = (value, re, dbOver, evidence) => expect(run(value, dbOver, evidence)).rejects.toThrow(re);
const writes = () => calls.queries.filter(([sql]) => /^(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql));

describe('the switch and the refusals before anything is read', () => {
  test("'0' makes both kinds unavailable; unset is ON; the documents switch does not govern them", async () => {
    process.env.CASEY_DOCUMENT_SYNC_ROOTS_ENABLED = '0';
    for (const v of [add(), enable()]) await expect(run(v)).rejects.toThrow(/^Action kind is unavailable$/);
    delete process.env.CASEY_DOCUMENT_SYNC_ROOTS_ENABLED;
    process.env.CASEY_DOCUMENTS_ENABLED = '0';
    try {
      await expect(run(add())).resolves.toMatchObject({ kind: 'document.sync_root.add.v1', status: 'draft' });
      await expect(run(enable())).resolves.toMatchObject({ kind: 'document.sync_root.enable.v1', status: 'draft' });
    } finally { delete process.env.CASEY_DOCUMENTS_ENABLED; }
  });
  test.each([
    ['bulk on an add', () => add({ paths: ['/a', '/b'] }), /^BULK refused \(paths\): a sync root card adds or switches ONE root — there is no bulk verb on sync roots$/],
    ['bulk on an enable', () => enable({ root_ids: [1, 2] }), /^BULK refused \(root_ids\): /],
    ['a delete key', () => enable({ delete: true }), /^DELETE refused \(delete\): a sync root cannot be deleted, by design — its rows carry no root id, so deleting one would strand every file it registered with nothing marking them stale\. Disable is the only undo \(document\.sync_root\.enable\.v1 with enabled false\)$/],
    ['a remove key on an add', () => add({ remove_root: 2 }), /^DELETE refused \(remove_root\): /],
    ['a repoint on an enable', () => enable({ path: '/x' }), /^REPOINT refused \(path\): only "enabled" can be changed on a sync root — the route refuses any other key\. A root's cursor belongs to its folder, so a path change is a different root: disable this one and add the correct path \(document\.sync_root\.add\.v1\)$/],
    ['new_path on an enable', () => enable({ new_path: '/x' }), /^REPOINT refused \(new_path\): /],
    ['an unknown key on an add', () => add({ enabled: true }), /^A document\.sync_root\.add\.v1 card carries unsupported fields: enabled — it takes path, note, evidence only$/],
    ['an unknown key on an enable', () => enable({ note: 'x' }), /^A document\.sync_root\.enable\.v1 card carries unsupported fields: note — it takes root_id, enabled, evidence only$/],
  ])('%s', async (_n, make, re) => {
    const db = makeDb();
    await expect(normalizeActionDraft(db, make(), EVIDENCE, { currentUserId: ME })).rejects.toThrow(re);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('the add card', () => {
  test('the path must be the folder row of a document.folder read of that exact path, cited', async () => {
    await refuse(add({ path: '' }), /^A sync root card needs "path": the full Dropbox folder path, exactly as the folder row of a document\.folder read of it lists it$/);
    await refuse(add({ path: NEW.toUpperCase() }), `"${NEW.toUpperCase()}" differs from the path the document.folder read lists in capitalisation or spacing — copy "path" EXACTLY as that read lists it, and cite its folder row`);
    await refuse(add({ path: '/  Law Office/   Cases/  Other' }), /^Read the folder first: a sync root card's path must be the "path" of a document\.folder read's folder row in this investigation, cited — that read is the dry run/);
    // The read exists but the wrong row is cited (an entry row, a sql.read row).
    await refuse(add({ evidence: [{ query_id: 'q1', row_number: 2 }] }), `Cite the folder row: the evidence must include the document.folder row whose path is "${NEW}"`);
    await refuse(add({ evidence: [{ query_id: 'q3', row_number: 1 }] }), /^Cite the folder row: /);
    expect(calls.dropbox).toEqual([]);
    expect(writes()).toEqual([]);
  });
  test('addRoot\'s own validation and guards, in its words: the shape, the duplicate (case-insensitive; a disabled dupe hints at enable), nesting either way, a file', async () => {
    const ev = (p) => [{ ...EVIDENCE[0], rows: [folderRow({ path: p })] }, EVIDENCE[1]];
    await refuse(add({ path: 'Law/x' }), /^path must start with "\/" \(a full Dropbox folder path, not an id: handle\)$/, undefined, ev('Law/x'));
    await refuse(add({ path: '/' }), /^the Dropbox account root cannot be a sync root — name a folder$/, undefined, ev('/'));
    const long = `/${'x'.repeat(512)}`;
    await refuse(add({ path: long }), /^path is 513 characters; the limit is 512\. It is rejected rather than shortened — a truncated path is a different folder\.$/, undefined, ev(long));
    const dupe = '/  law office/   cases/  active cases';
    await refuse(add({ path: dupe }), /^that path is already a sync root \(root 1\)$/, undefined, ev(dupe));
    const disabledDupe = '/  Law Office/   Cases/  Potential';
    await refuse(add({ path: disabledDupe }), /^that path is already a sync root \(root 3\) — it is disabled; a document\.sync_root\.enable\.v1 card switches it back on$/, undefined, ev(disabledDupe));
    const inside = '/  Law Office/   Cases/  Active Cases/Smith';
    await refuse(add({ path: inside }), /^this path sits INSIDE root 1 \("\/  Law Office\/   Cases\/  Active Cases"\), which already walks it recursively — every file underneath would be synced twice$/, undefined, ev(inside));
    const contains = '/  Law Office/   Cases';
    await refuse(add({ path: contains }), /^this path CONTAINS root 1 \("\/  Law Office\/   Cases\/  Active Cases"\) — every file under that root would be synced twice\. Disable it first, or pick a narrower path$/, undefined, ev(contains));
    // A disabled root never conflicts (root 3's subtree is free).
    const underDisabled = '/  Law Office/   Cases/  Potential/2019';
    await expect(run(add({ path: underDisabled }), { meta: { [underDisabled]: { '.tag': 'folder' } } }, ev(underDisabled))).resolves.toMatchObject({ root: { path: underDisabled } });
    await refuse(add(), /^that path is a file — a sync root must be a folder$/, { meta: { [NEW]: { '.tag': 'file', id: 'id:F' } } });
    expect(writes()).toEqual([]);
  });
  test('the card: BACKFILL from the read\'s counts, the existing roots by name, NO delete, expected.roots_hash; a trailing slash normalised; nothing written', async () => {
    const d = await run(add({ note: '  closed files  ' }));
    expect(d).toMatchObject({ kind: 'document.sync_root.add.v1', status: 'draft', root: { path: NEW, note: 'closed files' },
      folder: { path_display: NEW, exists: true, listed_files: 40, listed_folders: 3, listing_truncated: false, registered_files: 2 },
      roots_total: 4, sync_enabled: true, expected: { roots_hash: hashOf(ROOTS()) } });
    expect(d.roots).toEqual([{ root_id: 1, path: '/  Law Office/   Cases/  Active Cases', enabled: true, backfill_done: true }, { root_id: 2, path: '/  Law Office/   Cases/  Closed', enabled: true, backfill_done: false },
      { root_id: 3, path: '/  Law Office/   Cases/  Potential', enabled: false, backfill_done: true }, { root_id: 4, path: '/  Law Office/   Cases/  Unsorted Generated Documents', enabled: true, backfill_done: false }]);
    expect(d.warnings).toEqual([`BACKFILL: EVERY file beneath "${NEW}" is registered on the root's first walk — 40 files and 3 subfolders at the top level, and everything inside those subfolders — in backfill mode: bulk writes, NO rule emissions (no document.created fires for them), over as many ticks as it takes (days for a large tree). 2 files are registered under it already.`]);
    expect(d.effects).toEqual([
      'No delete: a sync root cannot be deleted (its rows carry no root id — deleting one would strand every file it registered); DISABLING it is the undo, through a document.sync_root.enable.v1 card or the Sync panel.',
      'Path is permanent: a root\'s path cannot be changed (its Dropbox cursor belongs to this folder) — a wrong path is disabled and the right one added.',
      'Attribution: files under a case\'s cached Dropbox folder are linked to that case by the sync (relation "path"); every other file shows on the Documents page\'s Unlinked list.',
      'Incremental after: once the first walk finishes (backfill_done), every change under the root registers one file at a time and fires document.created / document.updated / document.linked for the trigger rules.',
      'Manual tick: More → Documents → Sync → Sync now runs one small batch against the root; the scheduled documents_sync job does the rest.',
      'Existing roots (4): #1 "/  Law Office/   Cases/  Active Cases"; #2 "/  Law Office/   Cases/  Closed" (backfilling); #3 "/  Law Office/   Cases/  Potential" (disabled); #4 "/  Law Office/   Cases/  Unsorted Generated Documents" (backfilling).',
      'Other open pages: the Sync panel reads the roots when it is next opened (roots are not on the live-update bus).']);
    expect(calls.dropbox).toEqual([['getMetadata', { path: NEW }]]);
    expect(writes()).toEqual([]);
    expect(d.evidence.map((e) => [e.query_id, e.row_number])).toEqual([['q1', 1], ['q2', 1]]);
    // The read's path is what the card carries, normalised like addRoot (one trailing slash dropped).
    const slash = `${NEW}/`;
    const s = await run(add({ path: slash }), { meta: { [NEW]: META[NEW] } }, [{ ...EVIDENCE[0], rows: [folderRow({ path: slash })] }, EVIDENCE[1]]);
    expect(s.root.path).toBe(NEW);
  });
  test('a folder that does not exist is disclosed (the route\'s 201 + warning); "500 or more"; the sync off; a long note', async () => {
    const d = await run(add({ note: 'n'.repeat(300) }), { meta: {}, syncOff: true }, [{ ...EVIDENCE[0], rows: [folderRow({ exists: '0', listing_truncated: '1', listed_files: '500', listed_folders: '0', registered_files: '0' })] }, EVIDENCE[1]]);
    expect(d.folder.exists).toBe(false);
    expect(d.warnings).toEqual([
      `BACKFILL: EVERY file beneath "${NEW}" is registered on the root's first walk — 500 or more entries at the top level (the read stops counting there), and everything inside those subfolders — in backfill mode: bulk writes, NO rule emissions (no document.created fires for them), over as many ticks as it takes (days for a large tree). 0 files are registered under it already.`,
      `NOT IN DROPBOX YET: "${NEW}" does not exist now — the route still creates the root, enabled, with the warning "folder does not exist yet — will sync when created", and it starts syncing when the folder appears. Check the spelling (leading spaces in a segment count) if you expected it to exist.`,
      'SYNC OFF: documents_sync_enabled is not "1" — the root is created, but nothing walks it until the engine is switched on (YisraCase Config → System → Switches).']);
    expect(d.effects).toContain('Note: cut to 255 characters as stored.');
    expect(d.sync_enabled).toBe(false);
  });
  test('a provider error other than not-found is the card\'s failure, never "does not exist"', async () => {
    const db = makeDb({ meta: {} });
    dropbox.getMetadata.mockImplementation(async () => { throw Object.assign(new Error('dropbox: POST /2/files/get_metadata → 429: rate limited'), { status: 429 }); });
    await expect(normalizeActionDraft(db, add(), EVIDENCE, { currentUserId: ME })).rejects.toThrow('429: rate limited');
  });
});

describe('the enable / disable card', () => {
  test('root_id and enabled shapes; the root row cited from a document.sync_roots read; a gone root; a state already equal', async () => {
    await refuse(enable({ root_id: 0 }), /^A sync root card needs the root's exact positive root_id \(read the roots first: document\.sync_roots\)$/);
    await refuse(enable({ enabled: 'true' }), /^enabled must be true \(switch the root on\) or false \(switch it off\)$/);
    await refuse(enable({ evidence: [{ query_id: 'q2', row_number: 1 }] }), /^The evidence does not identify root #3 — cite its row from a document\.sync_roots read \(read the roots first\)$/);
    await refuse(enable({ evidence: [{ query_id: 'q3', row_number: 1 }] }), /^The evidence does not identify root #3/);
    await refuse(enable({ root_id: 9, evidence: [{ query_id: 'q2', row_number: 4 }] }), /^The evidence does not identify root #9/);
    await refuse(enable(), /^Sync root not found — root #3 is gone$/, { roots: ROOTS().filter((r) => r.id !== 3) });
    await refuse(enable({ enabled: false }), /^Root #3 \("\/  Law Office\/   Cases\/  Potential"\) is already disabled — that changes nothing$/);
    await refuse(enable({ root_id: 1, enabled: true, evidence: [{ query_id: 'q2', row_number: 2 }] }), /^Root #1 \("\/  Law Office\/   Cases\/  Active Cases"\) is already enabled — that changes nothing$/);
    expect(writes()).toEqual([]);
  });
  test('enabling re-checks nesting in setRootEnabled\'s words — a disabled root inside an enabled one, or containing one', async () => {
    const inside = [...ROOTS(), { id: 5, path: '/  Law Office/   Cases/  Active Cases/Old', note: null, enabled: 0, backfill_done: 0, syncing_since: null, last_sync_at: null, last_error: null, stats: null, created_at: CREATED, has_cursor: 0 }];
    const ev = [EVIDENCE[1], { id: 'q4', kind: 'document.sync_roots', purpose: 'x', rows: [{ row_type: 'engine' }, { row_type: 'root', root_id: '5', path: inside[4].path }] }];
    await refuse(enable({ root_id: 5, evidence: [{ query_id: 'q4', row_number: 2 }] }), /^cannot enable: this root sits inside root 1 \("\/  Law Office\/   Cases\/  Active Cases"\) — every file underneath would be synced twice$/, { roots: inside }, ev);
    const contains = [...ROOTS(), { id: 6, path: '/  Law Office', note: null, enabled: 0, backfill_done: 0, syncing_since: null, last_sync_at: null, last_error: null, stats: null, created_at: CREATED, has_cursor: 0 }];
    const ev2 = [{ id: 'q4', kind: 'document.sync_roots', purpose: 'x', rows: [{ row_type: 'root', root_id: '6', path: '/  Law Office' }] }];
    await refuse(enable({ root_id: 6, evidence: [{ query_id: 'q4', row_number: 1 }] }), /^cannot enable: this root contains root 1 \("\/  Law Office\/   Cases\/  Active Cases"\) — every file underneath would be synced twice$/, { roots: contains }, ev2);
    expect(writes()).toEqual([]);
  });
  test('enable: RESUMES (first walk done) or FIRST WALK PENDING; the sync off; the nesting note; expected carries the hash and the state', async () => {
    const d = await run(enable());
    expect(d).toMatchObject({ kind: 'document.sync_root.enable.v1', status: 'draft', enabled: true, sync_enabled: true, roots_total: 4,
      root: { root_id: 3, path: '/  Law Office/   Cases/  Potential', note: 'off', enabled: false, backfill_done: true, has_cursor: true, last_sync_at: '2026-10-01T09:00:00.000Z', last_error: 'rate limited' },
      expected: { roots_hash: hashOf(ROOTS()), enabled: false } });
    expect(d.warnings).toEqual(['RESUMES: root #3 ("/  Law Office/   Cases/  Potential") rejoins the sync rotation. It keeps its cursor, so the next tick asks Dropbox what changed under it since it was disabled and registers all of that one file at a time, firing document.created / document.updated / document.linked for every change.']);
    expect(d.effects).toEqual(['Nesting re-checked: enabling re-runs the nesting guard against the roots enabled now (passed at proposal; the route checks again at the click).',
      'Only this field: a root\'s path cannot be changed (the route refuses any other key) and a root cannot be deleted — disable is the only undo.',
      'Other open pages: the Sync panel reads the roots when it is next opened (roots are not on the live-update bus).']);
    const pending = ROOTS(); pending[2].backfill_done = 0;
    const p = await run(enable(), { roots: pending, syncOff: true });
    expect(p.warnings).toEqual(['FIRST WALK PENDING: root #3 ("/  Law Office/   Cases/  Potential") rejoins the sync rotation with its first walk unfinished (backfill_done is 0), so the engine walks EVERY file beneath it in backfill mode — bulk writes, no rule emissions — before switching to incremental.',
      'SYNC OFF: documents_sync_enabled is not "1" — the root is enabled, but nothing walks it until the engine is switched on (YisraCase Config → System → Switches).']);
    expect(calls.dropbox).toEqual([]);
    expect(writes()).toEqual([]);
  });
  test('disable: leaves the rotation, nothing unregistered, the manual tick still runs it, re-enabling re-checks; never a warning', async () => {
    const d = await run(enable({ root_id: 2, enabled: false, evidence: [{ query_id: 'q2', row_number: 3 }] }));
    expect([d.enabled, d.root.root_id, d.root.enabled, d.warnings, d.expected]).toEqual([false, 2, true, [], { roots_hash: hashOf(ROOTS()), enabled: true }]);
    expect(d.effects).toEqual([
      'Leaves the rotation: the scheduled sync skips root #2 ("/  Law Office/   Cases/  Closed"); its cursor and every row it registered stay exactly as they are — nothing is unregistered, unlinked or marked deleted. Files that change, move or are deleted under it are not seen until it is re-enabled.',
      'Manual tick still runs it: More → Documents → Sync → Sync now on a disabled root runs one batch anyway (the override for testing a fix) — it does not override the kill switch.',
      'Re-enabling re-checks nesting against the roots enabled then (a document.sync_root.enable.v1 card with enabled true, or the panel).',
      'Only this field: a root\'s path cannot be changed (the route refuses any other key) and a root cannot be deleted — disable is the only undo.',
      'Other open pages: the Sync panel reads the roots when it is next opened (roots are not on the live-update bus).']);
    expect(writes()).toEqual([]);
  });
});

describe('the read, the ledger, the request detector', () => {
  test('document.sync_roots: the engine head row and one row per root with its state — never sync_cursor', async () => {
    const r = await documentSyncRootsRead(makeDb());
    expect(r.truncated).toBe(false);
    expect(r.rows[0]).toEqual({ row_type: 'engine', sync_enabled: 1, roots: 4, enabled_roots: 3,
      note: 'The documents sync engine is ON; 4 roots, 3 enabled. A root is added with a document.sync_root.add.v1 card (its path from a document.folder read of that folder) and switched on or off with a document.sync_root.enable.v1 card (root_id from a row below); there is NO delete and a path cannot be changed.' });
    expect(r.rows.slice(1).map((x) => [x.root_id, x.path, x.note, x.enabled, x.backfill_done, x.has_cursor, x.state, x.last_sync_at, x.last_error, x.created_at])).toEqual([
      [1, '/  Law Office/   Cases/  Active Cases', 'active', 1, 1, 1, 'incremental', '2026-11-16T09:00:00.000Z', null, CREATED.toISOString()],
      [2, '/  Law Office/   Cases/  Closed', null, 1, 0, 1, 'running', null, null, CREATED.toISOString()],
      [3, '/  Law Office/   Cases/  Potential', 'off', 0, 1, 1, 'disabled', '2026-10-01T09:00:00.000Z', 'rate limited', CREATED.toISOString()],
      [4, '/  Law Office/   Cases/  Unsorted Generated Documents', null, 1, 0, 0, 'backfilling', null, null, CREATED.toISOString()]]);
    for (const row of r.rows) expect(Object.keys(row)).not.toContain('sync_cursor');
    const off = await documentSyncRootsRead(makeDb({ syncOff: true }));
    expect(off.rows[0].note).toMatch(/^The documents sync engine is OFF \(documents_sync_enabled is not "1"\): no root is walked until it is switched on in YisraCase Config → System → Switches; 4 roots, 3 enabled\./);
  });
  test('both kinds receipt root_id; the detector hears a root added or switched', () => {
    expect([ledger.KINDS.get('document.sync_root.add.v1'), ledger.KINDS.get('document.sync_root.enable.v1')]).toEqual(['root_id', 'root_id']);
    expect(ledger.KINDS.has('document.sync_root.delete.v1')).toBe(false);
    for (const q of ['Add a sync root for /  Law Office/   Cases/  Closed 2019', 'Disable the Potential sync root', 'Turn the closed-files root back on', 'Can you watch the Closed 2019 folder as a sync root?']) {
      expect({ q, hit: taskDraftRequested(q) }).toEqual({ q, hit: true });
    }
    for (const q of ['Which sync roots are enabled?', 'What does a sync root do?']) expect({ q, hit: taskDraftRequested(q) }).toEqual({ q, hit: false });
  });
});

// ── The browser half, lifted from public/assistant.html by name ────────────
const html = fs.readFileSync(path.join(REPO, 'public', 'assistant.html'), 'utf8');
function fnSrc(name) {
  const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(html);
  if (!m) throw new Error(`function ${name} not found`);
  let depth = 0;
  for (let i = html.indexOf('{', html.indexOf(')', m.index)); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(m.index, i + 1);
  }
  throw new Error(`function ${name} unbalanced`);
}
function constSrc(name) {
  const m = new RegExp(`const\\s+${name}\\s*=`).exec(html);
  if (!m) throw new Error(`const ${name} not found`);
  return html.slice(m.index, html.indexOf(';\n', m.index) + 1);
}
function familySrc(id) {
  const at = html.indexOf(`id: '${id}'`);
  if (at < 0) throw new Error(`family ${id} not found`);
  const open = html.lastIndexOf('\n  {', at) + 3;
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(open, i + 1);
  }
  throw new Error(`family ${id} unbalanced`);
}
const FNS = ['formCanonical', 'formDataHash', 'syncrootIsAdd', 'syncrootLabel', 'syncrootTitle', 'syncrootPath', 'syncrootText', 'syncrootBody', 'syncrootId', 'syncrootRequest', 'syncrootSignature',
  'syncrootPrecheck', 'syncrootResult', 'syncrootKnownOutcome', 'syncrootAppliedWarning', 'syncrootOpen'];
function browser(api, deps = {}) {
  const src = [constSrc('SYNCROOT_ACTION_KINDS'), constSrc('DOCREGISTER_LIST_MAX'), ...FNS.map(fnSrc),
    `const family = ${familySrc('syncroot')};`,
    `return { ${FNS.join(', ')}, family };`].join('\n');
  const P = deps.P || { Swal: { fire: jest.fn() } };
  // The page loads public/js/formTemplateOps.js: formDataHash hashes its canonical.
  return new Function('api', 'P', 'YCFormTemplateOps', src)(api, P, ops); // eslint-disable-line no-new-func
}
const live = (roots = ROOTS()) => ({ status: 'success', sync_enabled: true, roots: roots.map((r) => ({ id: r.id, path: r.path, enabled: !!r.enabled, backfill_done: !!r.backfill_done })) });

describe('the browser: the bodies, the precheck, the result checks, the outcomes, danger, the applied copy, text', () => {
  let addDraft; let onDraft; let offDraft;
  beforeEach(async () => {
    addDraft = await run(add({ note: 'closed files' }));
    onDraft = await run(enable());
    offDraft = await run(enable({ root_id: 2, enabled: false, evidence: [{ query_id: 'q2', row_number: 3 }] }));
  });
  test('the requests: the add POST {path, note?}; the enable PATCH {enabled} on the root', () => {
    const b = browser(jest.fn());
    expect(b.syncrootRequest(addDraft)).toEqual({ path: '/api/documents/sync-roots', method: 'POST', body: { path: NEW, note: 'closed files' } });
    expect(b.syncrootRequest({ ...addDraft, root: { path: NEW, note: null } }).body).toEqual({ path: NEW });
    expect(b.syncrootRequest(onDraft)).toEqual({ path: '/api/documents/sync-roots/3', method: 'PATCH', body: { enabled: true } });
    expect(b.syncrootRequest(offDraft)).toEqual({ path: '/api/documents/sync-roots/2', method: 'PATCH', body: { enabled: false } });
    for (const bad of [{ path: 'x' }, { path: '/' }, { path: `/${'x'.repeat(512)}` }, { path: '/a\nb' }]) expect(() => b.syncrootRequest({ ...addDraft, root: bad })).toThrow('This card has no usable root path.');
    expect(() => b.syncrootRequest({ ...addDraft, root: { path: NEW, note: '' } })).toThrow('This card\'s note is unusable.');
    expect(() => b.syncrootRequest({ ...onDraft, root: { ...onDraft.root, root_id: 0 } })).toThrow('This card has no usable root id.');
    expect(() => b.syncrootRequest({ ...onDraft, enabled: 'yes' })).toThrow('This card has no usable enabled flag.');
  });
  test('the precheck: the page\'s hash of the live list equals the server\'s; any added / enabled / disabled root refuses; a gone root; a state already equal', async () => {
    expect(await b_(live()).syncrootPrecheck(addDraft)).toBe('');
    expect(await b_(live()).syncrootPrecheck(onDraft)).toBe('');
    expect(await b_(live()).syncrootPrecheck(offDraft)).toBe('');
    const changed = 'The sync roots changed since this card was prepared (one was added, enabled or disabled). Nothing was written. Ask Casey to prepare it again.';
    expect(await b_(live([...ROOTS(), { id: 5, path: '/new', enabled: 1 }])).syncrootPrecheck(addDraft)).toBe(changed);
    const flipped = ROOTS(); flipped[3].enabled = 0;
    expect(await b_(live(flipped)).syncrootPrecheck(addDraft)).toBe(changed);
    expect(await b_(live(ROOTS().filter((r) => r.id !== 3))).syncrootPrecheck(onDraft)).toBe(changed);
    // Paths differing only in case hash the same (Dropbox paths are case-insensitive; the server folds too).
    const recased = ROOTS(); recased[0].path = recased[0].path.toUpperCase();
    expect(await b_(live(recased)).syncrootPrecheck(addDraft)).toBe('');
    // A tampered expected hash refuses.
    expect(await b_(live()).syncrootPrecheck({ ...onDraft, expected: { roots_hash: 'ff' } })).toBe(changed);
    await expect(b_({ status: 'success' }).syncrootPrecheck(onDraft)).rejects.toThrow('the sync roots could not be read');
    const api = jest.fn();
    await expect(browser(api).syncrootPrecheck({ ...onDraft, enabled: 'x' })).rejects.toThrow('This card has no usable enabled flag.');
    expect(api).not.toHaveBeenCalled();
    function b_(answer) { return browser(jest.fn(async (p, body, method) => { expect([p, body, method]).toEqual(['/api/documents/sync-roots', null, 'GET']); return answer; })); }
  });
  test('the result checks: the add\'s new root (its path, enabled) with the route\'s warning kept; the enable\'s root and state; mismatches refused', () => {
    const b = browser(jest.fn());
    expect(b.syncrootResult(addDraft, { status: 'success', root: { id: 5, path: NEW, enabled: true }, warning: 'folder does not exist yet — will sync when created' })).toEqual({ root_id: 5 });
    expect(addDraft.__syncrootWarning).toBe('folder does not exist yet — will sync when created');
    expect(JSON.stringify(addDraft)).not.toContain('__syncrootWarning');
    expect(b.syncrootResult(addDraft, { status: 'success', root: { id: 5, path: NEW.toLowerCase(), enabled: true } })).toEqual({ root_id: 5 });
    for (const bad of [{ root: { id: 5, path: '/other', enabled: true } }, { root: { id: 5, path: NEW, enabled: false } }, { root: { id: 0, path: NEW, enabled: true } }, { status: 'error', root: { id: 5, path: NEW, enabled: true } }]) {
      expect(() => b.syncrootResult(addDraft, { status: 'success', ...bad })).toThrow(/did not confirm the (new root|root)/);
    }
    expect(b.syncrootResult(onDraft, { status: 'success', root: { id: 3, path: onDraft.root.path, enabled: true } })).toEqual({ root_id: 3 });
    expect(b.syncrootResult(offDraft, { status: 'success', root: { id: 2, path: offDraft.root.path, enabled: false } })).toEqual({ root_id: 2 });
    expect(() => b.syncrootResult(onDraft, { status: 'success', root: { id: 3, enabled: false } })).toThrow('The sync-roots route did not confirm the change');
    expect(() => b.syncrootResult(onDraft, { status: 'success', root: { id: 4, enabled: true } })).toThrow('The sync-roots route did not confirm the change');
  });
  test('outcomes: the route\'s 409s (duplicate, nesting, cannot enable) are refusals before any row; anything else falls through', () => {
    const b = browser(jest.fn());
    for (const m of ['that path is already a sync root (root 1)', 'this path sits INSIDE root 1 ("/x"), which already walks it recursively — every file underneath would be synced twice',
      'this path CONTAINS root 1 ("/x") — every file under that root would be synced twice. Disable it first, or pick a narrower path', 'cannot enable: this root sits inside root 1 ("/x") — every file underneath would be synced twice']) {
      expect(b.syncrootKnownOutcome({ status: 409, body: { message: m } })).toEqual({ status: 'Refused — nothing written', text: `Refused — nothing written: the sync-roots route refused before writing anything (${m}). Ask Casey to read the roots again.` });
    }
    expect(b.syncrootKnownOutcome({ status: 409, body: { message: 'dropbox: POST /2/files/get_metadata → 409: other' } })).toBe(null);
    expect(b.syncrootKnownOutcome({ status: 409, body: { idempotency: {}, message: 'that path is already a sync root (root 1)' } })).toBe(null);
    expect(b.syncrootKnownOutcome({ status: 500, body: { message: 'that path is already a sync root (root 1)' } })).toBe(null);
  });
  test('the family: one receipt field, danger on an add and an enable, never on a disable; the title function; the applied copy with the route\'s warning', () => {
    const b = browser(jest.fn());
    const f = b.family;
    expect([f.id, [...f.kinds], f.idField, f.appliedKey, !!f.stringReceipt]).toEqual(['syncroot', ['document.sync_root.add.v1', 'document.sync_root.enable.v1'], 'root_id', 'result_syncroot_root_id', false]);
    expect([f.danger(addDraft), f.danger(onDraft), f.danger(offDraft)]).toEqual([true, true, false]);
    expect([f.title(addDraft), f.label(addDraft), f.label(onDraft), f.label(offDraft)]).toEqual(['Sync root', 'Add document sync root', 'Enable document sync root', 'Disable document sync root']);
    addDraft.result_syncroot_root_id = 5;
    Object.defineProperty(addDraft, '__syncrootWarning', { value: 'folder does not exist yet — will sync when created', configurable: true });
    expect(f.appliedCopy(addDraft)).toEqual({ status: 'Applied — sync root #5 added', button: 'Where is it?',
      warning: `Sync root #5 "${NEW}" was added, enabled, using your signed-in account. The route warned: folder does not exist yet — will sync when created. Its first walk registers every file beneath it in backfill mode over the coming ticks. There is no delete: disable it to undo.` });
    offDraft.result_syncroot_root_id = 2;
    expect(f.appliedCopy(offDraft)).toEqual({ status: 'Applied — sync root #2 disabled', button: 'Where is it?',
      warning: 'Sync root #2 "/  Law Office/   Cases/  Closed" is now disabled, using your signed-in account. The scheduled sync skips it; nothing it registered changes, and Sync now still runs it by hand.' });
    expect(f.entity(offDraft)).toEqual({ kind: 'document', id: '2', label: 'sync root /  Law Office/   Cases/  Closed' });
    expect(f.resultText({ root_id: 2 })).toBe('sync root #2');
    expect(f.refusalText('x')).toBe('Refused — nothing written (x). Ask Casey to read the roots again.');
    const P = { Swal: { fire: jest.fn() } };
    browser(jest.fn(), { P }).syncrootOpen();
    expect(P.Swal.fire).toHaveBeenCalledWith(expect.objectContaining({ title: 'Sync roots' }));
  });
  test('the card text', () => {
    const b = browser(jest.fn());
    const t = b.syncrootText(addDraft).split('\n');
    expect(t.slice(0, 5)).toEqual(['Document sync root proposal — not applied', 'Action: Add document sync root', `Root path: ${NEW} — note "closed files"`,
      `Folder in Dropbox: exists (shown as "${NEW}"); 40 file(s) and 3 subfolder(s) at the top level; 2 registered already`, 'Sync engine: on; existing roots: 4']);
    expect(t).toContain('Writes: one document_sync_roots row (enabled, first walk pending) through the Sync panel\'s own route — nothing in Dropbox, no document row yet (the walk writes those).');
    const e = b.syncrootText(onDraft).split('\n');
    expect(e.slice(0, 4)).toEqual(['Document sync root proposal — not applied', 'Action: Enable document sync root', 'Root: #3 "/  Law Office/   Cases/  Potential" — note "off"',
      'Now: disabled, first walk done, last synced 2026-10-01, last error "rate limited"']);
    expect(e[4]).toBe('After: enabled; sync engine on');
    expect(e).toContain('Writes: the root\'s enabled flag only (its path, cursor and every registered row stay) through the Sync panel\'s own route — nothing in Dropbox.');
  });
});
