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
 *   - A11.1X (2026-11-15): a TYPED PATH — the document.folder read's facts on
 *     real rows (registered files, owners, the enabled root), the normalizer's
 *     card for a folder no lane finds, the route applying it, and the ROUTE's
 *     own 400 (no enabled root) and 409 (another case's folder) as the
 *     authority; the DISMISS — the real route's {updated, case_ids, dismissed}
 *     through the browser's result check, the un-dismiss, `updated: 0` for a
 *     case with no cache row read as a refusal; the UNDO — the real audit
 *     entry read back from `log`, the card's counts equal to what applyRelink
 *     then does, the end state back to the old folder, the first entry no
 *     longer undoable (a newer exists), and the old folder gone from Dropbox.
 *     Dropbox listFolder joins the stub (the folder read lists one page).
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
  listFolder: jest.fn(),
}));
const domainEvents = require('../lib/domainEvents');
const dropbox = require('../services/dropboxService');
const sync = require('../services/documentSyncService');
const svc = require('../services/assistantService');
const { normalizeActionDraft, relinkCandidatesRead, documentFolderRead, compactRows } = svc;

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
// Production SESSION sql_mode (verified live 2026-09-25; CLAUDE.md "SQL mode is relaxed").
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['cases', 'contacts', 'case_relate', 'documents', 'document_links', 'case_folder_cache', 'entity_folders', 'document_sync_roots',
  'app_settings', 'log', 'trigger_rules', 'trigger_rule_actions', 'users'];

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
  const names = ['actionStringReceipt', 'caseFolderIsUndo', 'caseFolderIsTyped', 'caseFolderCaseLabel', 'caseFolderRequest', 'caseFolderPrecheck', 'caseFolderResult', 'caseFolderKnownOutcome',
    'caseFolderDismissRequest', 'caseFolderDismissPrecheck', 'caseFolderDismissResult', 'caseFolderDismissKnownOutcome'];
  const src = `${consts.join('\n')}\n${names.map((n) => fnSrc(html, n)).join('\n')}\nreturn { caseFolderRequest, caseFolderPrecheck, caseFolderResult, caseFolderKnownOutcome, caseFolderDismissRequest, caseFolderDismissPrecheck, caseFolderDismissResult, caseFolderDismissKnownOutcome };`;
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
  const T = '/law/closed/ closed files - 2019';                  // A11.1X: no lane finds it — a TYPED path
  const R4 = 'A111NOCF';                                         // A11.1X: a case with NO cache row
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
      (?, '24-99999', NULL, 'Bankruptcy', NULL, 'case', ?), (?, NULL, NULL, 'Bankruptcy', NULL, 'intake', ?),
      (?, NULL, NULL, 'Bankruptcy', NULL, 'intake', NULL)`,
    [R1, OLD_LINK, R2, linkFor(C), R3, linkFor(D), RN, linkFor(`${A}/joint - lee`), R4]);
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
      [161, `${T}/t1.pdf`], [162, `${T}/sub/t2.pdf`],
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
    app.use(require('../routes/api.dropbox')); // the browser's folder precheck (POST /api/dropbox/list) — listFolder is the stub
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
    dropbox.listFolder.mockReset().mockImplementation(async () => { throw new Error('listFolder is asked only for a typed or undo folder'); });
  });
  // A11.1X: Dropbox holds `paths` as folders (one file listed each); anything else is path/not_found.
  function dropboxHolds(...paths) {
    const notFound = () => Object.assign(new Error('dropbox: POST /2/files/get_metadata → 409: path/not_found/..'), { status: 409, errorSummary: 'path/not_found/..' });
    const has = (p) => paths.some((x) => String(p).toLowerCase() === x.toLowerCase());
    dropbox.getMetadata.mockImplementation(async (_db, { path: p }) => { if (!has(p)) throw notFound(); return { '.tag': 'folder', id: `id:${p}`, path_lower: String(p).toLowerCase(), path_display: String(p).replace(/\b\w/g, (c) => c.toUpperCase()) }; });
    dropbox.listFolder.mockImplementation(async (_db, { path: p }) => { if (!has(p)) throw notFound(); return { entries: [{ '.tag': 'file', name: 'listed.pdf', path_lower: `${String(p).toLowerCase()}/listed.pdf`, server_modified: '2026-10-02T10:00:00Z' }, { '.tag': 'folder', name: 'sub' }], count: 2, truncated: false }; });
  }
  // The log rows a model's sql.read of the audit trail returns (compacted like every evidence row).
  const auditRows = async (caseId) => compactRows(await q(
    "SELECT log_id, DATE_FORMAT(log_date, '%Y-%m-%d %H:%i:%s') AS log_date, log_by, log_subject FROM log WHERE log_link_type = 'case' AND log_link_id = ? AND log_subject = 'Case Dropbox folder re-linked' ORDER BY log_id DESC", [caseId]));

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

  // ═══════════════════════════════════════════════════════════════════════
  // A11.1X — the released extras
  // ═══════════════════════════════════════════════════════════════════════

  test('A11.1X TYPED PATH — the folder read\'s facts on real rows; the card for a folder no lane finds; the route applies it; the route\'s 400 and 409 are the authority', async () => {
    dropboxHolds(T, '/elsewhere/x');
    // The read: real registered count (t1 and sub/t2), the enabled root, no owner, Dropbox's listing.
    const read = await documentFolderRead(pool, T);
    // A11X: the head row, then one entry row per listed entry (the stub lists a file and a subfolder).
    expect(read.rows.map((r) => r.row_type)).toEqual(['folder', 'entry', 'entry']);
    expect(read.rows[0]).toMatchObject({ row_type: 'folder', path: T, path_lower: T, exists: 1, is_folder: 1, under_enabled_root: 1, root: ROOT, listed_files: 1, listed_folders: 1, listing_truncated: 0,
      newest_listed: '2026-10-02T10:00:00.000Z', registered_files: 2, registered_newest: '2026-10-01T10:00:00.000Z', already_linked_to: null, inside_case_id: null, nested_case_ids: null, held_by: null, proposable: 1 });
    expect(dropbox.getMetadata.mock.calls.map((c) => c[1])).toEqual([{ path: T }]);
    expect(dropbox.listFolder.mock.calls.map((c) => c[1])).toEqual([{ path: T, recursive: false, maxEntries: 500 }]);
    // T is NOT a candidate for R1 (its name holds neither the docket nor "smith dana").
    expect((await relinkCandidatesRead(pool, R1)).rows.some((r) => r.path === T)).toBe(false);
    const ev = [...await evidenceFor(R1), { id: 'q4', kind: 'document.folder', purpose: 'the typed folder', rows: compactRows(read.rows) }];
    const c = await normalizeActionDraft(pool, { kind: 'case.folder.relink.v1', case_id: R1, folder_path: T, evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q4', row_number: 1 }] }, ev, { currentUserId: 6 });
    expect(c.folder).toMatchObject({ path: T, confidence: 'typed', matched_on: null, files: 2, root: ROOT, listed_files: 1, listed_folders: 1 });
    expect(c.warnings[0]).toBe('NOT A CANDIDATE: neither the case number nor a client\'s name (Smith, Dana) is in this folder\'s name (" closed files - 2019") — the panel would never suggest it, and nothing but your word ties it to this case. Every file under it attaches to this case: be sure it is this client\'s folder.');
    expect(c.effects[0]).toMatch(/^Matched on: NOTHING — a typed path, not one of the panel's candidates\. A Dropbox read through the document sync's account proved it: it exists and is a folder \(shown as ".*"\), it sits under the sync root "\/law", and it holds 1 file directly \(newest 2026-10-02\) and 1 subfolder; 2 registered files are under it\.$/);
    expect(c.prediction).toEqual({ under_total: 2, held_total: 0, held_by: [], attach: 2, nested: 0, scanned: 2, truncated: false, detach: 2, human_kept: 1 });
    expect(c.expected).toEqual({ case_dropbox: OLD_LINK, current_path: OLD, path: T, files: 2, already_linked_to: null, typed: 1 });
    // The browser: the case re-read and the real /api/dropbox/list (the stub behind the real route) pass; the request is the typed pair.
    expect(await browser.caseFolderPrecheck(c)).toBe('');
    expect(dropbox.listFolder.mock.calls.at(-1)[1]).toMatchObject({ path: T, recursive: false, maxEntries: 1 });
    const rq = browser.caseFolderRequest(c);
    expect(rq).toEqual({ path: '/api/documents/relink', method: 'POST', body: { case_id: R1, folder_path: T } });
    const res = await call(app, rq.method, rq.path, rq.body);
    expect(res.status).toBe(200);
    expect([res.body.result.linked_docs, res.body.result.detached_docs, res.body.result.new_path]).toEqual([2, 2, T]);
    expect(browser.caseFolderResult(c, res.body)).toEqual({ case_id: R1 });
    expect(await r1Links()).toEqual([[142, 'path', 6], [161, 'path', null], [162, 'path', null]]);
    expect((await q('SELECT case_dropbox FROM cases WHERE case_id = ?', [R1]))[0].case_dropbox).toBe(linkFor(T));
    // Gone from Dropbox before the click: the browser refuses through the real route's 409.
    dropboxHolds();
    expect(await browser.caseFolderPrecheck({ ...c, expected: { ...c.expected, case_dropbox: linkFor(T), current_path: T } })).toMatch(/^The folder ".*" is no longer in Dropbox, or is not a folder any more \(dropbox: POST \/2\/files\/get_metadata → 409: path\/not_found\/\.\.\)\. Nothing was written\./);
    // A typed path under NO enabled root: the read says so, the normalizer refuses from the read's row AND from its own re-read, and the route itself answers 400.
    dropboxHolds(T, '/elsewhere/x');
    const away = await documentFolderRead(pool, '/elsewhere/x');
    expect(away.rows[0]).toMatchObject({ exists: 1, is_folder: 1, under_enabled_root: 0, root: null, proposable: 0 });
    const evAway = [...await evidenceFor(R1), { id: 'q4', kind: 'document.folder', purpose: 'f', rows: compactRows(away.rows) }];
    await expect(normalizeActionDraft(pool, { kind: 'case.folder.relink.v1', case_id: R1, folder_path: '/elsewhere/x', evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q4', row_number: 1 }] }, evAway, { currentUserId: 6 }))
      .rejects.toThrow('"/elsewhere/x" is under NO enabled sync root');
    const r400 = await call(app, 'POST', '/api/documents/relink', { case_id: R1, folder_path: '/elsewhere/x' });
    expect([r400.status, r400.body.message]).toEqual([400, 'that folder is not under any enabled sync root, so its documents would never be registered — add a root for it first, or pick a folder inside one']);
    // A typed path another case holds: the read names the owner; the normalizer refuses; the route 409s.
    dropboxHolds(C);
    const held = await documentFolderRead(pool, C);
    expect(held.rows[0]).toMatchObject({ already_linked_to: R2, proposable: 0 });
    expect(held.rows[0].note).toMatch(new RegExp(`^ANOTHER CASE'S FOLDER \\(case ${R2}\\)`));
    const evHeld = [...await evidenceFor(R1), { id: 'q4', kind: 'document.folder', purpose: 'f', rows: compactRows(held.rows) }];
    // C IS a candidate row of R1 (name lane, held by R2), so the candidate path answers first: the 409 wording, naming R2.
    await expect(normalizeActionDraft(pool, { kind: 'case.folder.relink.v1', case_id: R1, folder_path: C, evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q4', row_number: 1 }] }, evHeld, { currentUserId: 6 }))
      .rejects.toThrow(/^(ANOTHER CASE HOLDS THIS FOLDER|Cite the candidate row)/);
    expect((await call(app, 'POST', '/api/documents/relink', { case_id: R1, folder_path: C })).status).toBe(409);
  });

  test('A11.1X DISMISS — the un-dismiss and the dismiss through the real route and the browser\'s result check; a case with no cache row is refused and the route\'s updated: 0 reads as a refusal', async () => {
    const ev = (caseId) => [{ id: 'q1', kind: 'sql.read', purpose: 'case', rows: compactRows([{ case_id: caseId }]) }];
    const dismissCard = (caseId, undo) => normalizeActionDraft(pool, { kind: 'case.folder.dismiss.v1', case_id: caseId, ...(undo ? { undo: true } : {}), evidence: [{ query_id: 'q1', row_number: 1 }] }, ev(caseId), { currentUserId: 6 });
    // R1 is dismissed (seeded 2026-09-01 by 6) and has attributed documents (o1-o3): not in the queue.
    await expect(dismissCard(R1, false)).rejects.toThrow('Case 25-12345 is already dismissed from the relink queue (2026-09-01, by user 6) — nothing to do; a card with undo:true returns it to the queue');
    const un = await dismissCard(R1, true);
    expect(un).toMatchObject({ kind: 'case.folder.dismiss.v1', undo: true, cache: { path: OLD, path_display: '/Law/Potential/Smith, Dana', dismissed_at: '2026-09-01T10:00:00.000Z', dismissed_by: 6 }, queue: { in_queue: false, has_links: true, candidates: 4, proposable: 2 } });
    expect(un.effects.slice(0, 3)).toEqual(['Cached folder: "/Law/Potential/Smith, Dana" (resolved ' + String(un.cache.resolved_at).slice(0, 10) + ').', 'Dismissal now: dismissed on 2026-09-01 by user 6.',
      'Relink queue now: NOT in the queue (the case already has documents attributed) — the dismissal stamp is only a note on the cache row.']);
    expect(un.expected).toEqual({ dismissed_at: '2026-09-01T10:00:00.000Z', current_path: OLD, case_dropbox: OLD_LINK });
    expect(await browser.caseFolderDismissPrecheck(un)).toBe('');
    const rq = browser.caseFolderDismissRequest(un);
    expect(rq).toEqual({ path: '/api/documents/relink/dismiss', method: 'POST', body: { case_id: R1, undo: true } });
    const res = await call(app, rq.method, rq.path, rq.body);
    expect([res.status, res.body]).toEqual([200, { status: 'success', updated: 1, case_ids: [R1], dismissed: false }]);
    expect(browser.caseFolderDismissResult(un, res.body)).toEqual({ case_id: R1 });
    expect(await q('SELECT relink_dismissed_at, relink_dismissed_by FROM case_folder_cache WHERE case_id = ?', [R1])).toEqual([{ relink_dismissed_at: null, relink_dismissed_by: null }]);
    // Nothing else moved: no link, no case column, no log entry, no event.
    expect(await r1Links()).toEqual([[141, 'path', null], [142, 'path', 6], [143, 'path', null]]);
    expect((await q('SELECT case_dropbox FROM cases WHERE case_id = ?', [R1]))[0].case_dropbox).toBe(OLD_LINK);
    expect([(await q('SELECT COUNT(*) AS n FROM log'))[0].n, domainEvents.emit.mock.calls.length]).toEqual([0, 0]);
    // The stale card's re-read refuses now (someone un-dismissed it); the state already equal refuses at proposal.
    expect(await browser.caseFolderDismissPrecheck(un)).toBe('The relink-queue dismissal of case 25-12345 changed since this card was prepared (someone un-dismissed it). Nothing was written. Ask Casey to prepare it again.');
    await expect(dismissCard(R1, true)).rejects.toThrow('Case 25-12345 is not dismissed from the relink queue — there is no dismissal to undo');
    // R2 (cache row C, one attributed document, no contacts: no candidates): the dismiss, stamped by the signed-in user.
    const d2 = await dismissCard(R2, false);
    expect(d2.queue).toEqual({ in_queue: false, has_links: true, candidates: 0, proposable: 0 });
    expect(d2.warnings).toEqual([]);
    expect(d2.effects).toContain('Candidates: the panel\'s lanes find no folder for this case — the usual reason to dismiss (the client never sent a document).');
    expect(await browser.caseFolderDismissPrecheck(d2)).toBe('');
    const r2 = await call(app, 'POST', '/api/documents/relink/dismiss', browser.caseFolderDismissRequest(d2).body);
    expect(r2.body).toEqual({ status: 'success', updated: 1, case_ids: [R2], dismissed: true });
    expect(browser.caseFolderDismissResult(d2, r2.body)).toEqual({ case_id: R2 });
    const [row] = await q('SELECT relink_dismissed_at, relink_dismissed_by FROM case_folder_cache WHERE case_id = ?', [R2]);
    expect([row.relink_dismissed_at instanceof Date, row.relink_dismissed_by]).toEqual([true, 6]);
    // RN sits in the QUEUE (a resolved folder, no attributed document) and has candidates? none (no contacts, no docket): the queue line says shown.
    const dn = await dismissCard(RN, false);
    expect(dn.queue).toEqual({ in_queue: true, has_links: false, candidates: 0, proposable: 0 });
    expect(dn.effects[2]).toBe('Relink queue now: IN the queue (a cached folder and no document attributed to the case) — shown.');
    // R4 has no cache row: the normalizer refuses; the route stamps nothing (updated 0), which the browser reads as a refusal.
    await expect(dismissCard(R4, false)).rejects.toThrow(`Case ${R4} has no folder-cache row — it has never been in the relink queue (the queue is the cache's rows), and the dismiss route would stamp nothing. There is nothing to dismiss`);
    const r4 = await call(app, 'POST', '/api/documents/relink/dismiss', { case_id: R4 });
    expect(r4.body).toEqual({ status: 'success', updated: 0, case_ids: [R4], dismissed: true });
    let thrown = null;
    try { browser.caseFolderDismissResult({ case: { case_id: R4 }, undo: false }, r4.body); } catch (e) { thrown = e; }
    expect(browser.caseFolderDismissKnownOutcome(thrown)).toEqual({ status: 'Refused — nothing written', text: 'Refused — nothing written: the case has no folder-cache row any more (its cached folder was removed since the card was prepared), so there was nothing to stamp.' });
    // The route's bulk form stays the PANEL's: the normalizer refuses case_ids by name before any read.
    await expect(normalizeActionDraft(pool, { kind: 'case.folder.dismiss.v1', case_id: R1, case_ids: [R1, R2], evidence: [{ query_id: 'q1', row_number: 1 }] }, ev(R1), { currentUserId: 6 })).rejects.toThrow(/^BULK refused \(case_ids\): one card per case/);
  });

  test('A11.1X UNDO — the real audit entry, the card\'s counts equal to what applyRelink then does, the end state back to the old folder, the first entry no longer undoable, the old folder gone', async () => {
    dropboxHolds(OLD, A);
    // The re-link the COUNTS test proves (R1: OLD → A), through the route.
    const first = await call(app, 'POST', '/api/documents/relink', { case_id: R1, folder_path: A });
    expect(first.status).toBe(200);
    expect(await r1Links()).toEqual([[101, 'path', null], [103, 'path', null], [105, 'path', null], [142, 'path', 6]]);
    const rows = await auditRows(R1);
    expect(rows).toHaveLength(1);
    const logId = Number(rows[0].log_id);
    const ev = [...await evidenceFor(R1), { id: 'q3', kind: 'sql.read', purpose: 'the relink audit entries', rows }];
    const undoCard = (id) => normalizeActionDraft(pool, { kind: 'case.folder.relink.undo.v1', case_id: R1, log_id: id, evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q3', row_number: 1 }] }, ev, { currentUserId: 6 });
    const c = await undoCard(logId);
    expect(c.audit).toEqual({ log_id: logId, at_text: rows[0].log_date.slice(0, 16), by: 'user 6', old_path: OLD, old_link: OLD_LINK, new_path: A, new_link: linkFor(A), linked_docs: 3, detached_docs: 2 });
    // OLD is a name-lane candidate of R1 today (its segment holds "smith, dana").
    expect(c.folder).toMatchObject({ path: OLD, confidence: 'name', matched_on: 'Smith, Dana', files: 3, root: ROOT });
    expect(c.effects[3]).toBe('Matched on: the name lane — every required word of the client name "Smith, Dana" (surname and first given name) appears in the folder\'s name (the old folder is one of the panel\'s candidates today).');
    // o2 carries a PERSON's relation-path link (held, stays); o1 / o3 attach; p1, p3, p5 (the re-link's own attachments) detach; o2 is the kept human link.
    expect(c.prediction).toEqual({ under_total: 3, held_total: 1, held_by: [{ case_id: R1, n: 1 }], attach: 2, nested: 0, scanned: 2, truncated: false, detach: 3, human_kept: 1 });
    expect(c.warnings).toEqual(['DETACHES 3 DOCUMENTS: 3 of this case\'s links the sync made to files OUTSIDE the old folder — the files the re-link being undone attached, among them — are deleted, and those files leave the case\'s Documents tab. Only machine links go — 1 link a person made (or with another relation) stays.']);
    expect(c.expected).toEqual({ case_dropbox: linkFor(A), current_path: A, path: OLD, files: 3, already_linked_to: null, log_id: logId, typed: 1 });
    expect([c.automation.rules_checked, c.automation.lines]).toEqual([2, ['Trigger rule #1 "Folder fixed" runs: starts workflow #77 ("Folder flow")']]);
    // The browser: the case re-read and the real /api/dropbox/list pass; the request is the SAME route with the old folder.
    expect(await browser.caseFolderPrecheck(c)).toBe('');
    const rq = browser.caseFolderRequest(c);
    expect(rq).toEqual({ path: '/api/documents/relink', method: 'POST', body: { case_id: R1, folder_path: OLD } });
    const res = await call(app, rq.method, rq.path, rq.body);
    expect(res.status).toBe(200);
    expect([res.body.result.linked_docs, res.body.result.detached_docs, res.body.result.old_path, res.body.result.new_path]).toEqual([c.prediction.attach, c.prediction.detach, A, OLD]);
    expect(browser.caseFolderResult(c, res.body)).toEqual({ case_id: R1 });
    // End state: back on the old folder, o1 / o3 re-attached by the sync, o2 kept, the re-link's attachments gone; p2 stays R2's.
    expect(await r1Links()).toEqual([[141, 'path', null], [142, 'path', 6], [143, 'path', null]]);
    expect((await q('SELECT case_dropbox FROM cases WHERE case_id = ?', [R1]))[0].case_dropbox).toBe(linkFor(OLD));
    expect(await q('SELECT path_lower FROM case_folder_cache WHERE case_id = ?', [R1])).toEqual([{ path_lower: OLD }]);
    // Two entries now; the second records the undo as a re-link A → OLD; the first is no longer the latest.
    const rows2 = await auditRows(R1);
    expect(rows2).toHaveLength(2);
    const [{ log_extra }] = await q('SELECT log_extra FROM log WHERE log_id = ?', [Number(rows2[0].log_id)]);
    const extra = typeof log_extra === 'string' ? JSON.parse(log_extra) : log_extra;
    expect([extra.relink.old_path, extra.relink.new_path, extra.relink.old_link, extra.relink.new_link]).toEqual([A, OLD, linkFor(A), linkFor(OLD)]);
    await expect(undoCard(logId)).rejects.toThrow(new RegExp(`^A NEWER RE-LINK EXISTS for case 25-12345: entry #${Number(rows2[0].log_id)} \\(${rows2[0].log_date.slice(0, 16)} firm time\\) is the latest\\. Only the latest re-link can be undone`));
    // The stale card's re-read refuses (the case moved on).
    expect(await browser.caseFolderPrecheck(c)).toMatch(/^The Dropbox folder of case 25-12345 changed since this card was prepared/);
    // The second entry IS undoable (back to A) — until its old folder is gone from Dropbox.
    const ev2 = [...await evidenceFor(R1), { id: 'q3', kind: 'sql.read', purpose: 'audit', rows: rows2 }];
    const undo2 = (over = {}) => normalizeActionDraft(pool, { kind: 'case.folder.relink.undo.v1', case_id: R1, log_id: Number(rows2[0].log_id), evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q3', row_number: 1 }], ...over }, ev2, { currentUserId: 6 });
    const back = await undo2();
    expect(back.folder).toMatchObject({ path: A, confidence: 'docket' });
    dropboxHolds(OLD);
    await expect(undo2()).rejects.toThrow(`THE OLD FOLDER IS GONE: "${A}" no longer exists in Dropbox (moved, renamed or deleted since ${rows2[0].log_date.slice(0, 16)})`);
    // Citing an entry of ANOTHER case, or a non-relink entry, is refused; so is a link that moved on.
    await expect(undo2({ log_id: 999999 })).rejects.toThrow(/^Cite the audit entry/);
    await q("UPDATE cases SET case_dropbox = 'https://www.dropbox.com/scl/fo/moved-by-hand' WHERE case_id = ?", [R1]);
    dropboxHolds(OLD, A);
    await expect(undo2()).rejects.toThrow(`Case 25-12345's Dropbox link is no longer the one entry #${Number(rows2[0].log_id)} wrote — someone changed it since`);
  });
});
