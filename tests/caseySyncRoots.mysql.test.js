// tests/caseySyncRoots.mysql.test.js
//
/**
 * A11X on REAL MySQL: the sync-root cards' own SQL (listRoots, the kill switch,
 * the folder read's registered count), the NATIVE ROUTES they drive — POST
 * /api/documents/sync-roots (documentSyncService.addRoot: the validation, the
 * case-insensitive duplicate, the nesting guard, the provider stat, the
 * insert) and PATCH /api/documents/sync-roots/:id (setRootEnabled: the nesting
 * re-check on enable, the one mutable field) — under the production sql_mode,
 * plus the browser's click-time precheck (the roots list re-read and HASHED
 * with the page's own formDataHash), request builders, answer checks and
 * outcome mapping (extracted from public/assistant.html) over the REAL answers.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/yc_a11x_test npx jest tests/caseySyncRoots.mysql.test.js --runInBand
 * The database name must end in _test and the port must not be 3306 (the
 * production proxy). This suite DROPS and recreates its tables, cloned from
 * ref/database.sql, with FOREIGN_KEY_CHECKS off in the before-hook AND the
 * after-hook, taking any sibling-built child of ours with it (the
 * caseyDocuments.mysql hygiene). tests/caseyDocumentsGenerate.mysql.test.js
 * shares this database and rebuilds its own tables the same way.
 *
 * THE PROVIDER IS STUBBED AT ITS OBJECT: dropboxService's getMetadata and
 * listFolder are jest.fns over an in-memory folder set; normalizePath,
 * isPathNotFoundError and _resolveCredential stay REAL. Nothing here reaches
 * Dropbox or a browser.
 *
 * WHAT IS LOCKED
 *   - THE ADD: the card's expected.roots_hash equals the browser's
 *     formDataHash of the REAL GET /api/documents/sync-roots; the real POST
 *     inserts the row enabled, backfill_done 0, cursor NULL, and answers 201
 *     with the new root (the receipt); a folder missing from Dropbox is the
 *     route's 201 + warning, carried onto the applied copy; the route's 409
 *     for a duplicate (case-folded), for a path INSIDE an enabled root and
 *     for one CONTAINING it, and its 400 for a file — each in the words the
 *     normalizer refused with first; nothing inserted on a refusal.
 *   - THE ENABLE / DISABLE: the real PATCH flips exactly `enabled`; enabling
 *     a disabled root nested inside an enabled one is the route's 409 in
 *     setRootEnabled's words (the normalizer refused first); a repoint key is
 *     the route's 400; the precheck refuses after ANY change to the roots
 *     (a root added between proposal and click), and a second card for a
 *     state already reached refuses at proposal.
 *   - NOTHING IS WRITTEN AT PROPOSAL.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const mysql = require('mysql2/promise');

jest.mock('../lib/auth.jwtOrApiKey', () => (req, _res, next) => { req.auth = { type: 'jwt', userId: 6 }; next(); });
jest.mock('../lib/domainEvents', () => ({ ...jest.requireActual('../lib/domainEvents'), emit: jest.fn() }));
jest.mock('../services/dropboxService', () => ({
  ...jest.requireActual('../services/dropboxService'),
  getMetadata: jest.fn(), listFolder: jest.fn(),
}));
const dropbox = require('../services/dropboxService');
const ops = require('../public/js/formTemplateOps');
const { normalizeActionDraft, documentFolderRead, documentSyncRootsRead, compactRows } = require('../services/assistantService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
// Production SESSION sql_mode (verified live 2026-09-25; CLAUDE.md "SQL mode is relaxed").
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['documents', 'document_links', 'case_folder_cache', 'entity_folders', 'document_sync_roots', 'app_settings'];   // entity_folders: the sync engine reads the binding (D3b-2)

function schemaFor(tables) {
  const lines = fs.readFileSync(path.join(__dirname, '..', 'ref', 'database.sql'), 'utf8').split('\n');
  const creates = []; const alters = [];
  for (let i = 0; i < lines.length; i++) {
    for (const t of tables) {
      if (lines[i].startsWith(`CREATE TABLE \`${t}\` (`)) {
        const buf = [];
        for (; i < lines.length; i++) { buf.push(lines[i]); if (/^\) ENGINE=.*;$/.test(lines[i])) break; }
        creates.push(buf.join('\n'));
      } else if (lines[i] === `ALTER TABLE \`${t}\``) {
        const buf = [];
        for (; i < lines.length; i++) { buf.push(lines[i]); if (/;\s*$/.test(lines[i])) break; }
        const head = buf[0];
        const clauses = buf.slice(1).map((l) => l.replace(/[,;]\s*$/, ''))
          .filter((l) => { const m = /REFERENCES `([a-z_]+)`/.exec(l); return !m || tables.includes(m[1]); });
        if (clauses.length) alters.push(`${head}\n${clauses.join(',\n')};`);
      }
    }
  }
  if (creates.length !== tables.length) throw new Error(`schema extraction found ${creates.length} CREATE blocks`);
  alters.sort((a, b) => /FOREIGN KEY/.test(a) - /FOREIGN KEY/.test(b));
  return { creates, alters };
}

function call(app, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app).listen(0, () => {
      const payload = body == null ? '' : JSON.stringify(body);
      const req = http.request({ port: srv.address().port, path: urlPath, method,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => { srv.close(); resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }); });
      });
      req.on('error', (e) => { srv.close(); reject(e); });
      req.end(payload);
    });
  });
}

function fnSrc(html, name) {
  const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(html);
  if (!m) throw new Error(`${name} not found`);
  let depth = 0;
  for (let i = html.indexOf('{', html.indexOf(')', m.index)); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(m.index - (html.slice(0, m.index).endsWith('async ') ? 6 : 0), i + 1);
  }
  throw new Error(`${name} unbalanced`);
}
function browserChecks(api) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'assistant.html'), 'utf8');
  const names = ['formCanonical', 'formDataHash', 'syncrootIsAdd', 'syncrootPath', 'syncrootBody', 'syncrootId', 'syncrootRequest', 'syncrootSignature', 'syncrootPrecheck', 'syncrootResult', 'syncrootKnownOutcome'];
  const src = `${names.map((n) => fnSrc(html, n)).join('\n')}\nreturn { ${names.join(', ')} };`;
  return new Function('api', 'YCFormTemplateOps', src)(api, ops); // eslint-disable-line no-new-func
}

d('the Casey sync-root cards on real MySQL (A11X)', () => {
  let pool; let app; let browser;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const ACTIVE = '/  Law Office/   Cases/  Active Cases';
  const CLOSED = '/  Law Office/   Cases/  Closed';
  const OLD = `${ACTIVE}/Old`;            // disabled, nested inside ACTIVE — can never be enabled while ACTIVE is
  const NEW = '/  Law Office/   Cases/  Closed 2019';
  const lower = (p) => String(p).toLowerCase();
  const hashOf = (roots) => crypto.createHash('sha256').update(ops.canonical(roots.map((r) => `${r.id}:${Number(r.enabled) ? 1 : 0}:${lower(r.path)}`).sort())).digest('hex');
  let folders; let fileAt;
  const notFound = () => Object.assign(new Error('dropbox: POST /2/files/get_metadata → 409: path/not_found/..'), { status: 409, errorSummary: 'path/not_found/..' });

  async function dropAll(conn) {
    const [children] = await conn.query(
      `SELECT DISTINCT TABLE_NAME AS t FROM information_schema.REFERENTIAL_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IN (?) AND TABLE_NAME NOT IN (?)`, [TABLES, TABLES]);
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of [...new Set(children.map((r) => r.t)), ...[...TABLES].reverse()]) {
      await conn.query(`DROP TABLE IF EXISTS \`${t}\``);
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  }
  async function seed() {
    for (const t of [...TABLES].reverse()) await q(`DELETE FROM \`${t}\``);
    await q(`INSERT INTO document_sync_roots (id, path, note, enabled, backfill_done, sync_cursor) VALUES
      (1, ?, 'active', 1, 1, 'cursor-1'), (2, ?, NULL, 1, 0, NULL), (3, ?, 'nested', 0, 1, 'cursor-3')`, [ACTIVE, CLOSED, OLD]);
    await q("INSERT INTO app_settings (`key`, `value`) VALUES ('documents_sync_enabled', '1')");
    await q('INSERT INTO documents (id, source, external_id, name, path, path_lower, ext, size, status) VALUES (91, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['dropbox', 'id:A11XOLD001', 'old.pdf', `${NEW}/old.pdf`, lower(`${NEW}/old.pdf`), 'pdf', 10, 'active']);
  }
  const card = (value, evidence) => normalizeActionDraft(pool, value, evidence, { currentUserId: 6 });
  async function evidenceFor(folderPath) {
    const read = await documentFolderRead(pool, folderPath);
    const roots = await documentSyncRootsRead(pool);
    return [{ id: 'q1', kind: 'document.folder', purpose: 'the folder', rows: compactRows(read.rows) }, { id: 'q2', kind: 'document.sync_roots', purpose: 'the roots', rows: compactRows(roots.rows) }];
  }
  const rootRow = (ev, id) => ev[1].rows.findIndex((r) => r.row_type === 'root' && Number(r.root_id) === id) + 1;
  async function apply(c) {
    const why = await browser.syncrootPrecheck(c);
    if (why) return { refused: why };
    const rq = browser.syncrootRequest(c);
    const res = await call(app, rq.method, rq.path, rq.body);
    if (res.status >= 400) return { error: Object.assign(new Error(res.body.message), { status: res.status, body: res.body }) };
    return { payload: browser.syncrootResult(c, res.body), body: res.body };
  }
  const rootsNow = async () => q('SELECT id, path, note, enabled, backfill_done, sync_cursor FROM document_sync_roots ORDER BY id');

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    if (new URL(URL_).port === '3306') throw new Error('refusing to run against the production proxy port');
    pool = mysql.createPool({ uri: URL_, connectionLimit: 10, timezone: 'Z' });
    pool.on('connection', (conn) => conn.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    const conn = await pool.getConnection();
    try {
      await dropAll(conn);
      await conn.query('SET FOREIGN_KEY_CHECKS = 0');
      const { creates, alters } = schemaFor(TABLES);
      for (const sql of creates) await conn.query(sql);
      for (const sql of alters) await conn.query(sql);
      await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    } finally { conn.release(); }
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.db = pool; next(); });
    app.use(require('../routes/api.documents'));
    browser = browserChecks(async (p, body, method) => {
      const res = await call(app, method, p, method === 'GET' ? undefined : body);
      if (res.status >= 400) throw Object.assign(new Error(res.body.message || `HTTP ${res.status}`), { status: res.status, body: res.body });
      return res.body;
    });
  });

  afterAll(async () => {
    if (!pool) return;
    const conn = await pool.getConnection();
    try { await dropAll(conn); } finally { conn.release(); }
    await pool.end();
  });

  beforeEach(async () => {
    await seed();
    folders = new Set([ACTIVE, CLOSED, OLD, NEW].map(lower)); fileAt = new Set();
    dropbox.getMetadata.mockReset().mockImplementation(async (_db, { path: p }) => {
      if (fileAt.has(lower(p))) return { '.tag': 'file', id: 'id:F', name: p.split('/').pop(), path_lower: lower(p), path_display: p };
      if (!folders.has(lower(p))) throw notFound();
      return { '.tag': 'folder', id: `id:${lower(p)}`, path_lower: lower(p), path_display: p };
    });
    dropbox.listFolder.mockReset().mockImplementation(async (_db, { path: p }) => {
      if (!folders.has(lower(p))) throw notFound();
      return { entries: [{ '.tag': 'file', id: 'id:A11XOLD001', name: 'old.pdf', path_display: `${p}/old.pdf`, path_lower: lower(`${p}/old.pdf`), size: 10, server_modified: '2026-10-02T10:00:00Z' },
        { '.tag': 'file', id: 'id:A11XNEW001', name: 'new.pdf', path_display: `${p}/new.pdf`, path_lower: lower(`${p}/new.pdf`), size: 20, server_modified: '2026-10-03T10:00:00Z' }, { '.tag': 'folder', id: 'id:SUB', name: 'sub' }], count: 3, truncated: false };
    });
  });

  test('THE ADD: the card\'s hash is the browser\'s hash of the real GET; the real POST inserts the root (enabled, first walk pending, no cursor) and the receipt is the new row; the folder read was the dry run', async () => {
    const ev = await evidenceFor(NEW);
    expect(ev[0].rows[0]).toMatchObject({ row_type: 'folder', path: NEW, exists: '1', is_folder: '1', listed_files: '2', listed_folders: '1', registered_files: '1' });
    expect(ev[0].rows.filter((r) => r.row_type === 'entry').map((r) => [r.entry_id, r.registered_document_id])).toEqual([['id:A11XOLD001', '91'], ['id:A11XNEW001', null], ['id:SUB', null]]);
    expect(ev[1].rows.map((r) => [r.row_type, r.root_id, r.enabled, r.state])).toEqual([['engine', undefined, undefined, undefined], ['root', '1', '1', 'incremental'], ['root', '2', '1', 'backfilling'], ['root', '3', '0', 'disabled']]);
    const c = await card({ kind: 'document.sync_root.add.v1', path: NEW, note: 'closed 2019', evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 1 }] }, ev);
    expect(c).toMatchObject({ root: { path: NEW, note: 'closed 2019' }, folder: { exists: true, listed_files: 2, listed_folders: 1, registered_files: 1 }, roots_total: 3, sync_enabled: true });
    expect(c.warnings).toEqual([`BACKFILL: EVERY file beneath "${NEW}" is registered on the root's first walk — 2 files and 1 subfolder at the top level, and everything inside those subfolders — in backfill mode: bulk writes, NO rule emissions (no document.created fires for them), over as many ticks as it takes (days for a large tree). 1 file is registered under it already.`]);
    expect(c.expected.roots_hash).toBe(hashOf(await rootsNow()));
    const live = (await call(app, 'GET', '/api/documents/sync-roots')).body;
    expect(await browser.formDataHash(browser.syncrootSignature(live.roots))).toBe(c.expected.roots_hash);
    expect((await rootsNow()).length).toBe(3);
    const out = await apply(c);
    expect(out.refused).toBeUndefined();
    expect(out.error).toBeUndefined();
    const id = out.payload.root_id;
    expect(out.body).toMatchObject({ status: 'success', root: { id, path: NEW, note: 'closed 2019', enabled: true, backfill_done: false, has_cursor: false } });
    expect(out.body.warning).toBeUndefined();
    expect(c.__syncrootWarning).toBe('');
    expect((await rootsNow()).find((r) => r.id === id)).toEqual({ id, path: NEW, note: 'closed 2019', enabled: 1, backfill_done: 0, sync_cursor: null });
    // The same card again: the roots changed (the add itself), so the precheck refuses before the claim.
    const again = await apply(c);
    expect(again.refused).toBe('The sync roots changed since this card was prepared (one was added, enabled or disabled). Nothing was written. Ask Casey to prepare it again.');
    expect((await rootsNow()).length).toBe(4);
  });

  test('A FOLDER NOT IN DROPBOX YET: disclosed, never refused; the route creates the root with its warning, carried onto the card', async () => {
    const MISSING = '/  Law Office/   Cases/  Not Yet';
    const ev = await evidenceFor(MISSING);
    expect(ev[0].rows[0]).toMatchObject({ path: MISSING, exists: '0' });
    const c = await card({ kind: 'document.sync_root.add.v1', path: MISSING, evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 1 }] }, ev);
    expect(c.folder.exists).toBe(false);
    expect(c.warnings[1]).toMatch(/^NOT IN DROPBOX YET: /);
    const out = await apply(c);
    expect([out.body.status, out.body.warning, out.body.root.enabled]).toEqual(['success', 'folder does not exist yet — will sync when created', true]);
    expect(c.__syncrootWarning).toBe('folder does not exist yet — will sync when created');
  });

  test('THE ROUTE\'S 409s AND 400 ARE THE AUTHORITY — the duplicate (case-folded), inside, contains, a file: the normalizer refused first in the same words; nothing inserted', async () => {
    const cases = [
      [lower(ACTIVE), 'that path is already a sync root (root 1)', 409],
      [`${ACTIVE}/Smith`, `this path sits INSIDE root 1 ("${ACTIVE}"), which already walks it recursively — every file underneath would be synced twice`, 409],
      ['/  Law Office/   Cases', `this path CONTAINS root 1 ("${ACTIVE}") — every file under that root would be synced twice. Disable it first, or pick a narrower path`, 409],
    ];
    for (const [p, message, status] of cases) {
      folders.add(lower(p));
      const ev = await evidenceFor(p);
      await expect(card({ kind: 'document.sync_root.add.v1', path: p, evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 1 }] }, ev)).rejects.toThrow(message);
      const res = await call(app, 'POST', '/api/documents/sync-roots', { path: p });
      expect({ p, status: res.status, message: res.body.message }).toEqual({ p, status, message });
      expect(browser.syncrootKnownOutcome({ status: res.status, body: res.body })).toMatchObject({ status: 'Refused — nothing written' });
    }
    // The disabled nested root is a duplicate too — with the enable hint.
    const evOld = await evidenceFor(OLD);
    await expect(card({ kind: 'document.sync_root.add.v1', path: OLD, evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 1 }] }, evOld)).rejects.toThrow('that path is already a sync root (root 3) — it is disabled; a document.sync_root.enable.v1 card switches it back on');
    // A file.
    const FILE = `${CLOSED}/notes.txt`;
    fileAt.add(lower(FILE));
    const evFile = await evidenceFor(FILE);
    await expect(card({ kind: 'document.sync_root.add.v1', path: FILE, evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 1 }] }, evFile)).rejects.toThrow('this path sits INSIDE root 2');
    folders.add('/x'); fileAt.add('/x/a.pdf');
    const direct = await call(app, 'POST', '/api/documents/sync-roots', { path: '/x/a.pdf' });
    expect([direct.status, direct.body.message]).toEqual([400, 'that path is a file — a sync root must be a folder']);
    expect((await rootsNow()).length).toBe(3);
  });

  test('THE ENABLE / DISABLE: the real PATCH flips exactly enabled; the nested disabled root cannot be enabled (the route\'s 409, the normalizer first); a repoint is the route\'s 400; a state already reached refuses', async () => {
    const ev = await evidenceFor(NEW);
    // Disable root 2 (backfilling).
    const off = await card({ kind: 'document.sync_root.enable.v1', root_id: 2, enabled: false, evidence: [{ query_id: 'q2', row_number: rootRow(ev, 2) }] }, ev);
    expect([off.root.enabled, off.root.backfill_done, off.enabled, off.warnings]).toEqual([true, false, false, []]);
    const out = await apply(off);
    expect(out.payload).toEqual({ root_id: 2 });
    expect(out.body.root).toMatchObject({ id: 2, path: CLOSED, enabled: false, backfill_done: false });
    expect((await rootsNow()).map((r) => [r.id, r.enabled, r.sync_cursor])).toEqual([[1, 1, 'cursor-1'], [2, 0, null], [3, 0, 'cursor-3']]);
    // The same card again refuses at proposal (already disabled) and at the click (the hash moved).
    await expect(card({ kind: 'document.sync_root.enable.v1', root_id: 2, enabled: false, evidence: [{ query_id: 'q2', row_number: rootRow(ev, 2) }] }, ev)).rejects.toThrow(`Root #2 ("${CLOSED}") is already disabled — that changes nothing`);
    expect((await apply(off)).refused).toMatch(/^The sync roots changed since this card was prepared/);
    // Re-enable it from a fresh read: FIRST WALK PENDING.
    const ev2 = await evidenceFor(NEW);
    const on = await card({ kind: 'document.sync_root.enable.v1', root_id: 2, enabled: true, evidence: [{ query_id: 'q2', row_number: rootRow(ev2, 2) }] }, ev2);
    expect(on.warnings[0]).toMatch(/^FIRST WALK PENDING: root #2/);
    const back = await apply(on);
    expect(back.body.root).toMatchObject({ id: 2, enabled: true });
    // Root 3 sits inside root 1: the normalizer refuses, the route answers 409 in the same words.
    const ev3 = await evidenceFor(NEW);
    await expect(card({ kind: 'document.sync_root.enable.v1', root_id: 3, enabled: true, evidence: [{ query_id: 'q2', row_number: rootRow(ev3, 3) }] }, ev3)).rejects.toThrow(`cannot enable: this root sits inside root 1 ("${ACTIVE}") — every file underneath would be synced twice`);
    const res = await call(app, 'PATCH', '/api/documents/sync-roots/3', { enabled: true });
    expect([res.status, res.body.message]).toEqual([409, `cannot enable: this root sits inside root 1 ("${ACTIVE}") — every file underneath would be synced twice`]);
    expect(browser.syncrootKnownOutcome({ status: res.status, body: res.body })).toMatchObject({ status: 'Refused — nothing written' });
    // A repoint straight at the route: its 400; the normalizer refuses the key by name.
    const repoint = await call(app, 'PATCH', '/api/documents/sync-roots/1', { path: '/elsewhere' });
    expect([repoint.status, repoint.body.message]).toEqual([400, 'only "enabled" can be changed on a sync root (rejected: path). To change a path, disable this root and add the correct one.']);
    await expect(card({ kind: 'document.sync_root.enable.v1', root_id: 1, enabled: false, path: '/elsewhere', evidence: [{ query_id: 'q2', row_number: rootRow(ev3, 1) }] }, ev3)).rejects.toThrow(/^REPOINT refused \(path\): /);
    // A gone root: the route's 404, read as a refusal by the shared 4xx rule; the normalizer refuses first.
    expect((await call(app, 'PATCH', '/api/documents/sync-roots/99', { enabled: false })).status).toBe(404);
    expect((await rootsNow()).map((r) => [r.id, r.enabled])).toEqual([[1, 1], [2, 1], [3, 0]]);
  });
});
