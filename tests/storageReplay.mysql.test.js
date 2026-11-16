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
const TABLES = ['documents', 'document_links', 'case_folder_cache', 'document_sync_roots', 'cases'];
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
  });
  afterAll(async () => {
    if (db) { await q('SET FOREIGN_KEY_CHECKS = 0'); for (const t of TABLES) await q(`DROP TABLE IF EXISTS \`${t}\``); await db.end(); }
    if (WRITE) fs.writeFileSync(GOLDEN, JSON.stringify({ ...golden, scenarios: { ...golden.scenarios, ...records } }, null, 1) + '\n');
  });

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
