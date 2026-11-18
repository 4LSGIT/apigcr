// tests/storageReplay.mysql.test.js
//
/**
 * STORAGE REPLAY GOLDEN — tier B, the real engine (storage-seam D0).
 *
 * The registry's write path (documentIngestService → documentService) and the
 * sync engine's tick are driven against REAL tables cloned from
 * ref/database.sql — documents, document_links, case_folder_cache,
 * document_sync_roots, cases (no triggers: the helper takes the CREATE TABLE
 * block only) — on this twin's OWN `*_test` database. Tier A mocks that row
 * layer as a recorder; this tier proves the SQL under it: the relation a
 * registration gets from the folder cache, the upsert-on-duplicate, the
 * path-link retraction on a move, the delete grace, the cache refresh.
 *
 * Golden: tests/fixtures/storageReplay.mysql.golden.json — provider calls +
 * table snapshots (ids normalized, timestamps reduced to null/not-null).
 * Same STORAGE_GOLDEN_WRITE=1 mechanics as tier A, refused under CI.
 *
 *   mysql -uroot -e 'CREATE DATABASE yc_storage_replay_test'
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/yc_storage_replay_test npx jest tests/storageReplay.mysql.test.js
 *
 * Twin rules (CLAUDE.md): own DB (the hostname must be local and the name end
 * in _test), every table it touches rebuilt in beforeAll, no sibling family on
 * the same DB, relaxed sql_mode (asserted), UTC session.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

jest.mock('../services/dropboxService', () => require('./helpers/recordingDropbox').factory());
jest.mock('../lib/domainEvents', () => ({
  ...jest.requireActual('../lib/domainEvents'),
  emit: jest.fn((db, type, env) => { mockEvents.push({ type, case_id: env && env.case_id, contact_id: env && env.contact_id, source: env && env.source }); }),
}));
jest.mock('../lib/alerting', () => ({ alert: jest.fn(async () => {}) }));
const mockEvents = [];

const { schemaFor } = require('./helpers/commsArchiveSchema');
const W = require('./helpers/storageReplayWorld');
const fake = require('../services/dropboxService').__fake;
const ingest = require('../services/documentIngestService');
const sync = require('../services/documentSyncService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const suite = URL_ ? describe : describe.skip;
const TABLES = ['documents', 'document_links', 'case_folder_cache', 'document_sync_roots', 'cases', 'case_relate', 'contacts', 'field_defs', 'app_settings'];   // app_settings: storage_folders for the D3c-2 contact-folder test   // case_relate + contacts: ensureCaseDropboxFolder names the primary contact (D3a); field_defs: createCase reads the custom-field defs (D3b-1)
// D3a: the binding row, built by the migration script itself (its CREATE comes from the record file)
const d3a = require('../scripts/storageSeamD3aEntityFolders');
const entityFolders = require('../services/entityFolderService');
const caseService = require('../services/caseService');
const GOLDEN = path.join(__dirname, 'fixtures', 'storageReplay.mysql.golden.json');
const WRITE = process.env.STORAGE_GOLDEN_WRITE === '1';
if (WRITE && process.env.CI) throw new Error('STORAGE_GOLDEN_WRITE is refused under CI');
const golden = fs.existsSync(GOLDEN) ? JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) : { scenarios: {} };
const records = {};

suite('storage replay on real MySQL', () => {
  let db;
  const q = async (sql, params = []) => (await db.query(sql, params))[0];

  beforeAll(async () => {
    const url = new URL(URL_);
    if (!/_test$/.test(url.pathname) || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Own local *_test DB required');
    db = mysql.createPool({ uri: URL_, connectionLimit: 4, timezone: 'Z', namedPlaceholders: false });
    const [[mode]] = await db.query('SELECT @@sql_mode AS m');
    if (/STRICT_TRANS_TABLES|ONLY_FULL_GROUP_BY/.test(mode.m)) throw new Error(`relaxed sql_mode required, got ${mode.m}`);
    await q('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of TABLES) await q(`DROP TABLE IF EXISTS \`${t}\``);
    const { creates, alters } = schemaFor(TABLES);
    if (creates.length !== TABLES.length) throw new Error(`schemaFor found ${creates.length} of ${TABLES.length}`);
    for (const s of creates) await q(s);
    for (const s of alters) await q(s);
    await q('DROP TABLE IF EXISTS entity_folders');
    await q(d3a.createTableSql());   // D3b-1: the filing readers read it from the first scenario on; the D3a test drops and recreates it through the migration
  });
  afterAll(async () => {
    if (db) { await q('SET FOREIGN_KEY_CHECKS = 0'); for (const t of [...TABLES, 'entity_folders']) await q(`DROP TABLE IF EXISTS \`${t}\``); await db.end(); }
    if (WRITE) fs.writeFileSync(GOLDEN, JSON.stringify({ ...golden, scenarios: { ...golden.scenarios, ...records } }, null, 1) + '\n');
  });

  async function bindings() {
    return q("SELECT entity_kind, entity_id, source, external_id, path_lower, path_display, human_link, resolve_error, resolved_at IS NOT NULL AS resolved, relink_dismissed_at IS NOT NULL AS dismissed, relink_dismissed_by FROM entity_folders ORDER BY entity_kind, entity_id");
  }

  async function snapshot() {
    const docs = await q('SELECT id, external_id, name, path, path_lower, size, status, pending_delete_at, rev FROM documents ORDER BY external_id');
    const idOf = new Map(docs.map((d) => [d.id, d.external_id]));
    const links = await q('SELECT document_id, link_type, link_id, relation, created_by FROM document_links ORDER BY document_id, link_type, link_id');
    const cache = await q('SELECT case_id, folder_external_id, path_lower, path_display, resolve_error FROM case_folder_cache ORDER BY case_id');
    const roots = await q('SELECT id, path, backfill_done, sync_cursor, last_error, stats FROM document_sync_roots ORDER BY id');
    return {
      documents: docs.map((d) => ({ external_id: d.external_id, name: d.name, path: d.path, path_lower: d.path_lower, size: d.size == null ? null : Number(d.size), status: d.status, rev: d.rev, pending_delete: d.pending_delete_at != null })),
      links: links.map((l) => ({ document: idOf.get(l.document_id), link_type: l.link_type, link_id: l.link_id, relation: l.relation, created_by: l.created_by })),
      case_folder_cache: cache,
      sync_roots: roots.map((r) => { const s = typeof r.stats === 'string' ? JSON.parse(r.stats) : r.stats; if (s) delete s.ms; return { ...r, stats: s }; }),
      events: mockEvents.slice(),
    };
  }

  async function reset() {
    fake.reset(); mockEvents.length = 0;
    for (const t of TABLES) await q(`TRUNCATE TABLE \`${t}\``);
    const links = fake.seed({ folders: [`${W.ACTIVE_ROOT}/  Active - Bankruptcy`, W.CASE_A_FOLDER, `${W.CASE_A_FOLDER}/Client Uploads`, `${W.CASE_A_FOLDER}/Client Docs - John Smith`, W.BINS.uploads], links: [W.CASE_A_FOLDER] });
    await q('INSERT INTO cases (case_id, case_dropbox) VALUES (?, ?), (?, ?)', ['hjSFMabb', links[W.CASE_A_FOLDER], 'deadLnk1', 'https://www.dropbox.com/scl/fo/gone0000?dl=0']);
    const a = fake.node(W.CASE_A_FOLDER);
    await q('INSERT INTO case_folder_cache (case_id, folder_external_id, path_lower, path_display) VALUES (?, ?, ?, ?)', ['hjSFMabb', a.id, a.path_lower, a.path_display]);
    // D3b-1: the bindings as the backfill made them (cases ⨝ case_folder_cache)
    await q('TRUNCATE TABLE entity_folders');
    await q("INSERT INTO entity_folders (entity_kind, entity_id, source, external_id, path_lower, path_display, human_link, resolved_at) VALUES ('case', ?, 'dropbox', ?, ?, ?, ?, NOW()), ('case', ?, 'dropbox', NULL, NULL, NULL, ?, NULL)",
      ['hjSFMabb', a.id, a.path_lower, a.path_display, links[W.CASE_A_FOLDER], 'deadLnk1', 'https://www.dropbox.com/scl/fo/gone0000?dl=0']);
    return a;
  }

  function scenario(name, fn) {
    test(name, async () => {
      const a = await reset();
      const extra = (await fn(a)) || {};
      const record = { calls: fake.calls.slice(), ...extra, state: await snapshot(), provider_state: fake.snapshot() };
      records[name] = record;
      if (!WRITE) {
        expect(golden.scenarios[name]).toBeDefined();
        expect(record).toEqual(golden.scenarios[name]);
      }
    });
  }

  const entry = (id, p, size, rev = 'r1') => ({ '.tag': 'file', id, name: p.slice(p.lastIndexOf('/') + 1), path_display: p, path_lower: p.toLowerCase(), size, rev, content_hash: `h-${id}`, server_modified: '2026-11-10T10:00:00Z' });

  scenario('B1 registry: relation path under the cached case folder, upload elsewhere, contact link, re-registration updates in place, a folder is refused', async () => {
    const out = [];
    out.push(await ingest.registerWritten(db, { entry: entry('id:b0001', `${W.CASE_A_FOLDER}/Client Uploads/W2.pdf`, 10), links: [{ type: 'case', id: 'hjSFMabb' }], createdBy: 6, eventSource: 'upload' }));
    out.push(await ingest.registerWritten(db, { entry: entry('id:b0002', `${W.BINS.uploads}/deadLnk1 - Lee, Ann/Lease.pdf`, 20), links: [{ type: 'case', id: 'deadLnk1' }], createdBy: null, eventSource: 'generated_doc' }));
    out.push(await ingest.registerWritten(db, { entry: entry('id:b0003', `${W.BINS.uploads}/ID.png`, 30), links: [{ type: 'contact', id: 502 }], createdBy: 6, eventSource: 'upload' }));
    out.push(await ingest.registerWritten(db, { entry: entry('id:b0001', `${W.CASE_A_FOLDER}/Client Uploads/W2 (renamed).pdf`, 11, 'r2'), links: [{ type: 'case', id: 'hjSFMabb' }], createdBy: 6, eventSource: 'upload' }));
    const safe = await ingest.registerWrittenSafe(db, { entry: { '.tag': 'folder', id: 'id:F0099', name: 'x', path_display: '/x', path_lower: '/x' }, links: [] });
    // the path form: no entry given → provider.stat through documentSourceService
    fake.simulateUpload(`${W.CASE_A_FOLDER}/Client Docs - John Smith/Scan.pdf`, '%PDF scan');
    out.push(await ingest.registerWritten(db, { path: `${W.CASE_A_FOLDER}/Client Docs - John Smith/Scan.pdf`, links: [{ type: 'case', id: 'hjSFMabb' }], eventSource: 'upload' }));
    return { results: out.map((r) => ({ document: r.document.external_id, links: r.links })), folder_refused: safe };
  });

  test('D3a: the migration creates + backfills entity_folders equal to the pair, re-runs as ALREADY APPLIED, sees drift; then the writers dual-write it on real tables', async () => {
    const a = await reset();
    await q('DROP TABLE IF EXISTS entity_folders');
    // a second case with a link but no cache row, and a cache row carrying an error
    await q('INSERT INTO cases (case_id, case_dropbox) VALUES (?, ?)', ['k9PotLd2', 'https://www.dropbox.com/scl/fo/nocache?dl=0']);
    await q('INSERT INTO case_folder_cache (case_id, resolve_error, relink_dismissed_at, relink_dismissed_by) VALUES (?, ?, NOW(), 6)', ['deadLnk1', 'dropbox shared_link/not_found/.. (409)']);
    const conn = await db.getConnection();
    try {
      expect((await d3a.run(conn, { log: () => {} })).line).toMatch(/^CHECK OK — GO\. entity_folders will be created and 3 bindings backfilled/);
      const applied = await d3a.run(conn, { apply: true, log: () => {} });
      expect(applied).toEqual({ ok: true, created: true, backfilled: 3, line: expect.stringMatching(/^APPLIED — GO\. Table created; 3 bindings backfilled and verified/) });
      const linkA = (await q('SELECT case_dropbox FROM cases WHERE case_id = ?', ['hjSFMabb']))[0].case_dropbox;
      const rows = await bindings();
      expect(rows.map((r) => [r.entity_id, r.external_id, r.human_link, r.resolve_error, !!r.resolved, !!r.dismissed, r.relink_dismissed_by])).toEqual([
        ['deadLnk1', null, 'https://www.dropbox.com/scl/fo/gone0000?dl=0', 'dropbox shared_link/not_found/.. (409)', true, true, 6],
        ['hjSFMabb', a.id, linkA, null, true, false, null],
        ['k9PotLd2', null, 'https://www.dropbox.com/scl/fo/nocache?dl=0', null, false, false, null],
      ]);
      expect(rows.find((r) => r.entity_id === 'hjSFMabb').path_display).toBe(a.path_display);
      expect((await d3a.run(conn, { apply: true, log: () => {} })).line).toMatch(/^ALREADY APPLIED — GO/);
      // drift in ONE column of ONE row is seen by the <=> comparison, and --apply resyncs it
      await q("UPDATE entity_folders SET path_display = 'x' WHERE entity_id = 'hjSFMabb'");
      expect((await d3a.run(conn, { log: () => {} })).line).toMatch(/^CHECK OK — GO\. The table exists; 1 binding\(s\) to \(re\)sync/);
      expect((await d3a.run(conn, { apply: true, log: () => {} })).line).toMatch(/^APPLIED — GO\. 3 bindings backfilled and verified/);
      expect((await bindings()).find((r) => r.entity_id === 'hjSFMabb').path_display).toBe(a.path_display);

      // DUAL-WRITE on real tables: the sync refresh (resolved + error paths) mirrors the cache
      await sync.refreshCaseFolderCache(db, { caseIds: ['hjSFMabb', 'deadLnk1', 'k9PotLd2'] });
      const after = await bindings();
      const cache = await q('SELECT case_id, folder_external_id, path_lower, path_display, resolve_error FROM case_folder_cache ORDER BY case_id');
      for (const c of cache) {
        const b = after.find((r) => r.entity_id === c.case_id);
        expect([c.case_id, b.external_id, b.path_lower, b.path_display, b.resolve_error]).toEqual([c.case_id, c.folder_external_id, c.path_lower, c.path_display, c.resolve_error]);
      }
      expect(after.find((r) => r.entity_id === 'deadLnk1').resolve_error).toMatch(/not_found/);
      // the heal, relink dismissal, remove
      await entityFolders.setPaths(db, { kind: 'case', id: 'hjSFMabb', pathLower: '/  moved', pathDisplay: '/  Moved' }, { strict: true });
      await entityFolders.setRelinkDismissed(db, { kind: 'case', ids: ['hjSFMabb'], dismissed: true, by: 6 }, { strict: true });
      const h = (await bindings()).find((r) => r.entity_id === 'hjSFMabb');
      expect([h.path_display, !!h.dismissed, h.relink_dismissed_by]).toEqual(['/  Moved', true, 6]);
      await entityFolders.remove(db, { kind: 'case', id: 'k9PotLd2' }, { strict: true });
      expect((await bindings()).map((r) => r.entity_id)).toEqual(['deadLnk1', 'hjSFMabb']);
      // ensureCaseDropboxFolder on a folderless case: the create's handle lands in the binding with the link — no extra provider call
      await q("INSERT INTO cases (case_id, case_type, case_subtype, case_number, case_number_full) VALUES ('newCase1', 'Bankruptcy', 'Ch 7', '26-90001', '26-90001-lsg')");
      fake.calls.length = 0;
      const made = await caseService.ensureCaseDropboxFolder(db, 'newCase1');
      const nb = (await bindings()).find((r) => r.entity_id === 'newCase1');
      expect([nb.human_link, nb.external_id, nb.path_display]).toEqual([made.shared_link, fake.node(made.path).id, made.path]);
      expect(fake.calls.map((c) => c.fn)).toEqual(['getMetadata', 'createFolderWithOptions']);   // the probe + the create; nothing added for the handle
    } finally { conn.release(); }
  });

  test('D3b-1 → D3d-2: caseFolderLink reads the binding ALONE on real rows (the retired column is never consulted); setHumanLink keeps only the link when it changes; updateCase / createCase carry a hand-written link into the binding', async () => {
    const a = await reset();
    const live = (await bindings()).find((r) => r.entity_id === 'hjSFMabb').human_link;
    // the column is stale, the binding is live → the binding's link, with the handle and path it holds
    await q("UPDATE cases SET case_dropbox = 'https://www.dropbox.com/scl/fo/stale000?dl=0' WHERE case_id = 'hjSFMabb'");
    expect(await entityFolders.caseFolderLink(db, 'hjSFMabb')).toEqual({ found: true, link: live, via: 'binding', externalId: a.id, pathLower: a.path_lower });
    expect((await caseService.getCase(db, 'hjSFMabb')).case.case_dropbox).toBe(live);   // the API alias reads the binding, not the stale column
    // column only (no binding row): UNBOUND, the case found — production has no such case (1105 = 1105, 2026-11-18)
    await q("INSERT INTO cases (case_id, case_dropbox) VALUES ('legacy01', ' https://www.dropbox.com/scl/fo/legacy01?dl=0 ')");
    expect(await entityFolders.caseFolderLink(db, 'legacy01')).toEqual({ found: true, link: null, via: null, externalId: null, pathLower: null });
    expect((await caseService.getCase(db, 'legacy01')).case.case_dropbox).toBeNull();
    // a case with neither (found, unbound); a case that does not exist (not found)
    await q("INSERT INTO cases (case_id) VALUES ('bare0001')");
    expect(await entityFolders.caseFolderLink(db, 'bare0001')).toEqual({ found: true, link: null, via: null, externalId: null, pathLower: null });
    expect(await entityFolders.caseFolderLink(db, 'noSuchCs')).toEqual({ found: false, link: null, via: null, externalId: null, pathLower: null });
    expect(await entityFolders.casePathLower(db, 'hjSFMabb')).toBe(a.path_lower);
    await q("UPDATE entity_folders SET resolve_error = 'x' WHERE entity_id = 'hjSFMabb'");
    expect(await entityFolders.casePathLower(db, 'hjSFMabb', { resolvedOnly: true })).toBeNull();
    expect(await entityFolders.casePathLower(db, 'hjSFMabb')).toBe(a.path_lower);
    await q("UPDATE entity_folders SET resolve_error = NULL WHERE entity_id = 'hjSFMabb'");
    // setHumanLink: the same link is a no-op (handle + path kept); a changed link keeps ONLY the link; blank removes
    await entityFolders.setHumanLink(db, { kind: 'case', id: 'hjSFMabb', humanLink: live }, { strict: true });
    let b = (await bindings()).find((r) => r.entity_id === 'hjSFMabb');
    expect([b.external_id, b.path_lower, b.human_link, !!b.resolved]).toEqual([a.id, a.path_lower, live, true]);
    await entityFolders.setHumanLink(db, { kind: 'case', id: 'hjSFMabb', humanLink: 'https://www.dropbox.com/scl/fo/moved001?dl=0' }, { strict: true });
    b = (await bindings()).find((r) => r.entity_id === 'hjSFMabb');
    expect([b.external_id, b.path_lower, b.path_display, b.resolve_error, b.human_link, !!b.resolved]).toEqual([null, null, null, null, 'https://www.dropbox.com/scl/fo/moved001?dl=0', false]);
    await entityFolders.setHumanLink(db, { kind: 'case', id: 'legacy01', humanLink: 'https://www.dropbox.com/scl/fo/legacy01?dl=0' }, { strict: true });   // a first binding for a column-only case
    expect((await entityFolders.caseFolderLink(db, 'legacy01')).via).toBe('binding');
    await entityFolders.setHumanLink(db, { kind: 'case', id: 'legacy01', humanLink: '  ' }, { strict: true });
    expect((await bindings()).map((r) => r.entity_id)).toEqual(['deadLnk1', 'hjSFMabb']);
    // the house write paths: updateCase and createCase carrying case_dropbox bind the case and leave the column ALONE (mysql2 answers information_schema for writableColumns on these real tables)
    const r1 = await caseService.updateCase(db, 'bare0001', { case_dropbox: 'https://www.dropbox.com/scl/fo/byhand01?dl=0' }, { userId: 6, source: 'manual' });
    expect(r1.changes).toEqual({ case_dropbox: { from: null, to: 'https://www.dropbox.com/scl/fo/byhand01?dl=0' } });
    expect(await entityFolders.caseFolderLink(db, 'bare0001')).toMatchObject({ link: 'https://www.dropbox.com/scl/fo/byhand01?dl=0', via: 'binding' });
    expect((await q('SELECT case_dropbox FROM cases WHERE case_id = ?', ['bare0001']))[0].case_dropbox).toBeNull();   // the column is not written any more
    await caseService.updateCase(db, 'bare0001', { case_dropbox: '' }, { userId: 6, source: 'manual' });
    expect((await bindings()).map((r) => r.entity_id)).toEqual(['deadLnk1', 'hjSFMabb']);
    const made = await caseService.createCase(db, { case_type: 'Bankruptcy', case_dropbox: 'https://www.dropbox.com/scl/fo/atcreate?dl=0' });
    expect(await entityFolders.caseFolderLink(db, made.case_id)).toMatchObject({ link: 'https://www.dropbox.com/scl/fo/atcreate?dl=0', via: 'binding' });
    expect((await q('SELECT case_dropbox FROM cases WHERE case_id = ?', [made.case_id]))[0].case_dropbox).toBeNull();
    // _relationFor reads the binding's path: a file under case A's folder is 'path' even with the cache row gone
    await q('TRUNCATE TABLE case_folder_cache');
    await entityFolders.setResolved(db, { kind: 'case', id: 'hjSFMabb', externalId: a.id, pathLower: a.path_lower, pathDisplay: a.path_display, humanLink: live }, { strict: true });
    const r = await ingest.registerWritten(db, { entry: entry('id:d3b0001', `${W.CASE_A_FOLDER}/Client Uploads/Bound.pdf`, 10), links: [{ type: 'case', id: 'hjSFMabb' }], createdBy: 6, eventSource: 'upload' });
    expect(r.links.map((l) => l.relation)).toEqual(['path']);
  });

  test('D3b-2: the refresh queue is ordered by the BINDING — a hand-written link (resolved_at NULL in entity_folders, an old resolved_at in the cache) is refreshed first', async () => {
    await reset();
    const f = `${W.ACTIVE_ROOT}/  Active - Bankruptcy`;
    const links = fake.seed({ folders: [`${f}/ byHand01 - Hand, Ann`, `${f}/ oldest01 - Old, Bob`], links: [`${f}/ byHand01 - Hand, Ann`, `${f}/ oldest01 - Old, Bob`] });
    const hand = links[`${f}/ byHand01 - Hand, Ann`]; const old = links[`${f}/ oldest01 - Old, Bob`];
    await q('INSERT INTO cases (case_id, case_dropbox) VALUES (?, ?), (?, ?)', ['byHand01', hand, 'oldest01', old]);
    // the binding says byHand01 was never resolved (setHumanLink: a hand-written link) and oldest01 yesterday (D3d-2: the binding is the only record; the column rows above are inert)
    await q("INSERT INTO entity_folders (entity_kind, entity_id, source, human_link, resolved_at) VALUES ('case', ?, 'dropbox', ?, NULL), ('case', ?, 'dropbox', ?, NOW() - INTERVAL 1 DAY)", ['byHand01', hand, 'oldest01', old]);
    await q("UPDATE entity_folders SET resolved_at = NOW() - INTERVAL 2 DAY WHERE entity_id IN ('hjSFMabb', 'deadLnk1')");
    fake.calls.length = 0;
    const out = await sync.refreshCaseFolderCache(db, { limit: 1 });
    expect([out.candidates, out.scanned]).toEqual([1, 1]);
    expect(fake.calls.filter((c) => c.fn === 'getSharedLinkMetadata').map((c) => c.args[0].url)).toEqual([hand]);   // NULL-first on the binding, not oldest-first on the cache
    expect((await bindings()).find((r) => r.entity_id === 'byHand01').resolved).toBeTruthy();
  });

  test('D3d-2 REHEARSAL OF THE DROP: with cases.case_dropbox GONE from the table, getCase / updateCase / createCase / ensureCaseDropboxFolder / refresh / dismiss all run on the binding alone', async () => {
    const a = await reset();
    await q('ALTER TABLE cases DROP COLUMN case_dropbox');
    try {
      const live = (await bindings()).find((r) => r.entity_id === 'hjSFMabb').human_link;
      expect((await caseService.getCase(db, 'hjSFMabb')).case.case_dropbox).toBe(live);
      await q("INSERT INTO cases (case_id, case_type, case_subtype) VALUES ('bare0002', 'Bankruptcy', 'Ch 7')");
      expect((await caseService.getCase(db, 'bare0002')).case.case_dropbox).toBeNull();
      // the alias key passes the information_schema gate without the column
      const r = await caseService.updateCase(db, 'bare0002', { case_dropbox: 'https://www.dropbox.com/scl/fo/nocolumn?dl=0', case_notes: 'n' }, { userId: 6, source: 'manual' });
      expect(r.updated_fields).toEqual(['case_notes', 'case_dropbox']);
      expect(r.changes.case_dropbox).toEqual({ from: null, to: 'https://www.dropbox.com/scl/fo/nocolumn?dl=0' });
      expect((await caseService.getCase(db, 'bare0002')).case.case_dropbox).toBe('https://www.dropbox.com/scl/fo/nocolumn?dl=0');
      await caseService.updateCase(db, 'bare0002', { case_dropbox: '' }, { userId: 6 });
      expect((await caseService.getCase(db, 'bare0002')).case.case_dropbox).toBeNull();
      const made = await caseService.createCase(db, { case_type: 'Bankruptcy', case_dropbox: 'https://www.dropbox.com/scl/fo/created1?dl=0' });
      expect((await caseService.getCase(db, made.case_id)).case.case_dropbox).toBe('https://www.dropbox.com/scl/fo/created1?dl=0');
      // ensureCaseDropboxFolder: creates + binds (no column write to fail on); a second call returns the binding
      await q("INSERT INTO contacts (contact_id, contact_kind, contact_name, contact_lfm_name) VALUES (503, 'person', 'Carl Case', 'Case, Carl')");
      await q("INSERT INTO case_relate (case_relate_id, case_relate_case_id, case_relate_client_id, case_relate_type) VALUES (8003, 'bare0002', 503, 'Primary')");
      const made1 = await caseService.ensureCaseDropboxFolder(db, 'bare0002');
      expect(made1.existed).toBe(false);
      expect(await entityFolders.caseFolderLink(db, 'bare0002')).toMatchObject({ link: made1.shared_link, via: 'binding', pathLower: made1.path.toLowerCase() });
      expect(await caseService.ensureCaseDropboxFolder(db, 'bare0002')).toEqual({ existed: true, stage: null, path: null, shared_link: made1.shared_link });
      // the sync engine's refresh and the relink dismissal on the binding
      fake.calls.length = 0;
      const refresh = await sync.refreshCaseFolderCache(db, { caseIds: ['hjSFMabb', 'deadLnk1', 'bare0002'] });
      expect([refresh.resolved, refresh.failed]).toEqual([2, 1]);
      expect(fake.calls.filter((c) => c.fn === 'getSharedLinkMetadata')).toHaveLength(3);
      const out = await sync.setRelinkDismissed(db, ['hjSFMabb'], { actorUserId: 6 });
      expect(out.updated).toBe(1);
      expect((await bindings()).find((r) => r.entity_id === 'hjSFMabb').relink_dismissed_by).toBe(6);
      expect((await q('SELECT COUNT(*) AS c FROM case_folder_cache'))[0].c).toBe(1);   // never written: still the seed's one row
      void a;
    } finally {
      await q('ALTER TABLE cases ADD COLUMN case_dropbox VARCHAR(512) NULL');   // the schema the other tests seed
    }
  });

  test('D3c-2: contact folders on real tables — off without the row; on with the platform tree: created + bound (kind contact), reused, the case folder nested under it via {{contact_folder}}', async () => {
    await reset();
    const { STORAGE_DEFAULTS } = require('../lib/storageDefaults');
    await q("INSERT INTO contacts (contact_id, contact_kind, contact_name, contact_lfm_name) VALUES (502, 'person', 'Jane Doe', 'Doe, Jane')");
    await q("INSERT INTO cases (case_id, case_type, case_subtype) VALUES ('k9PotLd2', 'Bankruptcy', '')");
    await q("INSERT INTO case_relate (case_relate_id, case_relate_case_id, case_relate_client_id, case_relate_type) VALUES (9001, 'k9PotLd2', 502, 'Primary')");
    fake.seed({ folders: ['/Clients'] });
    expect(await caseService.ensureContactFolder(db, 502)).toEqual({ enabled: false });            // no row: no contact folders
    await q("INSERT INTO app_settings (`key`, `value`) VALUES ('storage_folders', ?)", [JSON.stringify(STORAGE_DEFAULTS.storage_folders)]);
    fake.calls.length = 0;
    const made = await caseService.ensureContactFolder(db, 502);
    expect(made).toMatchObject({ enabled: true, existed: false, path: '/Clients/Doe, Jane', folder_existed: false });
    expect(fake.calls.map((c) => c.fn)).toEqual(['getMetadata', 'createFolderWithOptions']);        // the probe + the create
    const b = (await bindings()).find((r) => r.entity_kind === 'contact' && r.entity_id === '502');
    expect([b.human_link, b.external_id, b.path_display, b.path_lower]).toEqual([made.shared_link, fake.node('/Clients/Doe, Jane').id, '/Clients/Doe, Jane', '/clients/doe, jane']);
    fake.calls.length = 0;
    expect(await caseService.ensureContactFolder(db, 502)).toEqual({ enabled: true, existed: true, path: '/Clients/Doe, Jane', shared_link: made.shared_link });
    expect(fake.calls).toEqual([]);                                                                 // the binding answers; no provider call
    const cf = await caseService.ensureCaseDropboxFolder(db, 'k9PotLd2');
    expect(cf.path).toBe('/Clients/Doe, Jane/k9PotLd2 - Bankruptcy');
    expect((await bindings()).map((r) => `${r.entity_kind}:${r.entity_id}`).sort()).toEqual(['case:deadLnk1', 'case:hjSFMabb', 'case:k9PotLd2', 'contact:502']);
  });

  test('D3d-1: query_db\'s virtual cases.case_folder_link is the binding\'s link on real tables — wf 28 step 1\'s shape (a join to the primary contact) and wf 32 step 14\'s (an aliased join); a case with no binding reads NULL', async () => {
    const a = await reset();
    const dbFns = require('../lib/internal_functions/db');
    await q("INSERT INTO contacts (contact_id, contact_kind, contact_name, contact_lfm_name) VALUES (501, 'person', 'John Smith', 'Smith, John')");
    await q("INSERT INTO case_relate (case_relate_id, case_relate_case_id, case_relate_client_id, case_relate_type) VALUES (8001, 'hjSFMabb', 501, 'Primary'), (8002, 'deadLnk1', 501, 'Secondary')");
    await q("INSERT INTO cases (case_id) VALUES ('noBind01')");
    const live = (await q('SELECT case_dropbox FROM cases WHERE case_id = ?', ['hjSFMabb']))[0].case_dropbox;
    const first = await dbFns.query_db({ from: 'cases', join: [{ type: 'left', table: 'case_relate', on: { left: 'cases.case_id', right: 'case_relate.case_relate_case_id' } }, { type: 'left', table: 'contacts', on: { left: 'case_relate.case_relate_client_id', right: 'contacts.contact_id' } }],
      where: [{ op: '=', value: 'hjSFMabb', column: 'cases.case_id' }, { op: '=', value: 'Primary', column: 'case_relate.case_relate_type' }], format: 'first',
      select: ['cases.case_id', 'cases.case_type', 'cases.case_number_full', 'cases.case_folder_link', 'contacts.contact_name', 'contacts.contact_lfm_name'] }, db);
    expect(first.output).toMatchObject({ case_id: 'hjSFMabb', case_folder_link: live, contact_lfm_name: 'Smith, John' });
    expect(first.output.case_folder_link).toBe(a.path_display ? live : live);
    const list = await dbFns.query_db({ from: 'cases', join: [{ on: { left: 'cases.case_id', right: 'cr.case_relate_case_id' }, type: 'inner', alias: 'cr', table: 'case_relate' }], limit: 50,
      where: [{ op: '=', value: 501, column: 'cr.case_relate_client_id' }], format: 'raw', select: ['cases.case_id', 'cases.case_number', 'cases.case_folder_link'], order_by: [{ dir: 'desc', column: 'cr.case_relate_id' }] }, db);
    expect(list.output.map((r) => [r.case_id, r.case_folder_link])).toEqual([['deadLnk1', 'https://www.dropbox.com/scl/fo/gone0000?dl=0'], ['hjSFMabb', live]]);
    const none = await dbFns.query_db({ from: 'cases', where: [{ op: '=', value: 'noBind01', column: 'cases.case_id' }], format: 'first', select: ['cases.case_folder_link', 'cases.case_id'] }, db);
    expect(none.output).toEqual({ case_folder_link: null, case_id: 'noBind01' });
  });

  scenario('B2 sync: backfill page, incremental page with a move and a deletion, then the cache refresh', async (a) => {
    await q('INSERT INTO document_sync_roots (id, path, enabled, backfill_done) VALUES (1, ?, 1, 0)', [W.ACTIVE_ROOT]);
    fake.seed({ pages: [
      [{ '.tag': 'folder', id: a.id, name: a.name, path_display: a.path_display, path_lower: a.path_lower },
        entry('id:s0001', `${W.CASE_A_FOLDER}/Client Uploads/2026-06-01 Intake.pdf`, 1200),
        entry('id:s0002', `${W.ACTIVE_ROOT}/  Active - Bankruptcy/ loose scan.pdf`, 300)],
      [entry('id:s0001', `${W.CASE_A_FOLDER}/Client Docs - John Smith/2026-06-01 Intake.pdf`, 1200, 'r2'),
        { '.tag': 'deleted', name: 'loose scan.pdf', path_display: `${W.ACTIVE_ROOT}/  Active - Bankruptcy/ loose scan.pdf`, path_lower: `${W.ACTIVE_ROOT}/  Active - Bankruptcy/ loose scan.pdf`.toLowerCase() }],
    ] });
    const results = [];
    const strip = (r) => { const o = { ...r }; delete o.ms; return o; };
    const [root] = await q('SELECT * FROM document_sync_roots WHERE id = 1');
    results.push(strip(await sync.syncRoot(db, root, { maxPages: 1 })));
    const [root2] = await q('SELECT * FROM document_sync_roots WHERE id = 1');
    // a page cap in backfill persists a cursor WITHOUT flipping backfill_done (the header's
    // "one cursor, two questions"): the next tick would re-enter backfill. Flip it here as a
    // completed backfill would, so the second page runs INCREMENTAL — the move retracts the
    // stale path-link and re-links, the deletion starts the grace period.
    await q('UPDATE document_sync_roots SET backfill_done = 1 WHERE id = 1');
    results.push(strip(await sync.syncRoot(db, { ...root2, backfill_done: 1 }, { maxPages: 5 })));
    const [root3] = await q('SELECT * FROM document_sync_roots WHERE id = 1');
    results.push(strip(await sync.syncRoot(db, root3, { maxPages: 5 })));   // nothing new on the same cursor
    const refresh = await sync.refreshCaseFolderCache(db, { caseIds: ['hjSFMabb', 'deadLnk1'] });
    delete refresh.elapsed_ms;
    return { results, refresh };
  });
});
