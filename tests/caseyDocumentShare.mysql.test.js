// tests/caseyDocumentShare.mysql.test.js
//
/**
 * A11.2 on REAL MySQL: the share and unlink cards' own SQL (the row, its
 * links, whether a link is stored, the related sets, the folder match), the
 * native routes they drive — routes/api.documents.js, real handlers, real
 * documentService, real pool, under the production sql_mode — and the
 * browser's click-time re-read, request builders, answer checks and outcome
 * mapping (extracted from public/assistant.html) over the REAL answers.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/yc_a112_test npx jest tests/caseyDocumentShare.mysql.test.js --runInBand
 * The database name must end in _test and the port must not be 3306 (the
 * production proxy). This suite DROPS and recreates its tables, cloned from
 * ref/database.sql, with FOREIGN_KEY_CHECKS off in the before-hook AND the
 * after-hook, taking any sibling-built child of ours with it (the
 * caseyDocuments.mysql hygiene).
 *
 * THE DROPBOX PROVIDER IS STUBBED AT ITS BOUNDARY: dropboxService's
 * getOrCreateSharedLink is a jest.fn modelling Dropbox's get-or-create (one
 * link per file id, returned again on a repeat; a file it does not have
 * answers the 409 `_mkError` shape list_shared_links throws). The provider
 * delegate (documentSourceService) and everything above it are real. Nothing
 * here reaches Dropbox.
 *
 * WHAT IS LOCKED
 *   - THE SHARE caches Dropbox's link on the row and answers it; a second share
 *     asks Dropbox again (the route always does), gets the same link back and
 *     stores it unchanged — the card's "nothing new"; a link Dropbox no longer
 *     has is replaced, and the applied copy says so. The server-built card
 *     never carries the link.
 *   - THE ROUTE IGNORES STATUS: a deleted document reaches Dropbox, whose 409
 *     the browser reads as a refusal (nothing stored); the normalizer refuses
 *     first. An unknown id is the route's 404.
 *   - THE UNLINK removes exactly one row; the remaining links are exactly the
 *     card's; the related view (documentService.list related — what the
 *     Documents tabs read) drops the document from exactly the tabs the card
 *     said it leaves and keeps it on the ones it said stay. A repeat is the
 *     route's 404 "Link not found" (a refusal); the DELETE matches link_id
 *     case-folded (general_ci), as the normalizer folds.
 *   - COMES BACK: after unlinking the sync's own case link of a file in that
 *     case's folder, the REAL sweep (documentSyncService.attributeUnlinked)
 *     re-adds it — and does not for a file outside the folder, where the card
 *     carries no warning.
 *   - The prechecks pass on fresh cards and refuse after hand edits.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const mysql = require('mysql2/promise');

// Not under test: the auth gate (pinned in tests/caseyActionPermissions.test.js),
// the event queue (observed, not run), and the Dropbox provider's network
// calls (see the header).
jest.mock('../lib/auth.jwtOrApiKey', () => (req, _res, next) => { req.auth = { type: 'jwt', userId: 6 }; next(); });
jest.mock('../lib/domainEvents', () => ({ ...jest.requireActual('../lib/domainEvents'), emit: jest.fn() }));
jest.mock('../services/dropboxService', () => ({
  ...jest.requireActual('../services/dropboxService'),
  getOrCreateSharedLink: jest.fn(),
}));
const domainEvents = require('../lib/domainEvents');
const dropbox = require('../services/dropboxService');
const documentService = require('../services/documentService');
const sync = require('../services/documentSyncService');
const { normalizeActionDraft } = require('../services/assistantService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
// Production SESSION sql_mode (verified live 2026-09-25; CLAUDE.md "SQL mode is relaxed").
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['cases', 'contacts', 'case_relate', 'documents', 'document_links', 'case_folder_cache', 'app_settings'];

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

// The browser's half, extracted verbatim from the page and run against an
// `api` that calls the real routes.
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
  const max = /const DOCSHARE_LINK_MAX = \d+;/.exec(html);
  if (!max) throw new Error('DOCSHARE_LINK_MAX not found');
  const names = ['documentName', 'documentId', 'documentLinkSignature', 'documentRead', 'docshareRequest', 'docunlinkBody', 'docunlinkRequest',
    'docsharePrecheck', 'docunlinkPrecheck', 'docshareResult', 'docunlinkResult', 'docshareKnownOutcome', 'docunlinkKnownOutcome', 'docshareAppliedWarning'];
  const src = `${max[0]}\n${names.map((n) => fnSrc(html, n)).join('\n')}\nreturn { ${names.join(', ')} };`;
  return new Function('api', src)(api); // eslint-disable-line no-new-func
}

d('the Casey document share / unlink cards on real MySQL (A11.2)', () => {
  let pool; let app; let browser;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const C1 = 'A112CAS1'; const C2 = 'A112CAS2';
  // Dropbox, modelled: one link per file id; get-or-create.
  let dbxLinks; let dbxMissing;

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
    await q(`INSERT INTO cases (case_id, case_number, case_type, case_subtype) VALUES
      (?, '25-70001', 'Bankruptcy', 'Chapter 7'), (?, '25-70002', 'Bankruptcy', 'Chapter 13')`, [C1, C2]);
    await q(`INSERT INTO contacts (contact_id, contact_kind, contact_name, contact_fname, contact_lname) VALUES
      (7001, 'person', 'Dana Debtor', 'Dana', 'Debtor'), (7002, 'person', 'Sam Spouse', 'Sam', 'Spouse'), (7003, 'person', 'Other Client', 'Other', 'Client')`);
    // Dana and Sam are on C1; Other is on C2.
    await q(`INSERT INTO case_relate (case_relate_id, case_relate_case_id, case_relate_client_id, case_relate_type) VALUES
      (911, ?, 7001, 'Primary'), (912, ?, 7002, 'Secondary'), (913, ?, 7003, 'Primary')`, [C1, C1, C2]);
    await q(`INSERT INTO documents (id, source, external_id, name, path, path_lower, ext, size, title, status, updated_at) VALUES
      (81, 'dropbox', 'id:A112AAA', 'Petition.pdf', '/Active/Debtor, Dana/Petition.pdf', '/active/debtor, dana/petition.pdf', 'pdf', 1258291, 'Petition', 'active', '2026-10-30 12:00:00'),
      (82, 'dropbox', 'id:A112BBB', 'Old.pdf', '/Active/Debtor, Dana/Old.pdf', '/active/debtor, dana/old.pdf', 'pdf', 10, NULL, 'deleted', '2026-10-30 12:00:00'),
      (83, 'dropbox', 'id:A112CCC', 'Paystub.jpg', '/Unsorted/Paystub.jpg', '/unsorted/paystub.jpg', 'jpg', 5, NULL, 'active', '2026-10-30 12:00:00')`);
    // 81: the sync's own C1 link (it sits in C1's folder), a person's link to Dana, and one to Other.
    await q(`INSERT INTO document_links (id, document_id, link_type, link_id, relation, created_by) VALUES
      (601, 81, 'case', ?, 'path', NULL), (602, 81, 'contact', '7001', 'upload', 6), (603, 81, 'contact', '7003', NULL, 6),
      (604, 83, 'case', ?, NULL, 6)`, [C1, C2]);
    await q(`INSERT INTO case_folder_cache (case_id, path_lower) VALUES (?, '/active/debtor, dana'), (?, '/active/other, client')`, [C1, C2]);
    await q("INSERT INTO app_settings (`key`, `value`) VALUES ('documents_sync_enabled', '1')");
  }
  const ev = [
    { id: 'q1', rows: [{ document_id: 81 }, { document_id: 82 }, { document_id: 83 }, { document_id: 89 }] },
    { id: 'q2', rows: [{ case_id: C1 }, { case_id: C2 }] },
    { id: 'q3', rows: [{ contact_id: 7001 }, { contact_id: 7003 }] },
  ];
  const card = (value, evidence = ev) => normalizeActionDraft(pool, value, evidence, { currentUserId: 6 });
  const share = (doc, row) => card({ kind: 'document.share.v1', document_id: doc, evidence: [{ query_id: 'q1', row_number: row }] });
  const linkIds = async (id) => (await q('SELECT id FROM document_links WHERE document_id = ? ORDER BY id', [id])).map((r) => Number(r.id));
  const shown = async (type, id) => (await documentService.list(pool, { link_type: type, link_id: id, related: 1 })).documents.map((x) => Number(x.id));
  // The browser's whole write path for one card: re-read, request, the real route, the answer check.
  async function apply(c, family) {
    const why = await browser[`${family}Precheck`](c);
    if (why) return { refused: why };
    const rq = browser[`${family}Request`](c);
    const res = await call(app, rq.method, rq.path, rq.body);
    if (res.status >= 400) return { error: Object.assign(new Error(res.body.message), { status: res.status, body: res.body }) };
    return { payload: browser[`${family}Result`](c, res.body), body: res.body };
  }

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
    // The page's api(path, body, method): a non-2xx throws with .status (apiSend's contract).
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
    domainEvents.emit.mockClear();
    dbxLinks = new Map(); dbxMissing = new Set(['id:A112BBB']);
    dropbox.getOrCreateSharedLink.mockReset();
    dropbox.getOrCreateSharedLink.mockImplementation(async (_db, { path: extId }) => {
      if (dbxMissing.has(extId)) {
        const e = new Error(`dropbox: POST /2/sharing/list_shared_links → 409: {"error_summary":"path/not_found/.."}`);
        e.status = 409; e.errorSummary = 'path/not_found/..';
        throw e;
      }
      if (!dbxLinks.has(extId)) dbxLinks.set(extId, `https://www.dropbox.com/scl/fi/${extId.slice(3).toLowerCase()}/f?rlkey=K${dbxLinks.size}&dl=0`);
      return dbxLinks.get(extId);
    });
  });

  test('THE SHARE caches Dropbox\'s link on the row; a second share returns the same link and stores it unchanged; the card never carries it', async () => {
    const c = await share(81, 1);
    expect([c.shared, c.expected]).toEqual([false, { status: 'active', shared: false, name: 'Petition.pdf', title: 'Petition', doc_type: null,
      links: ['601:case:A112CAS1:path', '602:contact:7001:upload', '603:contact:7003:'] }]);
    expect(c.warnings.map((w) => w.split(':')[0])).toEqual(['PUBLIC LINK', 'NEW LINK']);
    const out = await apply(c, 'docshare');
    const link = dbxLinks.get('id:A112AAA');
    expect(out.payload).toEqual({ document_id: 81 });
    expect(out.body).toEqual({ status: 'success', shared_link: link });
    expect(c.__docshareLink).toBe(link);
    expect(JSON.stringify(c)).not.toContain('dropbox.com');
    expect(dropbox.getOrCreateSharedLink.mock.calls.map(([, o]) => o.path)).toEqual(['id:A112AAA']);
    const [[row]] = await pool.query('SELECT shared_link FROM documents WHERE id = 81');
    expect(row.shared_link).toBe(link);
    // No event: setSharedLink emits nothing.
    expect(domainEvents.emit).not.toHaveBeenCalled();
    // The first card's re-read now refuses — it was shared since.
    expect(await browser.docsharePrecheck(c)).toMatch(/^The document "Petition" was shared since this card was prepared/);
    // A second card: already shared, the link absent from it; Dropbox asked again, the same link back, stored unchanged.
    const again = await share(81, 1);
    expect([again.shared, again.effects[0].startsWith('Already shared:'), again.warnings.map((w) => w.split(':')[0])]).toEqual([true, true, ['PUBLIC LINK']]);
    expect(JSON.stringify(again)).not.toContain('dropbox.com');
    const second = await apply(again, 'docshare');
    expect(second.body.shared_link).toBe(link);
    expect(dropbox.getOrCreateSharedLink).toHaveBeenCalledTimes(2);
    expect((await q('SELECT shared_link FROM documents WHERE id = 81'))[0].shared_link).toBe(link);
    expect(browser.docshareAppliedWarning(again)).toContain('This is the link that was already stored — nothing new was made.');
  });

  test('a link Dropbox no longer has is replaced by a NEW one, and the applied copy says so', async () => {
    await q("UPDATE documents SET shared_link = 'https://www.dropbox.com/scl/fi/dead/f?rlkey=OLD&dl=0' WHERE id = 81");
    const c = await share(81, 1);
    expect(c.shared).toBe(true);
    const out = await apply(c, 'docshare');
    const fresh = dbxLinks.get('id:A112AAA');
    expect(out.body.shared_link).toBe(fresh);
    expect((await q('SELECT shared_link FROM documents WHERE id = 81'))[0].shared_link).toBe(fresh);
    expect(browser.docshareAppliedWarning(c)).toContain('Dropbox returned a NEW link: the one stored before no longer worked, and this one replaces it.');
  });

  test('THE ROUTE IGNORES STATUS — a deleted document reaches Dropbox, whose 409 is read as a refusal; an unknown id is the route\'s 404; the normalizer refuses both first', async () => {
    const res = await call(app, 'POST', '/api/documents/82/share');
    expect(res.status).toBe(409);
    expect(dropbox.getOrCreateSharedLink).toHaveBeenCalledTimes(1);
    expect((await q('SELECT shared_link FROM documents WHERE id = 82'))[0].shared_link).toBe(null);
    const known = browser.docshareKnownOutcome(Object.assign(new Error(res.body.message), { status: res.status, body: res.body }));
    expect(known).toEqual({ status: 'Refused — nothing shared', text: expect.stringMatching(/^Refused — nothing shared: Dropbox refused to share the file \(dropbox: POST \/2\/sharing\/list_shared_links → 409:/) });
    await expect(share(82, 2)).rejects.toThrow('Document #82 ("Old.pdf") is deleted — Casey shares active documents only');
    const missing = await call(app, 'POST', '/api/documents/89/share');
    expect([missing.status, missing.body.message]).toEqual([404, 'Document not found']);
    expect(browser.docshareKnownOutcome(Object.assign(new Error(missing.body.message), { status: 404 }))).toMatchObject({ status: 'Refused — nothing shared' });
    await expect(share(89, 4)).rejects.toThrow('Document #89 no longer exists');
  });

  test('THE UNLINK removes exactly one row; the remaining links are the card\'s; the related view drops it from exactly the tabs the card names', async () => {
    const c = await card({ kind: 'document.unlink.v1', document_id: 81, link_type: 'contact', link_id: 7003,
      evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q3', row_number: 2 }] });
    expect(c.visibility).toEqual([
      'Other Client (contact #7003)\'s Documents tab — it leaves it (listed there directly today).',
      'Under "Include related" (on by default) it also leaves the Documents tab of each case this contact is on — case 25-70002 (Primary on the case) — where it shows badged "via Other Client (contact #7003)" today.',
      'Stays on: the Documents tab of each record it is still linked to (listed), and the Documents page.']);
    expect([c.links_total, c.links_after, c.warnings]).toEqual([3, 2, []]);
    // Before: 81 shows on Other and on C2 (via Other).
    const has81 = async (type, id) => (await shown(type, id)).includes(81);
    expect([await has81('contact', '7003'), await has81('case', C2)]).toEqual([true, true]);
    const out = await apply(c, 'docunlink');
    expect(out.payload).toEqual({ document_link_id: 603 });
    expect(out.body).toEqual({ status: 'success', removed: true, link_type: 'contact', link_id: '7003' });
    expect(await linkIds(81)).toEqual(c.links_before.map((l) => l.document_link_id).filter((id) => id !== 603).sort((a, b) => a - b));
    expect(await linkIds(83)).toEqual([604]);
    // After: gone from exactly the tabs named; still on the rest.
    expect([await has81('contact', '7003'), await has81('case', C2)]).toEqual([false, false]);
    expect([await has81('case', C1), await has81('contact', '7001'), await has81('contact', '7002')]).toEqual([true, true, true]);
    // The other document (83, on C2) is untouched on those tabs.
    expect([await shown('contact', '7003'), await shown('case', C2)]).toEqual([[83], [83]]);
    expect(domainEvents.emit).not.toHaveBeenCalled();
    // A repeat: the card's re-read refuses; the route's own answer is 404 "Link not found", read as a refusal; the normalizer refuses too.
    expect(await browser.docunlinkPrecheck(c)).toMatch(/is no longer linked to Other Client \(contact #7003\) — someone unlinked it since/);
    const rq = browser.docunlinkRequest(c);
    const dup = await call(app, rq.method, rq.path, rq.body);
    expect([dup.status, dup.body.message]).toEqual([404, 'Link not found']);
    expect(browser.docunlinkKnownOutcome(Object.assign(new Error(dup.body.message), { status: 404 }))).toMatchObject({ status: 'Refused — nothing written' });
    await expect(card({ kind: 'document.unlink.v1', document_id: 81, link_type: 'contact', link_id: 7003,
      evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q3', row_number: 2 }] })).rejects.toThrow('is not linked to contact 7003 — there is nothing to unlink');
  });

  test('a link kept through another link: the card says "still shown", and the related view agrees', async () => {
    const c = await card({ kind: 'document.unlink.v1', document_id: 81, link_type: 'contact', link_id: 7001,
      evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q3', row_number: 1 }] });
    expect(c.visibility[0]).toBe('Dana Debtor (contact #7001)\'s Documents tab — no longer listed there directly, but still shown under "Include related" (on by default) through another of the document\'s links.');
    expect(c.visibility[1]).toBe('Still shown, through another of its links, on the Documents tab of: case 25-70001 (Primary on the case).');
    await apply(c, 'docunlink');
    expect([await shown('contact', '7001'), await shown('case', C1)]).toEqual([[81], [81]]);
  });

  test('THE DELETE matches link_id case-folded (general_ci), as the normalizer folds — the stored spelling is what the card sends', async () => {
    await q('UPDATE document_links SET link_id = ? WHERE id = 604', [C2.toLowerCase()]);
    const c = await card({ kind: 'document.unlink.v1', document_id: 83, link_type: 'case', link_id: C2,
      evidence: [{ query_id: 'q1', row_number: 3 }, { query_id: 'q2', row_number: 2 }] });
    expect(browser.docunlinkRequest(c).body).toEqual({ link_type: 'case', link_id: C2.toLowerCase() });
    expect(c.warnings).toEqual(['LINKED TO NOTHING: this is the document\'s only link — afterwards it belongs to no case or contact and shows only on the Documents page.']);
    // The route itself folds too: the canonical spelling removes the lower-case row.
    const res = await call(app, 'DELETE', '/api/documents/83/links', { link_type: 'case', link_id: C2 });
    expect([res.status, res.body.removed]).toEqual([200, true]);
    expect(await linkIds(83)).toEqual([]);
  });

  test('COMES BACK — unlink the sync\'s own case link of a file in that case\'s folder, and the REAL sweep re-adds it; a file outside carries no warning and stays off', async () => {
    const c = await card({ kind: 'document.unlink.v1', document_id: 81, link_type: 'case', link_id: C1,
      evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 1 }] });
    expect(c.link).toEqual({ document_link_id: 601, link_type: 'case', link_id: C1, relation: 'path', made_by_sync: true });
    expect(c.warnings).toEqual([expect.stringMatching(/^COMES BACK: the file still sits in case 25-70001's Dropbox folder, so the Dropbox sync re-adds this case link on a later pass of its background sweep \(silently\) and whenever/)]);
    expect(c.effects[0]).toBe('Triage: it has no other case link, so it goes back on the Documents page\'s "Unlinked" list (documents with no case).');
    await apply(c, 'docunlink');
    const unlinked = async () => (await documentService.list(pool, { unlinked: 'case' })).documents.map((x) => Number(x.id));
    expect(await unlinked()).toEqual([81]);
    const swept = await sync.attributeUnlinked(pool, { watermark: false });
    expect(swept.linked).toBe(1);
    expect(await q("SELECT link_type, link_id, relation, created_by FROM document_links WHERE document_id = 81 AND link_type = 'case'")).toEqual([
      { link_type: 'case', link_id: C1, relation: 'path', created_by: null }]);
    expect(await unlinked()).toEqual([]);
    // A file outside every case folder: no warning, and the sweep leaves it unlinked.
    const out = await card({ kind: 'document.unlink.v1', document_id: 83, link_type: 'case', link_id: C2,
      evidence: [{ query_id: 'q1', row_number: 3 }, { query_id: 'q2', row_number: 2 }] });
    expect(out.warnings.some((w) => w.startsWith('COMES BACK'))).toBe(false);
    await apply(out, 'docunlink');
    await sync.attributeUnlinked(pool, { watermark: false });
    expect(await linkIds(83)).toEqual([]);
  });

  test('the sync switched off: the warning says nothing re-adds it until it is on', async () => {
    await q("UPDATE app_settings SET `value` = '0' WHERE `key` = 'documents_sync_enabled'");
    const c = await card({ kind: 'document.unlink.v1', document_id: 81, link_type: 'case', link_id: C1,
      evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 1 }] });
    expect(c.warnings[0]).toContain('— the sync is switched off right now, so nothing re-adds it until it is switched back on.');
  });

  test('the prechecks refuse after hand edits', async () => {
    const s = await share(81, 1);
    expect(await browser.docsharePrecheck(s)).toBe('');
    await q("UPDATE documents SET title = 'Petition (filed)' WHERE id = 81");
    expect(await browser.docsharePrecheck(s)).toMatch(/changed since this card was prepared \(its file name, title or type\)/);
    const u = await card({ kind: 'document.unlink.v1', document_id: 81, link_type: 'contact', link_id: 7001,
      evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q3', row_number: 1 }] });
    expect(await browser.docunlinkPrecheck(u)).toBe('');
    await q("INSERT INTO document_links (document_id, link_type, link_id, created_by) VALUES (81, 'contact', '7002', 6)");
    expect(await browser.docunlinkPrecheck(u)).toMatch(/^The links of "Petition \(filed\)"|^The links of "Petition"/);
    await q('DELETE FROM document_links WHERE id = 602');
    expect(await browser.docunlinkPrecheck(u)).toMatch(/is no longer linked to Dana Debtor \(contact #7001\)/);
    // A deleted document: the unlink is allowed (the Links dialog offers it) and the status is in `expected`.
    await q("INSERT INTO document_links (id, document_id, link_type, link_id, created_by) VALUES (605, 82, 'contact', '7001', 6)");
    const del = await card({ kind: 'document.unlink.v1', document_id: 82, link_type: 'contact', link_id: 7001,
      evidence: [{ query_id: 'q1', row_number: 2 }, { query_id: 'q3', row_number: 1 }] });
    expect(del.expected).toEqual({ status: 'deleted', links: ['605:contact:7001:'] });
    expect(await browser.docunlinkPrecheck(del)).toBe('');
    await q("UPDATE documents SET status = 'active' WHERE id = 82");
    expect(await browser.docunlinkPrecheck(del)).toMatch(/^The document "Old\.pdf" is active now \(it was deleted when this card was prepared\)/);
  });
});
