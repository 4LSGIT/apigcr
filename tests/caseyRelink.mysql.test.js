// tests/caseyRelink.mysql.test.js
//
/**
 * A11.1 on REAL MySQL: the Documents relink panel's own read and confirm that
 * every refusal and disclosure of the Casey case folder card rests on —
 * routes/api.documents.js GET /api/documents/relink/:caseId/candidates and
 * POST /api/documents/relink, real handler, real documentSyncService
 * (relinkCandidates, _loadFolderOwners, applyRelink end to end), real
 * documentService (reconcileCaseFolderLinks, bulkLink), real caseService
 * (updateCase), real logService, real pool, under the production sql_mode —
 * plus the normalizer's own reads, predictions and dry run, and the browser's
 * click-time re-read, answer check and outcome mapping (extracted from
 * public/assistant.html) over the REAL GET / POST payloads.
 *
 * ── THE ONE STUB: THE DROPBOX PROVIDER ──────────────────────────────────────
 * applyRelink's Dropbox round trip (mint the folder's shared link, resolve it
 * back to a path) cannot run here, so services/dropboxService is replaced at
 * exactly that boundary: getOrCreateSharedLink, getSharedLinkMetadata and
 * getMetadata are stubs; normalizePath and isPathNotFoundError stay REAL
 * (requireActual). documentSyncService itself is NEVER mocked — the guard,
 * the retract and the attach under test are the real ones.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/yc_a111_test npx jest tests/caseyRelink.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates its
 * tables in it, cloned from ref/database.sql (live types and keys; a clause
 * referencing a table outside the list is dropped). Drops run with
 * FOREIGN_KEY_CHECKS off in the before-hook AND the after-hook and take any
 * sibling-built child of ours with them (the caseyPipeline.mysql hygiene).
 *
 * WHAT IS LOCKED
 *   - THE CONJUNCTIVE NAME LANE: a surname-only folder is NOT a candidate (it
 *     is one only with includeWeak, which the card never passes); the docket
 *     lane and the full-name lane are, in the panel's own order.
 *   - THE FILE COUNTS: a candidate's `files` is every registered file under
 *     it, nested case folders included; the card's attach / detach
 *     prediction is exactly what applyRelink then does (engine parity: a file
 *     already holding a sync link stays, a nested case folder keeps its
 *     files; only the case's machine links outside the folder are detached —
 *     a person's link, even with relation 'path', stays).
 *   - ALREADY_LINKED_TO comes from a second case's cache row, and the 409
 *     guard's predicate is _loadFolderOwners' PATH EQUALITY: that folder
 *     answers 409 and writes nothing; a folder merely INSIDE another case's
 *     folder is not refused (it is disclosed).
 *   - THE DISMISSED STAMPS surface on the read and the confirm clears them.
 *   - THE SKIP: with the sync switched off the route answers `skipped` and
 *     writes nothing; the normalizer refuses first; the browser reads a skip
 *     as a refusal.
 *   - The dry run reads the real active case.updated rules; the service emits
 *     the envelope the card dry-ran (save the minted link's value).
 *   - The browser's precheck passes on a fresh card and refuses once the case
 *     moved; its answer check accepts the real answer; the answer's key set is
 *     the one tests/ycSync.test.js pins the bus matcher with.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const mysql = require('mysql2/promise');

// Not under test: the auth gate (pinned in tests/caseyActionPermissions.test.js),
// the event queue (observed, not run; buildEnvelope / buildChanges stay REAL),
// and the Dropbox provider's network calls (see the header).
jest.mock('../lib/auth.jwtOrApiKey', () => (req, _res, next) => { req.auth = { type: 'jwt', userId: 6 }; next(); });
jest.mock('../lib/domainEvents', () => ({ ...jest.requireActual('../lib/domainEvents'), emit: jest.fn() }));
jest.mock('../services/dropboxService', () => ({
  ...jest.requireActual('../services/dropboxService'),
  getOrCreateSharedLink: jest.fn(),
  getSharedLinkMetadata: jest.fn(),
  getMetadata: jest.fn(),
}));
const domainEvents = require('../lib/domainEvents');
const dropbox = require('../services/dropboxService');
const sync = require('../services/documentSyncService');
const svc = require('../services/assistantService');
const { normalizeActionDraft, relinkCandidatesRead, compactRows } = svc;

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
// Production SESSION sql_mode (verified live 2026-09-25; CLAUDE.md "SQL mode is relaxed").
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['cases', 'contacts', 'case_relate', 'documents', 'document_links', 'case_folder_cache', 'document_sync_roots',
  'app_settings', 'log', 'trigger_rules', 'trigger_rule_actions'];

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
      const payload = body === undefined ? '' : JSON.stringify(body);
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

// The browser's checks, extracted verbatim from the page (the assistantUi
// fnSrc idiom, inlined) and run against an `api` that calls the real routes.
function fnSrc(html, name) {
  const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(html);
  if (!m) throw new Error(`${name} not found`);
  let depth = 0;
  for (let i = html.indexOf('{', m.index + m[0].length); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(m.index - (html.slice(0, m.index).endsWith('async ') ? 6 : 0), i + 1);
  }
  throw new Error(`${name} unbalanced`);
}
function browserChecks(api) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'assistant.html'), 'utf8');
  const consts = ['CASE_FOLDER_PATH_MAX', 'CASE_FOLDER_CONTROL'].map((n) => {
    const m = new RegExp(`const ${n} = [^\\n]*;`).exec(html);
    if (!m) throw new Error(`${n} not found`);
    return m[0];
  });
  const names = ['actionStringReceipt', 'caseFolderCaseLabel', 'caseFolderRequest', 'caseFolderPrecheck', 'caseFolderResult', 'caseFolderKnownOutcome'];
  const src = `${consts.join('\n')}\n${names.map((n) => fnSrc(html, n)).join('\n')}\nreturn { caseFolderRequest, caseFolderPrecheck, caseFolderResult, caseFolderKnownOutcome };`;
  return new Function('api', src)(api); // eslint-disable-line no-new-func
}

d('the Casey case folder card on real MySQL (A11.1)', () => {
  let pool; let app; let browser;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const R1 = 'A111CAS1'; const R2 = 'A111CAS2'; const R3 = 'A111CAS3'; const RN = 'A111NEST';
  const ROOT = '/law';
  const A = '/law/active/ 7 - smith, dana - 25-12345';          // docket + name lane; holds RN's folder
  const B = '/law/active/ smith, vinyanda';                      // surname only — never a candidate
  const C = '/law/active/ 7 - smith, dana - old';                // name lane; R2's cached folder
  const D = '/law/active/ 13 - jones, amy';                      // R3's cached folder
  const DS = `${D}/smith, dana docs`;                            // name lane; INSIDE R3's folder
  const OLD = '/law/potential/smith, dana';                      // R1's current folder
  const OLD_LINK = 'https://www.dropbox.com/scl/fo/old-r1';
  const linkFor = (p) => `https://www.dropbox.com/scl/fo/${encodeURIComponent(p)}`;

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
    await q(`INSERT INTO app_settings (\`key\`, value) VALUES ('documents_sync_enabled', '1')`);
    await q('INSERT INTO document_sync_roots (id, path, enabled) VALUES (1, ?, 1)', [ROOT]);
    await q(`INSERT INTO cases (case_id, case_number, case_number_full, case_type, case_stage, pipeline_phase, case_dropbox) VALUES
      (?, '25-12345', NULL, 'Bankruptcy', 'Filed', 'case', ?), (?, NULL, NULL, 'Bankruptcy', NULL, 'intake', ?),
      (?, '24-99999', NULL, 'Bankruptcy', NULL, 'case', ?), (?, NULL, NULL, 'Bankruptcy', NULL, 'intake', ?)`,
    [R1, OLD_LINK, R2, linkFor(C), R3, linkFor(D), RN, linkFor(`${A}/joint - lee`)]);
    await q(`INSERT INTO contacts (contact_id, contact_kind, contact_name, contact_fname, contact_lname) VALUES
      (8001, 'person', 'Dana Smith', 'Dana', 'Smith'), (8002, 'person', 'Amy Jones', 'Amy', 'Jones')`);
    // contact_lfm_name is the m3 trigger's in production; set it the way it stores it.
    await q("UPDATE contacts SET contact_lfm_name = 'Smith, Dana' WHERE contact_id = 8001");
    await q("UPDATE contacts SET contact_lfm_name = 'Jones, Amy' WHERE contact_id = 8002");
    await q(`INSERT INTO case_relate (case_relate_id, case_relate_case_id, case_relate_client_id, case_relate_type) VALUES
      (961, ?, 8001, 'Primary'), (962, ?, 8002, 'Primary')`, [R1, R3]);
    await q(`INSERT INTO case_folder_cache (case_id, folder_external_id, path_lower, path_display, relink_dismissed_at, relink_dismissed_by) VALUES
      (?, 'id:old', ?, '/Law/Potential/Smith, Dana', '2026-09-01 10:00:00', 6), (?, 'id:c', ?, NULL, NULL, NULL),
      (?, 'id:d', ?, NULL, NULL, NULL), (?, 'id:n', ?, NULL, NULL, NULL)`, [R1, OLD, R2, C, R3, D, RN, `${A}/joint - lee`]);
    const docs = [
      [101, `${A}/p1.pdf`], [102, `${A}/p2.pdf`], [103, `${A}/sub/p3.pdf`], [104, `${A}/joint - lee/x.pdf`], [105, `${A}/p5.pdf`],
      [111, `${B}/b1.pdf`], [112, `${B}/b2.pdf`],
      [121, `${C}/c1.pdf`],
      [131, `${D}/j1.pdf`], [132, `${DS}/s1.pdf`],
      [141, `${OLD}/o1.pdf`], [142, `${OLD}/o2.pdf`], [143, `${OLD}/o3.pdf`],
      [151, `${A}/gone.pdf`],
    ];
    for (const [id, p] of docs) {
      await q(`INSERT INTO documents (id, external_id, name, path, path_lower, status, server_modified) VALUES (?, ?, ?, ?, ?, ?, '2026-10-01 10:00:00')`,
        [id, `id:${id}`, p.split('/').pop(), p, p, id === 151 ? 'deleted' : 'active']);
    }
    // R1's links: o1 / o3 the sync's (relation path, no creator) — detached by
    // a re-link elsewhere; o2 a PERSON's link with relation 'path' — kept.
    // p2 already carries R2's sync link (it stays there); p5 carries a PERSON's
    // link to R3 with another relation — not a sync link, so p5 still attaches.
    await q(`INSERT INTO document_links (document_id, link_type, link_id, relation, created_by) VALUES
      (141, 'case', ?, 'path', NULL), (143, 'case', ?, 'path', NULL), (142, 'case', ?, 'path', 6),
      (102, 'case', ?, 'path', NULL), (121, 'case', ?, 'path', NULL), (131, 'case', ?, 'path', NULL),
      (105, 'case', ?, 'upload', 6)`, [R1, R1, R1, R2, R2, R3, R3]);
    await q(`INSERT INTO trigger_rules (id, event_type, name, active, position, match_mode, match_config) VALUES
      (1, 'case.updated', 'Folder fixed', 1, 1, 'conditions', '{"operator":"and","conditions":[{"path":"source","op":"equals","value":"documents_relink"}]}'),
      (2, 'case.updated', 'Hand edits only', 1, 2, 'conditions', '{"operator":"and","conditions":[{"path":"source","op":"equals","value":"manual"}]}'),
      (3, 'case.updated', 'Switched off', 0, 3, 'conditions', '{"operator":"and","conditions":[]}')`);
    await q(`INSERT INTO trigger_rule_actions (rule_id, name, position, active, action_type, config) VALUES
      (1, 'Folder flow', 1, 1, 'workflow', '{"workflow_id":77}'), (2, NULL, 1, 1, 'workflow', '{"workflow_id":78}'), (3, NULL, 1, 1, 'workflow', '{"workflow_id":9}')`);
    sync._clearInventoryCache();
  }

  // Evidence as the investigation holds it: compacted rows (every value a string).
  async function evidenceFor(caseId) {
    const read = await relinkCandidatesRead(pool, caseId);
    return [{ id: 'q1', kind: 'sql.read', purpose: 'case', rows: compactRows([{ case_id: caseId, case_number: '25-12345' }]) },
      { id: 'q2', kind: 'document.relink.candidates', purpose: 'folders', rows: compactRows(read.rows) }];
  }
  async function card(caseId, folder) {
    const ev = await evidenceFor(caseId);
    const n = ev[1].rows.findIndex((r) => r.path === folder) + 1;
    return normalizeActionDraft(pool, { kind: 'case.folder.relink.v1', case_id: caseId, folder_path: folder,
      evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: n || 1 }] }, ev, { currentUserId: 6 });
  }
  const r1Links = async () => (await q(`SELECT dl.document_id, dl.relation, dl.created_by FROM document_links dl
     WHERE dl.link_type = 'case' AND dl.link_id = ? ORDER BY dl.document_id`, [R1])).map((r) => [Number(r.document_id), r.relation, r.created_by]);

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
    // The page's api(path, body, method): a non-2xx throws with .status / .body (apiSend's contract).
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
    dropbox.getOrCreateSharedLink.mockReset().mockImplementation(async (_db, { path: p }) => linkFor(p));
    dropbox.getSharedLinkMetadata.mockReset().mockImplementation(async (_db, { url }) => {
      const p = decodeURIComponent(String(url).replace('https://www.dropbox.com/scl/fo/', ''));
      return { '.tag': 'folder', id: `id:${p}`, path_lower: p, path_display: p };
    });
    dropbox.getMetadata.mockReset().mockImplementation(async () => { throw new Error('getMetadata must not be called for a folder with registered files'); });
  });

  test('THE CONJUNCTIVE NAME LANE — a surname-only folder is not a candidate; the docket and full-name lanes are, in the panel\'s order, with counts, owners, nesting and the dismissal', async () => {
    const read = await relinkCandidatesRead(pool, R1);
    expect(read.rows[0]).toMatchObject({ row_type: 'case', case_id: R1, case_number: '25-12345', client_names: 'Smith, Dana',
      current_path: OLD, current_link: OLD_LINK, dismissed_at: '2026-09-01T10:00:00.000Z', candidates: 4, candidates_truncated: 0 });
    expect(read.rows.slice(1).map((r) => [r.path, r.files, r.confidence, r.already_linked_to, r.inside_case_id, r.nested_case_ids, r.is_current, r.proposable])).toEqual([
      [A, 5, 'docket', null, null, RN, 0, 1],        // 5 = p1, p2, sub/p3, p5 and the nested case's x (the deleted one is not counted)
      [OLD, 3, 'name', null, null, null, 1, 0],
      [DS, 1, 'name', null, R3, null, 0, 1],
      [C, 1, 'name', R2, null, null, 0, 0],
    ]);
    expect(read.rows.some((r) => r.path === B)).toBe(false);
    // B IS a match — on the surname alone, the lane only includeWeak opens (the panel's toggle; never the card's).
    const weak = await sync.relinkCandidates(pool, R1, { includeWeak: true });
    expect(weak.candidates.filter((c) => c.path === B).map((c) => c.confidence)).toEqual(['weak']);
    // The GET route the click re-reads answers the same list.
    const got = await call(app, 'GET', `/api/documents/relink/${R1}/candidates`);
    expect([got.status, got.body.current_link, got.body.current_path, got.body.candidates.map((c) => [c.path, c.files, c.already_linked_to])]).toEqual([200, OLD_LINK, OLD,
      [[A, 5, null], [OLD, 3, null], [DS, 1, null], [C, 1, [R2]]]]);
    // The normalizer refuses the surname-only folder (not listed), R2's folder, the current folder.
    await expect(normalizeActionDraft(pool, { kind: 'case.folder.relink.v1', case_id: R1, folder_path: B, evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 2 }] },
      await evidenceFor(R1), { currentUserId: 6 })).rejects.toThrow(/^NOT A CANDIDATE/);
    await expect(card(R1, C)).rejects.toThrow(`ANOTHER CASE HOLDS THIS FOLDER: "${C}" is already case ${R2}'s folder`);
    await expect(card(R1, OLD)).rejects.toThrow(`That changes nothing — case 25-12345 already points at "${OLD}"`);
  });

  test('THE COUNTS — the card\'s attach / detach prediction is exactly what applyRelink does; the end state, the cleared dismissal, the audit entry and the emitted envelope', async () => {
    const c = await card(R1, A);
    expect(c.prediction).toEqual({ under_total: 5, held_total: 1, held_by: [{ case_id: R2, n: 1 }], attach: 3, nested: 1, scanned: 4, truncated: false, detach: 2, human_kept: 1 });
    expect(c.effects[3]).toBe(`Attaches NOW: 3 registered files of the 5 under this folder get the sync's link to this case and show on its Documents tab at once — silently: no document.linked event fires for them. 1 file already carries the sync's link to a case and stays as it is (1 file on case ${R2}). 1 file sits inside another case's folder nested here and stays with that case.`);
    expect(c.warnings).toEqual(['DETACHES 2 DOCUMENTS: 2 of this case\'s links the sync made to files OUTSIDE the new folder are deleted, and those files leave the case\'s Documents tab. Only machine links go — 1 link a person made (or with another relation) stays.']);
    expect(c.effects).toContain(`Nested case folders: ${RN} has its own folder inside this one; its files stay on that case (a file belongs to the innermost case folder).`);
    expect(c.effects).toContain('Relink queue: this case was dismissed from the relink queue (2026-09-01); applying clears the dismissal.');
    expect([c.automation.rules_checked, c.automation.lines]).toEqual([2, ['Trigger rule #1 "Folder fixed" runs: starts workflow #77 ("Folder flow")']]);
    expect(c.expected).toEqual({ case_dropbox: OLD_LINK, current_path: OLD, path: A, files: 5, already_linked_to: null });
    expect(await r1Links()).toEqual([[141, 'path', null], [142, 'path', 6], [143, 'path', null]]);

    // The browser's re-read passes on the fresh card; the request is exactly the reviewed pair.
    expect(await browser.caseFolderPrecheck(c)).toBe('');
    const rq = browser.caseFolderRequest(c);
    expect(rq).toEqual({ path: '/api/documents/relink', method: 'POST', body: { case_id: R1, folder_path: A } });
    const res = await call(app, rq.method, rq.path, rq.body);
    expect(res.status).toBe(200);
    // The answer's key set is the one tests/ycSync.test.js pins the matcher with.
    expect(Object.keys(res.body.result).sort()).toEqual(['cache', 'case_id', 'detached_docs', 'elapsed_ms', 'linked_docs', 'new_path', 'old_path',
      'requested_path', 'scanned_docs', 'shared_link', 'warnings'].sort());
    expect([res.body.result.linked_docs, res.body.result.detached_docs, res.body.result.scanned_docs]).toEqual([c.prediction.attach, c.prediction.detach, c.prediction.scanned]);
    expect(res.body.result).toMatchObject({ case_id: R1, old_path: OLD, new_path: A, shared_link: linkFor(A) });
    expect(browser.caseFolderResult(c, res.body)).toEqual({ case_id: R1 });
    // End state: o1 / o3 detached, the person's o2 link kept, p1, p3 and p5 attached; p2 stays R2's, x stays RN's.
    expect(await r1Links()).toEqual([[101, 'path', null], [103, 'path', null], [105, 'path', null], [142, 'path', 6]]);
    expect((await q("SELECT document_id, link_id FROM document_links WHERE document_id IN (102, 104) AND link_type = 'case' ORDER BY document_id"))
      .map((r) => [Number(r.document_id), r.link_id])).toEqual([[102, R2]]);
    expect((await q('SELECT case_dropbox FROM cases WHERE case_id = ?', [R1]))[0].case_dropbox).toBe(linkFor(A));
    expect(await q('SELECT path_lower, relink_dismissed_at, relink_dismissed_by FROM case_folder_cache WHERE case_id = ?', [R1]))
      .toEqual([{ path_lower: A, relink_dismissed_at: null, relink_dismissed_by: null }]);
    const [log] = await q("SELECT log_type, log_link_type, log_link_id, log_by, log_extra FROM log WHERE log_link_id = ?", [R1]);
    const extra = typeof log.log_extra === 'string' ? JSON.parse(log.log_extra) : log.log_extra;
    expect([log.log_type, log.log_link_type, log.log_by, extra.relink.old_path, extra.relink.old_link, extra.relink.new_path, extra.relink.detached_docs, extra.relink.linked_docs])
      .toEqual(['update', 'case', 6, OLD, OLD_LINK, A, 2, 3]);
    // The service emitted the envelope the card dry-ran (the link value aside: the card read a stand-in).
    const [[, type, payload]] = domainEvents.emit.mock.calls;
    expect([type, payload.source, payload.actor, payload.changes, payload.extra]).toEqual(['case.updated', 'documents_relink', { user_id: 6 },
      { case_dropbox: { from: OLD_LINK, to: linkFor(A) } }, { updated_fields: ['case_dropbox'] }]);
    // The stale card's re-read refuses now, and a second card for the same folder is a no-op.
    expect(await browser.caseFolderPrecheck(c)).toMatch(/^The Dropbox folder of case 25-12345 changed since this card was prepared/);
    await expect(card(R1, A)).rejects.toThrow('That changes nothing');
  });

  test('THE 409 GUARD is path EQUALITY on another case\'s cache row: that folder answers 409 and writes nothing; a folder merely inside another case\'s folder is not refused, it is disclosed', async () => {
    const { owners } = await sync._loadFolderOwners(pool);
    expect([owners.get(C) && [...owners.get(C)], owners.has(DS), owners.get(D) && [...owners.get(D)]]).toEqual([[R2], false, [R3]]);
    const res = await call(app, 'POST', '/api/documents/relink', { case_id: R1, folder_path: C });
    expect([res.status, res.body.message]).toEqual([409, `that folder is already linked to case ${R2} — linking it here as well would put both clients' documents on both cases`]);
    expect([(await q('SELECT case_dropbox FROM cases WHERE case_id = ?', [R1]))[0].case_dropbox, await r1Links(), domainEvents.emit.mock.calls.length,
      dropbox.getOrCreateSharedLink.mock.calls.length]).toEqual([OLD_LINK, [[141, 'path', null], [142, 'path', 6], [143, 'path', null]], 0, 0]);
    // The browser reads the real 409 as a refusal written before any write.
    expect(browser.caseFolderKnownOutcome(Object.assign(new Error(res.body.message), { status: 409, body: res.body })))
      .toEqual({ status: 'Refused — nothing written', text: `Refused — nothing written: ${res.body.message}. Another case claimed this folder after the card was prepared.` });
    // Inside R3's folder: proposable, with the danger disclosure.
    const inside = await card(R1, DS);
    expect(inside.warnings).toContain(`INSIDE ANOTHER CASE'S FOLDER: this folder sits inside case ${R3}'s folder. Its files that already carry that case's sync link stay there and do not attach here (counted above); files added later attach to THIS case. Joint debtors can make this right — make sure it is.`);
    expect(inside.prediction).toMatchObject({ under_total: 1, attach: 1, detach: 2, human_kept: 1 });
  });

  test('THE SKIP — with the sync off the route answers skipped and writes nothing; the normalizer refuses first; the browser reads it as a refusal', async () => {
    const c = await card(R1, A);
    await q("UPDATE app_settings SET value = '0' WHERE `key` = 'documents_sync_enabled'");
    await expect(card(R1, A)).rejects.toThrow(/^THE DOCUMENT SYNC IS SWITCHED OFF/);
    const res = await call(app, 'POST', '/api/documents/relink', browser.caseFolderRequest(c).body);
    expect([res.status, res.body]).toEqual([200, { status: 'success', result: { skipped: true, reason: 'documents_sync_enabled is not "1"' } }]);
    expect([(await q('SELECT case_dropbox FROM cases WHERE case_id = ?', [R1]))[0].case_dropbox, (await r1Links()).length, domainEvents.emit.mock.calls.length]).toEqual([OLD_LINK, 3, 0]);
    let thrown = null;
    try { browser.caseFolderResult(c, res.body); } catch (e) { thrown = e; }
    expect(browser.caseFolderKnownOutcome(thrown)).toEqual({ status: 'Refused — nothing written',
      text: 'Refused — nothing written: the Dropbox document sync is switched off (documents_sync_enabled), so the relink route did nothing and the case still points at its old folder. Ask IT before turning the sync back on.' });
  });

  test('a case with NO folder and no link (outside the panel\'s queue) gets candidates; its card says so; a gone case 404s on the click\'s re-read', async () => {
    await q("UPDATE cases SET case_dropbox = NULL WHERE case_id = ?", [R1]);
    await q('DELETE FROM case_folder_cache WHERE case_id = ?', [R1]);
    await q("DELETE FROM document_links WHERE link_id = ?", [R1]);
    sync._clearInventoryCache();
    const c = await card(R1, A);
    expect(c.effects[1]).toBe('Now points at: no folder.');
    expect(c.effects[2]).toMatch(/is REWRITTEN — from blank — to the folder's permanent Dropbox shared link/);
    expect(c.expected).toEqual({ case_dropbox: null, current_path: null, path: A, files: 5, already_linked_to: null });
    expect(await browser.caseFolderPrecheck(c)).toBe('');
    await q('DELETE FROM cases WHERE case_id = ?', [R1]);
    expect(await browser.caseFolderPrecheck(c)).toBe('Case 25-12345 no longer exists. Nothing was written.');
  });
});
